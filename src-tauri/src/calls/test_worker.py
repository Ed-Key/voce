"""Offline boundary and recovery checks. Does not record or load models."""
import importlib.util
import io
import json
import subprocess
import os
from pathlib import Path
import tempfile
import unittest
import shutil
import sys
from types import SimpleNamespace
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("worker", Path(__file__).with_name("worker.py"))
w = importlib.util.module_from_spec(spec)
spec.loader.exec_module(w)
# Pipeline versions carry whether echo cleaning ran, so cleaned and raw results never share a checkpoint.
AEC = '-aec2' if w.echo_cleaning_available() else '-aec0'


class LocalFeedTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.output=Path(self.temp.name);self.root=self.output/'feed';self.root.mkdir(mode=0o700)
        helper=Path(w.__file__).parents[2]/'resources/assistie/bridge.py'
        shutil.copyfile(helper,self.root/'bridge.py')
        spec=importlib.util.spec_from_file_location('local_test_bridge',helper)
        self.bridge=importlib.util.module_from_spec(spec);spec.loader.exec_module(self.bridge)
        self.binding={'call_id':'saved-call','recording_key':'a'*64}
        self.run=self.bridge.dispatch(self.root,'create_local',self.binding)['run_id']
        self.target={'root':str(self.root),'run_id':self.run}

    def state(self):return self.bridge.read(self.root/self.run/'state.json')

    def test_growing_windows_use_flushed_prefix_and_follow_mic_gaps(self):
        import numpy as np
        from scipy.io import wavfile
        source=self.output/'growing';source.mkdir();rate=16000
        def audio(name,seconds):wavfile.write(source/name,rate,np.zeros(rate*seconds,dtype=np.float32))
        audio('system.wav',0);audio('mic-0.wav',0)
        stats=lambda n:{'samples':n*rate,'sample_rate':rate}
        session={'id':'saved-call','started_at':'fictional','active':True,'mic_yielded':False,'notes':'','title':'','system':stats(0),'mic_segments':[{'file':'mic-0.wav','offset_ms':0,'stats':stats(0)}]}
        def save():w.atomic_json(source/'session.json',session)
        save();steps=[0]
        def advance(_):
            steps[0]+=1
            if steps[0]==1:
                audio('system.wav',9);audio('mic-0.wav',4)
                session.update(system=stats(11),mic_yielded=True);session['mic_segments'][0]['stats']=stats(4)
            elif steps[0]==2:
                audio('system.wav',16);audio('mic-1.wav',6)
                session.update(system=stats(16),mic_yielded=False);session['mic_segments'].append({'file':'mic-1.wav','offset_ms':10000,'stats':stats(6)})
            else:session['active']=False
            save()
        job={'session':dict(session)}
        with patch.object(w.time,'sleep',advance):
            windows=list(w.growing_tasks(source,job,{}))
        self.assertEqual(len(windows),5)
        self.assertEqual([(name,start,len(pcm)) for _,name,_,_,start,_,pcm in windows if name.startswith('mic')],[('mic-0.wav',0,4*rate),('mic-1.wav',0,6*rate)])
        self.assertEqual(max(a for a,*_ in windows),16000)
        self.assertFalse(job['session']['active'])
        with self.assertRaises(ValueError):list(w.growing_tasks(source,{'session':{**session,'started_at':'different'}},{}))

    def summarize_with_notes(self, notes):
        """The real summarize() against a fake local model; returns what the final request carried."""
        entries=[{'id':i,'source':'mic','start_ms':i*1000,'end_ms':i*1000+900,'text':f'We agreed to ship the fictional report on day {i}.'} for i in range(40)]
        seen=[]
        def request(_path,method,route,body=None,timeout=None):
            if method=='GET':return 200,{}
            schema=body['response_format']['json_schema']['schema']
            if 'notes' in schema['properties']:reply={'notes':['We agreed to ship the fictional report.']}
            else:
                seen.append(body['messages'][1]['content'])
                reply={'overview':'A call about the fictional report.','decisions':['Ship the fictional report.'],'action_items':[],'open_questions':[]}
            return 200,{'choices':[{'finish_reason':'stop','message':{'content':json.dumps(reply)}}]}
        job={'notes':notes,'runtime':{'summary_runtime':'fake','summary_model':'fake'},'temporary':self.temp.name}
        fake=SimpleNamespace(poll=lambda:None,terminate=lambda:None,wait=lambda timeout=None:0)
        with patch.object(w.subprocess,'Popen',return_value=fake),patch.object(w,'request',request):
            self.summary=w.summarize(self.output,job,{'entries':entries},lambda *a:None)
        self.assertEqual(self.summary['decisions'][0]['text'],'Ship the fictional report.')
        self.assertEqual(self.summary['overview'][0]['text'],'A call about the fictional report.')
        return seen

    def test_a_summary_is_written_sentences_linked_to_what_was_said(self):
        self.summarize_with_notes('')
        self.assertTrue(self.summary['decisions'][0]['sources'],'shares words with the transcript')

    def test_a_section_the_model_could_not_read_does_not_lose_the_call(self):
        calls=[]
        def request(_path,method,route,body=None,timeout=None):
            if method=='GET':return 200,{}
            calls.append(1)
            if len(calls)==1:return 200,{'choices':[{'finish_reason':'length','message':{'content':''}}]}
            schema=body['response_format']['json_schema']['schema']
            reply={'notes':['A note.']} if 'notes' in schema['properties'] else {'overview':'Fine.','decisions':[],'action_items':[],'open_questions':[]}
            return 200,{'choices':[{'finish_reason':'stop','message':{'content':json.dumps(reply)}}]}
        entries=[{'id':i,'source':'mic','start_ms':i,'end_ms':i,'text':'x y z '*600} for i in range(6)]
        job={'notes':'','runtime':{'summary_runtime':'fake','summary_model':'fake'},'temporary':self.temp.name}
        fake=SimpleNamespace(poll=lambda:None,terminate=lambda:None,wait=lambda timeout=None:0)
        with patch.object(w.subprocess,'Popen',return_value=fake),patch.object(w,'request',request):
            summary=w.summarize(self.output,job,{'entries':entries},lambda *a:None)
        self.assertEqual(summary['overview'][0]['text'],'Fine.')

    def test_too_little_speech_gets_no_summary(self):
        summary=w.summarize(self.output,{'notes':'','runtime':{},'temporary':self.temp.name},{'entries':[{'id':1,'source':'mic','text':'thank you'}]},lambda *a:None)
        self.assertEqual(summary,{k:[] for k in w.SECTIONS})

    def test_the_live_transcript_becomes_the_saved_one(self):
        heard=self.output/'heard.json'
        line=[{'id':1,'source':'mic','start_ms':0,'end_ms':1,'text':'hello there','stream_id':'a'}]
        heard.write_text(json.dumps({'recording_key':'k','complete':True,'entries':line,'warnings':[],'version':'v','pipeline_version':'p'}))
        folder=self.output/'call';folder.mkdir()
        data=w.live_transcript(folder,{'recording_key':'k','live_transcript':str(heard)})
        self.assertEqual(data['version'],'v')
        self.assertEqual(json.loads((folder/'transcript.json').read_text()),data)

    def test_a_silent_call_is_not_a_failure(self):
        heard=self.output/'silent.json'
        heard.write_text(json.dumps({'recording_key':'k','complete':True,'entries':[],'version':'v'}))
        folder=self.output/'quiet';folder.mkdir()
        self.assertEqual(w.live_transcript(folder,{'recording_key':'k','live_transcript':str(heard)})['entries'],[])

    def test_an_unfinished_or_older_transcript_is_not_used(self):
        heard=self.output/'old.json'
        folder=self.output/'older';folder.mkdir()
        for value in ({'recording_key':'k','complete':False,'entries':[]},{'recording_key':'old','complete':True,'entries':[],'version':'v'}):
            heard.write_text(json.dumps(value))
            self.assertIsNone(w.live_transcript(folder,{'recording_key':'k','live_transcript':str(heard)}))
            (folder/'transcript.json').write_text(json.dumps(value))
            self.assertIsNone(w.live_transcript(folder,{'recording_key':'k'}))

    def test_short_notes_reach_the_summary_unchanged(self):
        self.assertIn('Ask about the fictional budget.',self.summarize_with_notes('Ask about the fictional budget.')[0])

    def test_longest_allowed_notes_still_summarize_with_their_start_and_end(self):
        notes='Opening agenda line.\n'+'Fictional middle note é.\n'*12000+'Closing action line.'
        self.assertGreater(len(notes.encode()),256*1000)
        seen=self.summarize_with_notes(notes)
        self.assertTrue(seen)
        self.assertIn('Opening agenda line.',seen[0]);self.assertIn('Closing action line.',seen[0][-40:])
        self.assertIn('omitted',seen[0])
        self.assertLessEqual(len(seen[0].encode()),w.NOTES_CONTEXT+1000)

    def test_tracks_after_minute_30_are_accepted_up_to_the_90_minute_cap(self):
        import numpy as np
        from scipy.io import wavfile
        folder=self.output/'long';folder.mkdir()
        for name in ('system.wav','mic-0.wav','mic-1.wav'):wavfile.write(folder/name,16000,np.zeros(16,dtype=np.float32))
        stats={'samples':16,'sample_rate':16000}
        session={'system':stats,'mic_segments':[{'file':'mic-0.wav','offset_ms':0,'stats':stats},
                                                {'file':'mic-1.wav','offset_ms':60*60*1000,'stats':stats}]}
        self.assertEqual([t[2] for t in w.source_tracks(folder,session)],[0,0,3600000])
        session['mic_segments'][1]['offset_ms']=(w.MAX_CALL_S+11)*1000
        with self.assertRaises(ValueError):w.source_tracks(folder,session)

    def test_busy_store_delays_a_write_instead_of_stopping_live_transcription(self):
        # call-rig case C (2026-10-28): the store held 1.3 s during a write killed the worker for the call.
        import threading,time
        feed=w.LocalTranscriptFeed(self.target,self.binding,self.output)
        held=threading.Event()
        def hold():
            with self.bridge.registry_locked(self.root):held.set();time.sleep(1.3)
        holder=threading.Thread(target=hold);holder.start();held.wait(2)
        row={'id':1,'source':'system','track':'system.wav','chunk':0,'start_ms':0,'end_ms':900,'text':'Said while the store was busy'}
        feed({'entries':[row],'complete':False})
        holder.join()
        self.assertEqual([s['text'] for s in self.state()['feed']['segments']],['Said while the store was busy'])

    def test_busy_store_at_startup_delays_instead_of_failing(self):
        import threading,time
        held=threading.Event()
        def hold():
            with self.bridge.locked(self.root/self.run,self.run):held.set();time.sleep(1.3)
        holder=threading.Thread(target=hold);holder.start();held.wait(2)
        # The snapshot answers at once, so only the binding read meets the busy lock.
        with patch.object(w.LocalTranscriptFeed,'dispatch',lambda self,command,value:{'local_only':True,'feed_sequence':0,'version':1}):
            feed=w.LocalTranscriptFeed(self.target,self.binding,self.output)
        holder.join()
        self.assertEqual(feed.current,{})

    def test_store_busy_past_the_limit_still_fails(self):
        feed=w.LocalTranscriptFeed(self.target,self.binding,self.output)
        busy=TimeoutError('Meeting store is busy; retry')
        row={'id':1,'source':'system','track':'system.wav','chunk':0,'start_ms':0,'end_ms':900,'text':'Never stored'}
        clock=iter(range(0,10**6,5))
        with patch.object(feed.bridge,'dispatch',side_effect=busy),patch.object(w.time,'monotonic',lambda:next(clock)),patch.object(w.time,'sleep'):
            with self.assertRaises(TimeoutError):feed({'entries':[row],'complete':False})

    def test_stable_ids_reconcile_reordering_merge_and_echo_removal(self):
        feed=w.LocalTranscriptFeed(self.target,self.binding,self.output)
        remote={'id':1,'source':'system','track':'system.wav','chunk':0,'start_ms':10000,'end_ms':12000,'text':'Remote speech'}
        echo={'id':2,'source':'mic','track':'mic-0.wav','chunk':0,'start_ms':10100,'end_ms':12100,'text':'Remote speech'}
        feed({'raw_entries':[remote,echo],'entries':[remote,echo],'complete':False})
        remote_id=next(s['id'] for s in self.state()['feed']['segments'] if s['source']=='other_audio')
        independent={**echo,'id':1,'track':'mic-1.wav','start_ms':1000,'end_ms':2000,'text':'Independent speech'}
        raw=[independent,{**remote,'id':2},{**echo,'id':3},{**remote,'id':4,'chunk':464000,'start_ms':11000,'end_ms':14000,'text':'Remote speech continued'}]
        feed({'raw_entries':raw,'entries':raw,'complete':False})
        final={'raw_entries':raw,'entries':[{**independent,'raw_ids':[1]},{**remote,'id':2,'end_ms':14000,'text':'Remote speech continued','raw_ids':[2,4]}],'complete':True}
        feed(final);current=self.state()
        self.assertEqual(len(current['feed']['segments']),2)
        self.assertEqual(next(s['id'] for s in current['feed']['segments'] if s['source']=='other_audio'),remote_id)
        self.assertEqual(len(current['transcripts'][-1]['sources']),2)
        sequence=current['feed']['sequence'];feed(final)
        self.assertEqual(self.state()['feed']['sequence'],sequence)
        resumed=w.LocalTranscriptFeed(self.target,self.binding,self.output);resumed(final)
        self.assertEqual(self.state()['feed']['sequence'],sequence)
        self.assertEqual(self.bridge.wait(self.root/self.run,self.run,.01),{'status':'local_only'})

    def test_long_feed_keeps_recent_window_and_full_transcript_unchanged(self):
        import copy
        feed=w.LocalTranscriptFeed(self.target,self.binding,self.output)
        transcript={'entries': [], 'complete': False}
        for i in range(100):
            transcript['entries'].append({'id': i, 'source': 'system', 'track': 'system.wav', 'chunk': i, 'start_ms': i*1000, 'end_ms': i*1000+900, 'text': f'Fictional line {i}'})
            before=copy.deepcopy(transcript)
            feed(transcript)
            self.assertEqual(transcript,before)
            self.assertLessEqual(len(self.state()['feed']['segments']),32)
        state=self.state()
        self.assertEqual(len(transcript['entries']),100)
        self.assertEqual([s['text'] for s in state['feed']['segments']], [f'Fictional line {i}' for i in range(68,100)])
        self.assertGreater(state['feed']['sequence'],24)
        self.assertEqual(len(state['feed']['receipts']),24)
        sequence=state['feed']['sequence']
        resumed=w.LocalTranscriptFeed(self.target,self.binding,self.output);resumed(transcript)
        self.assertEqual(self.state()['feed']['sequence'],sequence)
        transcript['entries'][-1]['text']='Corrected newest line';resumed(transcript)
        self.assertEqual(self.state()['feed']['segments'][-1]['text'],'Corrected newest line')
        self.assertEqual(self.bridge.wait(self.root/self.run,self.run,.01),{'status':'local_only'})

    def test_recent_window_also_bounds_bytes(self):
        feed=w.LocalTranscriptFeed(self.target,self.binding,self.output)
        transcript={'entries': [{'id': i, 'source': 'system', 'track': 'system.wav', 'chunk': i, 'start_ms': i*1000, 'end_ms': i*1000+900, 'text': ('界' * 300) + str(i)} for i in range(30)], 'complete': True}
        feed(transcript)
        state=self.state()
        self.assertLess(len(state['feed']['segments']),32)
        self.assertLessEqual(len(json.dumps(state['transcripts'][-1]['sources'],ensure_ascii=False).encode()),12000)
        self.assertTrue(state['feed']['segments'][-1]['text'].endswith('29'))
        self.assertEqual(len(transcript['entries']),30)

    def test_binding_and_fictional_targets_rejected(self):
        with self.assertRaises(ValueError):w.LocalTranscriptFeed(self.target,{**self.binding,'recording_key':'b'*64},self.output)
        fictional=self.bridge.dispatch(self.root,'create',{})['run_id']
        with self.assertRaises(ValueError):w.LocalTranscriptFeed({**self.target,'run_id':fictional},self.binding,self.output)

    def test_checkpoint_callback_runs_before_completion_without_modifying_audio(self):
        import numpy as np
        from scipy.io import wavfile
        source=self.output/'audio';source.mkdir();out=self.output/'results';out.mkdir()
        audio=source/'system.wav';wavfile.write(audio,16000,np.zeros(16000*31,dtype=np.float32));before=audio.read_bytes()
        job={'recording_key':'a'*64,'runtime':{'asr_model':'unused'},'session':{'system':{'samples':16000*31,'sample_rate':16000},'mic_segments':[]}}
        feed=w.LocalTranscriptFeed(self.target,self.binding,out)
        result=w.transcribe(source,job,lambda *_:None,feed,out)
        self.assertTrue(result['complete']);self.assertFalse((source/'transcript.json').exists())
        events=json.loads((out/'feed-updates.json').read_text())
        self.assertEqual([e['complete'] for e in events],[False,False,True])
        self.assertEqual(audio.read_bytes(),before)

    def test_live_replay_paces_both_tracks_with_bounded_lookahead(self):
        import numpy as np
        from scipy.io import wavfile
        source=self.output/'audio';source.mkdir();out=self.output/'live';out.mkdir()
        for name,value in [('system.wav',.1),('mic-0.wav',.2)]:
            wavfile.write(source/name,16000,np.full(16000*31,value,dtype=np.float32))
        before={p.name:p.read_bytes() for p in source.iterdir()}
        stats={'samples':16000*31,'sample_rate':16000}
        job={'recording_key':'a'*64,'runtime':{'asr_model':'unused'},'session':{'system':stats,'mic_segments':[{'file':'mic-0.wav','offset_ms':5000,'stats':stats}]}}
        w.atomic_json(out/'transcript.json',{'recording_key':'a'*64,'asr_model':'unused','pipeline_version':w.PIPELINE_VERSION,'entries':[],'chunks':{},'complete':True})
        clock=[100.0];decoded=[];devices=[]
        def decode(audio,**options):
            decoded.append((clock[0]-100,len(audio),float(audio[0])))
            clock[0]+=.1
            self.assertTrue(options['word_timestamps'])
            return {'segments':[{'start':0,'end':1,'text':f'Fictional line {len(decoded)}','no_speech_prob':0},{'start':40,'end':45,'text':'Invalid future timestamp','no_speech_prob':0}]}
        mx=SimpleNamespace(gpu='gpu',cpu='cpu',metal=SimpleNamespace(is_available=lambda:True),set_default_device=devices.append)
        with patch.dict(sys.modules,{'mlx':SimpleNamespace(core=mx),'mlx.core':mx,'mlx_whisper':SimpleNamespace(transcribe=decode)}),patch.object(w.time,'monotonic',lambda:clock[0]),patch.object(w.time,'sleep',lambda seconds:clock.__setitem__(0,clock[0]+seconds)):
            feed=w.LocalTranscriptFeed(self.target,self.binding,out)
            def publish(data):
                self.assertTrue(all(row['end_ms']<=data['audio_available_ms'] for row in data['entries']))
                feed(data)
            result=w.transcribe(source,job,lambda *_:None,publish,out,live_style=True)
            resumed=w.transcribe(source,job,lambda *_:None,None,out,live_style=True)
            self.assertEqual(resumed['version'],result['version'])
        events=json.loads((out/'feed-updates.json').read_text())
        self.assertEqual(devices,['gpu']);self.assertEqual(len(decoded),10)
        self.assertEqual(len(events),11);self.assertTrue(events[-1]['complete'])
        self.assertTrue(all(e['elapsed_ms']+1>=e['audio_available_ms'] for e in events))
        self.assertEqual([e['audio_available_ms'] for e in events],sorted(e['audio_available_ms'] for e in events))
        self.assertTrue(all(size<=8*16000 for _,size,_ in decoded))
        self.assertLess(decoded[0][2],.15);self.assertGreater(decoded[1][2],.15)
        self.assertLess(events[0]['elapsed_ms'],9000)
        self.assertEqual(result['pipeline_version'],w.PIPELINE_VERSION+'-live-replay-8s-gpu-v1'+AEC)
        self.assertEqual(len(result['entries']),10)
        self.assertEqual({p.name:p.read_bytes() for p in source.iterdir()},before)
        self.assertEqual(self.bridge.wait(self.root/self.run,self.run,.01),{'status':'local_only'})

class HalfWrite:
    """An append that saves a row but fails before its line end, as a full disk can."""
    def __init__(self, path, mode='r', **kwargs):
        self.stream = io.open(path, mode, **kwargs)

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.stream.close()

    def write(self, text):
        self.stream.write(text.rstrip('\n'))
        self.stream.flush()
        raise OSError('disk full')


class JournalTests(unittest.TestCase):
    def test_numbering_survives_a_cut_row_a_failed_write_and_any_text(self):
        # The worker and the responder each carry this class; both must hold the Observatory's contiguous seq.
        spec = importlib.util.spec_from_file_location('journal_responder', Path(w.__file__).parents[2]/'resources/assistie/responder.py')
        responder = importlib.util.module_from_spec(spec); spec.loader.exec_module(responder)
        for module in (w, responder):
            with self.subTest(module=module.__name__), tempfile.TemporaryDirectory() as temp:
                path = Path(temp)/'journal.jsonl'
                path.write_text('{"seq": 1, "kind": "a"}\n{"seq": 2, "ki')  # a crash cut row 2 short
                journal = module.Journal(path)
                journal.write(kind='b', text='lone \ud800 surrogate')
                with patch('builtins.open', side_effect=OSError('disk full')):
                    journal.write(kind='lost')
                with patch('builtins.open', HalfWrite):
                    journal.write(kind='half')  # on disk without its line end, then the write fails
                with patch('builtins.open', HalfWrite), patch.object(Path, 'read_bytes', side_effect=OSError('busy')):
                    journal.write(kind='unsure')  # on disk, but the read-back fails: numbering is now unknown
                    journal.write(kind='skipped')  # so nothing is written until a read succeeds
                journal.write(kind='c')
                module.Journal(path).write(kind='d')  # a restart resumes the numbering
                lines = [l for l in path.read_text().splitlines() if l]
                readable = []
                for line in lines:
                    try:
                        readable.append(json.loads(line))
                    except ValueError:
                        pass
                self.assertEqual([(r['seq'], r['kind']) for r in readable], [(1, 'a'), (2, 'b'), (3, 'half'), (4, 'unsure'), (5, 'c'), (6, 'd')])
                self.assertEqual(readable[1]['text'], 'lone \ud800 surrogate')
                self.assertEqual(len(lines) - len(readable), 1, 'only the cut row is unreadable')


class WorkerTests(unittest.TestCase):
    def test_recovered_partial_channels_and_expired_checkpoint(self):
        import numpy as np
        from scipy.io import wavfile
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            wavfile.write(root / "mic-0.wav", 16000, np.zeros(160, dtype=np.float32))
            session = {"recovered_at": "fixture", "system": {"error": "missing"}, "mic_segments": [{"file": "mic-0.wav", "stats": {"samples": 160, "sample_rate": 16000}, "offset_ms": 0}]}
            self.assertEqual(w.source_tracks(root, session)[0][1], "mic")
            recovered_job = {"recording_key": "recovered", "runtime": {"asr_model": "unused"}, "session": session}
            recovered = w.transcribe(root, recovered_job, lambda *_: None)
            self.assertTrue(recovered["complete"])
            self.assertTrue(recovered["warnings"])
            self.assertEqual(recovered["echo_suppressed"], [])
            session["mic_segments"][0]["file"] = "../private.wav"
            with self.assertRaises(ValueError): w.source_tracks(root, session)
            job = {"recording_key": "fixture", "runtime": {"asr_model": "unused"}, "session": {}}
            saved = {"complete": True, "entries": [], "recording_key": "fixture", "asr_model": "unused", "pipeline_version": w.PIPELINE_VERSION + AEC}
            w.atomic_json(root / "transcript.json", saved)
            w.atomic_json(root / "retention.json", {"deletion_started_at": 1})
            self.assertEqual(w.transcribe(root, job, lambda *_: None), saved)
            job["runtime"]["asr_model"] = "different"
            with self.assertRaisesRegex(ValueError, "expired"): w.transcribe(root, job, lambda *_: None)

    def test_no_audio_traversal_or_symlinks(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); (root / "system.wav").touch()
            session = {"system": {}, "mic_segments": [{"file": "../secret.wav", "stats": {}, "offset_ms": 0}]}
            with self.assertRaises(ValueError): w.source_tracks(root, session)
            session["mic_segments"] = []
            (root / "system.wav").unlink(); (root / "system.wav").symlink_to('/etc/hosts')
            with self.assertRaises(ValueError): w.source_tracks(root, session)

    def test_silence_checkpoint_recovery_without_loading_a_model(self):
        import numpy as np
        from scipy.io import wavfile
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            wavfile.write(root / "system.wav", 16000, np.zeros(16000 * 31, dtype=np.float32))
            job = {"recording_key": "fixture", "runtime": {"asr_model": "unused"}, "session": {"system": {"samples": 16000 * 31, "sample_rate": 16000}, "mic_segments": []}}
            progress = []
            first = w.transcribe(root, job, lambda *args: progress.append(args))
            self.assertTrue(first["complete"]); self.assertFalse(first["entries"])
            self.assertEqual(len(first["chunks"]), 2)
            first["complete"] = False; w.atomic_json(root / 'transcript.json', first)
            resumed = w.transcribe(root, job, lambda *args: self.fail('Finished chunks must be reused'))
            self.assertTrue(resumed['complete']); self.assertEqual(resumed['version'], first['version'])

class EchoAndSummaryTests(unittest.TestCase):
    @staticmethod
    def entry(i, source, text, start=3000, end=4200):
        return {"id": i, "source": source, "track": source, "text": text, "start_ms": start, "end_ms": end}

    def test_stable_delayed_echo_and_independent_speech(self):
        import numpy as np
        rng = np.random.default_rng(42)
        system = rng.normal(0, .08, 64000).astype(np.float32)
        mic = np.r_[np.zeros(400), system[:-400]] * .5
        evidence = object.__new__(w.EchoEvidence)
        evidence.system, evidence.mics, evidence.cache = system, [(0, mic)], {}
        self.assertTrue(evidence.supports(3000, 4200))
        evidence.mics, evidence.cache = [(0, rng.normal(0, .08, 64000).astype(np.float32))], {}
        self.assertFalse(evidence.supports(3000, 4200))
        evidence.mics, evidence.cache = [(0, np.zeros(64000, dtype=np.float32))], {}
        self.assertFalse(evidence.supports(3000, 4200))
        evidence.mics, evidence.cache = [(3000, mic[:12000])], {}
        self.assertFalse(evidence.supports(3000, 4200), 'Never borrow echo evidence from across a short capture segment')

    def test_matching_fragments_hide_only_with_audio_evidence(self):
        class Evidence:
            enabled = True
            def supports(self, *_): return self.enabled
        evidence = Evidence()
        rows = [self.entry(1,'system','How are you doing?'), self.entry(2,'mic','How are',3050,3500), self.entry(3,'mic','you doing?',3500,4250), self.entry(4,'mic','I am doing well.',4300,5000)]
        clean, audit = w.remove_echo(rows,evidence)
        self.assertEqual([e['id'] for e in clean],[1,4]);self.assertEqual(audit[0]['mic_raw_ids'],[2,3]);self.assertEqual(len(rows),4)
        evidence.enabled = False
        self.assertEqual(len(w.remove_echo(rows,evidence)[0]),4)

    def test_independent_speech_repetition_and_short_replies_survive(self):
        class Evidence:
            def supports(self,*_): return True
        rows = [self.entry(1,'system','Bring the folder.'),self.entry(2,'mic','I will call later.'),self.entry(3,'mic','Bring the folder.',5500,6500),self.entry(4,'system','Yes.',7000,7200),self.entry(5,'mic','Yes.',7050,7250)]
        self.assertEqual(w.remove_echo(rows,Evidence())[0],rows)

    def test_chunk_boundary_keeps_full_question_and_independent_speech(self):
        rows=[self.entry(1,'system','you',28400,29800),self.entry(2,'system','You were there earlier?',29000,31200),self.entry(3,'mic','I was waiting.',29000,31500)]
        rows[0]['chunk']=0;rows[1]['chunk']=29;rows[2]['chunk']=29
        stitched=w.stitch_chunks(rows)
        self.assertEqual([r['text'] for r in stitched],['I was waiting.','You were there earlier?'])
        question=next(r for r in stitched if r['source']=='system')
        self.assertEqual(question['raw_ids'],[1,2])
        unchanged=[self.entry(1,'mic','Yes.',1000,1200),self.entry(2,'mic','Yes.',1300,1500)]
        unchanged[0]['chunk']=0;unchanged[1]['chunk']=29
        self.assertEqual(len(w.stitch_chunks(unchanged)),2)

    def test_asr_keeps_intentional_repeated_lines(self):
        import sys, types
        from unittest.mock import patch
        import numpy as np
        from scipy.io import wavfile
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);wavfile.write(root/'system.wav',16000,np.full(16000*5,.01,dtype=np.float32))
            model=types.SimpleNamespace(transcribe=lambda *_a,**_k:{'segments':[{'text':'Yes, I agree.','start':1,'end':2},{'text':'Yes, I agree.','start':3,'end':4}]})
            job={'recording_key':'repeat','runtime':{'asr_model':'unused'},'session':{'system':{'samples':16000*5,'sample_rate':16000},'mic_segments':[]}}
            with patch.dict(sys.modules,{'mlx_whisper':model}):
                result=w.transcribe(root,job,lambda *_:None)
            self.assertEqual(len(result['raw_entries']),2);self.assertEqual(len(result['entries']),2)

    def test_old_checkpoint_is_invalidated_by_pipeline_version(self):
        import numpy as np
        from scipy.io import wavfile
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);wavfile.write(root/'system.wav',16000,np.zeros(16000,dtype=np.float32))
            w.atomic_json(root/'transcript.json',{'recording_key':'same','asr_model':'unused','complete':True,'entries':[{'text':'stale'}]})
            job={'recording_key':'same','runtime':{'asr_model':'unused'},'session':{'system':{'samples':16000,'sample_rate':16000},'mic_segments':[]}}
            result=w.transcribe(root,job,lambda *_:None)
            self.assertTrue(result['complete']);self.assertEqual(result['pipeline_version'],w.PIPELINE_VERSION+AEC);self.assertEqual(result['entries'],[])


@unittest.skipUnless(w.echo_cleaning_available(), 'pywebrtc-audio is not installed in this Python')
class EchoCleaningTests(unittest.TestCase):
    """One test per row of the echo-cleaning contract. Synthetic speech-like signals at the user's real mic
    levels (about -60 dBFS): 'remote' plays from the speakers into the mic, 'ed' speaks into it directly."""
    R = 48000

    @classmethod
    def speech(cls, seconds, seed, db):
        import numpy as np
        from scipy.signal import butter, sosfilt
        rng = np.random.default_rng(seed)
        x = sosfilt(butter(4, [300, 3400], 'bandpass', fs=cls.R, output='sos'), rng.standard_normal(int(seconds * cls.R)))
        t = np.arange(len(x)) / cls.R
        x *= 0.55 + 0.45 * np.sin(2 * np.pi * (3.5 + seed % 3) * t)  # syllable rhythm
        return (x / np.sqrt(np.mean(x * x)) * 10 ** (db / 20)).astype(np.float32)

    @classmethod
    def echo(cls, remote, delay_ms, gain):
        import numpy as np
        h = np.zeros(cls.R // 20); h[0] = 1; h[200] = .4; h[700] = .15  # direct path plus two reflections
        y = np.convolve(remote, h)[:len(remote)] * gain
        d = int(delay_ms * cls.R / 1000)
        return np.concatenate([np.zeros(d, np.float32), y[:len(y) - d]]).astype(np.float32) if d >= 0 else np.concatenate([y[-d:], np.zeros(-d, np.float32)]).astype(np.float32)

    @staticmethod
    def db(x):
        import numpy as np
        return 10 * np.log10(np.mean(np.asarray(x, np.float64) ** 2) + 1e-12)

    def clean(self, mic, system, offset_ms=0, start=0):
        c = w.MicEchoCanceller(offset_ms, start)
        c.advance(mic, system, len(mic))
        return c.window(start, len(mic)) if start else c.window(0, len(mic))

    def scenario(self, delay_ms=28, gain=1.0):
        """0-12 s remote only, 12-18 s the user only, 18-26 s both, 26-30 s silence."""
        import numpy as np
        R = self.R
        remote = np.zeros(30 * R, np.float32); remote[:12 * R] = self.speech(12, 1, -38); remote[18 * R:26 * R] = self.speech(8, 2, -38)
        ed = np.zeros(30 * R, np.float32); ed[12 * R:18 * R] = self.speech(6, 3, -60); ed[18 * R:26 * R] = self.speech(8, 4, -60)
        mic = ed + self.echo(remote, delay_ms, gain * 10 ** (-22 / 20))  # echo lands near -60 dBFS, as on the user's calls
        return remote, ed, mic

    def test_w1_remote_echo_leaves_the_mic_and_ed_alone_is_untouched(self):
        R = self.R
        remote, ed, mic = self.scenario()
        out = self.clean(mic, remote)
        self.assertEqual(len(out), len(mic))
        self.assertGreater(self.db(mic[4 * R:12 * R]) - self.db(out[4 * R:12 * R]), 15, 'echo reduced by at least 15 dB')
        self.assertLess(abs(self.db(out[13 * R:18 * R]) - self.db(mic[13 * R:18 * R])), 1, 'the user alone within 1 dB')

    @staticmethod
    def follows(a, b):
        """Peak normalised correlation within the library's ~9 ms output delay."""
        import numpy as np
        from scipy.signal import correlate
        c = correlate(a, b, mode='full', method='fft')[len(b) - 1:len(b) - 1 + 1000]
        return float(np.max(np.abs(c)) / (np.linalg.norm(a) * np.linalg.norm(b) + 1e-12))

    def test_w2_double_talk_keeps_eds_words(self):
        # Known limit, pinned so it cannot get worse: AEC3's suppressor turns the user down while the echo is as loud
        # as him (8 s of continuous overlap, harsher than real calls). Neural AEC is the follow-up if real
        # calls lose words here.
        R = self.R
        for gain, floor in ((1.0, -10), (2.0, -20)):
            remote, ed, mic = self.scenario(gain=gain)
            out, said = self.clean(mic, remote)[20 * R:25 * R], ed[20 * R:25 * R]
            self.assertGreater(self.follows(out, said), .35, f'gain {gain}: still the user')
            self.assertGreater(self.db(out) - self.db(said), floor, f'gain {gain}: the user level')

    def test_w3_echo_that_reaches_the_mic_before_the_reference_is_still_cancelled(self):
        R = self.R
        remote, ed, mic = self.scenario(delay_ms=-150)
        out = self.clean(mic, remote)
        self.assertGreater(self.db(mic[4 * R:12 * R]) - self.db(out[4 * R:12 * R]), 15)

    def test_loud_and_quiet_echo_gains(self):
        R = self.R
        for gain in (.3, 1.0, 2.0):
            remote, ed, mic = self.scenario(gain=gain)
            out = self.clean(mic, remote)
            self.assertGreater(self.db(mic[4 * R:12 * R]) - self.db(out[4 * R:12 * R]), 15, f'gain {gain}')
            self.assertLess(abs(self.db(out[13 * R:18 * R]) - self.db(mic[13 * R:18 * R])), 1, f'gain {gain}')

    def test_quiet_reply_and_interjection_right_after_remote_speech_are_kept(self):
        import numpy as np
        R = self.R
        remote = np.zeros(14 * R, np.float32); remote[:10 * R] = self.speech(10, 5, -38)
        ed = np.zeros(14 * R, np.float32)
        ed[10 * R + R // 20:10 * R + 2 * R // 5] = self.speech(.35, 6, -60)   # "yeah" 50 ms after the remote stops
        ed[12 * R:13 * R] = self.speech(1, 7, -66)                            # a quiet reply
        out = self.clean(ed + self.echo(remote, 28, 10 ** (-22 / 20)), remote)
        for a, b in ((10 * R + R // 20, 10 * R + 2 * R // 5), (12 * R, 13 * R)):
            self.assertGreater(self.db(out[a:b]) - self.db(ed[a:b]), -6)

    def test_w7_headphones_mute_nothing(self):
        import numpy as np
        R = self.R
        remote, ed, _ = self.scenario()
        out = self.clean(ed, remote)  # no echo reaches the mic
        for a, b in ((13, 18), (19, 26)):
            self.assertLess(abs(self.db(out[a * R:b * R]) - self.db(ed[a * R:b * R])), 1)

    def test_w5_offset_segment_and_w10_restart_mid_track_stay_aligned(self):
        R = self.R
        remote, ed, mic = self.scenario()
        offset = 2000  # a later mic segment starts 2 s into the call
        out = self.clean(mic[2 * R:], remote, offset_ms=offset)
        self.assertGreater(self.db(mic[6 * R:12 * R]) - self.db(out[4 * R:10 * R]), 15)
        # Worker restart at 8 s, mid-echo: it warms up on the audio before, so the first second it publishes
        # is already clean (a cold canceller would leak there while it adapts).
        restarted = self.clean(mic, remote, start=8 * R)
        self.assertGreater(self.db(mic[8 * R:9 * R]) - self.db(restarted[:R]), 15)

    def test_w6_tail_keeps_every_sample_and_w4_window_needs_cleaned_range(self):
        R = self.R
        remote, ed, mic = self.scenario()
        mic = mic[:17 * R + 1234]  # not a whole frame or gate block
        c = w.MicEchoCanceller(0, 0)
        c.advance(mic, remote[:16 * R], len(mic))  # reference ends before the mic
        out = c.window(0, len(mic))
        self.assertEqual(len(out), len(mic))
        self.assertLess(abs(self.db(out[13 * R:16 * R]) - self.db(mic[13 * R:16 * R])), 1)
        self.assertIsNone(c.window(0, len(mic) + 10 * R), 'never hands back a range it has not cleaned')

    def test_w4_growing_mic_windows_wait_for_reference(self):
        import numpy as np
        from scipy.io import wavfile
        R = self.R
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            wavfile.write(root / 'system.wav', R, np.zeros(20 * R, np.float32))
            wavfile.write(root / 'mic-0.wav', R, np.zeros(20 * R, np.float32))
            def manifest(system_samples, active=True):
                w.atomic_json(root / 'session.json', {'id': 'call', 'started_at': 't', 'active': active, 'mic_yielded': False, 'notes': '', 'title': '',
                    'system': {'samples': system_samples, 'sample_rate': R}, 'mic_segments': [{'file': 'mic-0.wav', 'offset_ms': 0, 'stats': {'samples': 16 * R, 'sample_rate': R}}]})
            manifest(8 * R)
            job = {'session': json.loads((root / 'session.json').read_text()), 'echo_cleaning': True}
            gen = w.growing_tasks(root, job, {})
            first = next(gen)
            self.assertEqual(first[2], 'system', 'system window first; the mic window waits for reference to 8.3 s')
            polls = []
            def advance_reference(_):
                polls.append(1)
                manifest(16 * R, active=len(polls) < 3)
            with patch.object(w.time, 'sleep', advance_reference):
                rest = list(gen)
            mic_starts = [start for _, name, source, _, start, _, _ in rest if source == 'mic']
            self.assertEqual(mic_starts[:2], [0, 7 * R], 'mic windows released once reference covers end + hold')

    def fake_transcribe(self, root, job, segments_for, cleaning=True, streamed=None):
        import numpy as np
        mx = SimpleNamespace(gpu='gpu', cpu='cpu', metal=SimpleNamespace(is_available=lambda: True), set_default_device=lambda d: None)
        seen = []
        def decode(audio, **options):
            seen.append(np.asarray(audio))
            return {'segments': segments_for(len(seen))}
        with patch.dict(sys.modules, {'mlx': SimpleNamespace(core=mx), 'mlx.core': mx, 'mlx_whisper': SimpleNamespace(transcribe=decode)}), \
             patch.object(w, 'echo_cleaning_available', lambda: cleaning):
            return w.transcribe(root, job, lambda *_: None, streamed=streamed), seen

    def call_folder(self, root, mic, system):
        from scipy.io import wavfile
        wavfile.write(root / 'system.wav', self.R, system)
        wavfile.write(root / 'mic-0.wav', self.R, mic)
        stats = lambda x: {'samples': len(x), 'sample_rate': self.R}
        return {'recording_key': 'k', 'runtime': {'asr_model': 'unused'}, 'session': {'system': stats(system), 'mic_segments': [{'file': 'mic-0.wav', 'offset_ms': 0, 'stats': stats(mic)}]}}

    def test_w8_missing_canceller_falls_back_to_raw_with_a_warning(self):
        remote, ed, mic = self.scenario()
        with tempfile.TemporaryDirectory() as directory:
            job = self.call_folder(Path(directory), mic, remote)
            with patch.object(w, 'MicEchoCanceller', side_effect=ImportError('fictional')):
                result, _ = self.fake_transcribe(Path(directory), job, lambda n: [])
            self.assertTrue(result['complete'])
            self.assertGreater(result['cleaning']['raw'], 0)
            self.assertIn('canceller error: ImportError', result['cleaning']['degraded'])
            self.assertTrue(any('fell back to raw microphone audio' in warning for warning in result['warnings']))

    def test_cleaned_mic_reaches_whisper(self):
        R = self.R
        remote, ed, mic = self.scenario()
        with tempfile.TemporaryDirectory() as directory:
            job = self.call_folder(Path(directory), mic, remote)
            result, seen = self.fake_transcribe(Path(directory), job, lambda n: [])
            self.assertEqual(result['cleaning']['raw'], 0); self.assertGreater(result['cleaning']['cleaned'], 0)
            self.assertTrue(result['pipeline_version'].endswith('-aec2'))
            mic_first = seen[1]  # system window first, then the first 30 s mic window, both at 16 kHz
            self.assertGreater(self.db(mic[4 * R:12 * R]) - self.db(mic_first[4 * 16000:12 * 16000]), 15)

    def test_w9_repetition_loops_are_dropped_and_w12_eds_genuine_repeat_survives(self):
        remote, ed, mic = self.scenario()
        loop = {'start': 1, 'end': 3, 'text': 'a little bit of a little bit of a little bit of a little bit of', 'no_speech_prob': .1, 'compression_ratio': 3.1}
        said = {'start': 5, 'end': 7, 'text': 'We agreed to ship the fictional report on Friday.', 'no_speech_prob': .1, 'compression_ratio': 1.3}
        again = {**said, 'start': 15, 'end': 17}  # The user repeats it ten seconds later: not echo
        with tempfile.TemporaryDirectory() as directory:
            job = self.call_folder(Path(directory), mic, remote)
            result, _ = self.fake_transcribe(Path(directory), job, lambda n: [loop, said] if n == 1 else [loop, again])
        texts = [(e['source'], e['text']) for e in result['entries']]
        self.assertNotIn(loop['text'], [t for _, t in texts])
        self.assertGreater(result['cleaning']['loops_dropped'], 0)
        self.assertIn(('mic', said['text']), texts, 'a real repeat outside the echo window is kept')
        self.assertIn(('system', said['text']), texts)
        self.assertEqual(result['echo_suppressed'], [])

    def test_text_echo_drops_only_mic_lines_repeating_the_other_side_at_the_same_time(self):
        said = 'we should ship the report on friday'
        row = lambda i, source, ms, text: {'id': i, 'source': source, 'start_ms': ms, 'text': text}
        rows = [row('a', 'other_audio', 10000, said),
                row('echo', 'you', 11000, said),                     # the same words, a second later
                row('garbled', 'you', 12500, 'ship the report on the friday'),  # still most of it
                row('late', 'you', 20000, said),                     # The user repeating it after the window
                row('reply', 'you', 10500, 'yeah'),                  # short replies are never dropped
                row('short', 'you', 10600, 'on friday'),
                row('own', 'you', 11500, 'can we move the launch instead'),
                row('shared', 'you', 11700, 'yes on friday')]        # two words in common is a reply, not echo
        self.assertEqual(w.text_echoes(rows, 'you'), {'echo', 'garbled'})
        self.assertEqual(w.text_echoes(rows, 'you', since_ms=12000), {'garbled'})

    def test_text_echo_keeps_short_replies_with_contractions_and_lines_that_add_a_negation(self):
        row = lambda i, source, text: {'id': i, 'source': source, 'start_ms': 1000, 'text': text}
        for reply in ("that's right", "that\u2019s right", "we should not ship the report on friday", "we shouldn't ship the report on friday"):
            rows = [row('them', 'other_audio', "that's right we should ship the report on friday"), row('me', 'you', reply)]
            self.assertEqual(w.text_echoes(rows, 'you'), set(), reply)

    def test_text_echo_keeps_a_negated_line_unless_it_repeats_in_full(self):
        row = lambda i, source, text: {'id': i, 'source': source, 'start_ms': 1000, 'text': text}
        for them, me in (('we should ship, not wait', 'we should not ship'),
                         ('we should not wait to ship', 'we should not ship'),
                         ('we should ship with approval', 'we should ship without approval')):
            self.assertEqual(w.text_echoes([row('them', 'other_audio', them), row('me', 'you', me)], 'you'), set(), me)
        said = 'we should not ship the report'
        self.assertEqual(w.text_echoes([row('them', 'other_audio', said), row('me', 'you', said)], 'you'), {'me'})

    def test_echo_words_keep_every_language_and_contractions_whole(self):
        self.assertEqual(w.echo_words('D\u00e9j\u00e0 vu'), ['d\u00e9j\u00e0', 'vu'])
        self.assertEqual(w.echo_words('\u00bfEst\u00e1s aqu\u00ed?'), ['est\u00e1s', 'aqu\u00ed'])
        self.assertEqual(w.echo_words("That\u2019s right, isn't it"), ["that's", 'right', "isn't", 'it'])
        self.assertEqual(len(w.echo_words('\u0927\u0928\u094d\u092f\u0935\u093e\u0926')), 1)

    def test_model_requests_carry_any_text(self):
        sent = {}
        class Fake:
            def __init__(self, *_): pass
            def request(self, method, route, body, headers): sent['body'] = body
            def getresponse(self): return SimpleNamespace(status=200, read=lambda *_: b'{}')
            def close(self): pass
        with patch.object(w, 'UnixHTTP', Fake):
            w.request('p', 'POST', '/x', {'text': 'wait\u2026 caf\u00e9'})
        self.assertIsInstance(sent['body'], bytes)
        self.assertEqual(json.loads(sent['body'])['text'], 'wait\u2026 caf\u00e9')

    def test_a_saved_transcript_is_used_as_it_stands(self):
        with tempfile.TemporaryDirectory() as directory:
            folder=Path(directory)
            saved={'recording_key':'k','complete':True,'entries':[],'warnings':[],'version':'v','raw_entries':[1],'echo_suppressed':[2]}
            (folder/'transcript.json').write_text(json.dumps(saved))
            self.assertEqual(w.live_transcript(folder,{'recording_key':'k'}),saved)
            self.assertEqual(json.loads((folder/'transcript.json').read_text()),saved,'nothing is rewritten')

    def test_a_title_needs_real_speech(self):
        line = lambda text: {'source': 'mic', 'text': text}
        self.assertEqual(w.title_sample([line('thank you so much') for _ in range(40)]), '')
        self.assertEqual(w.title_sample([line('thank you') for _ in range(40)]), '')
        spoken = [line(f'we talked about topic number {i}') for i in range(6)]
        self.assertIn('You: we talked about topic number 5', w.title_sample(spoken))

    def test_a_long_title_sample_reaches_the_end_of_the_call(self):
        rows = [{'source': 'system', 'text': f'line {i} about the things we covered at length'} for i in range(2000)]
        sample = w.title_sample(rows)
        self.assertLessEqual(len(sample), w.TITLE_SAMPLE + 200)
        self.assertIn('line 1', sample)
        self.assertIn('line 16', sample)

    def test_a_title_must_be_about_something_said(self):
        sample = 'You: board game night this year was fun\nThem: mostly cooperative games'
        self.assertTrue(w.title_fits('board game night', sample))
        self.assertFalse(w.title_fits('Launch date and budget', sample), 'nothing said')
        self.assertFalse(w.title_fits('board', sample), 'too short')
        self.assertFalse(w.title_fits('board game night trends call', sample), 'generic')
        self.assertTrue(w.title_fits('board game night Meeting Agent Test', sample), 'a topic can use the word')
        self.assertFalse(w.title_fits('A very long title that keeps on going about board game night', sample))

    def test_naming_a_call_writes_a_title_once_and_stops_the_model(self):
        stopped = []
        process = SimpleNamespace(terminate=lambda: stopped.append(1), wait=lambda timeout=None: 0)
        reply = {'choices': [{'finish_reason': 'stop', 'message': {'content': '{"title": "board game night."}'}}]}
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            transcript = folder / 'transcript.json'
            transcript.write_text(json.dumps({'entries': [{'source': 'mic', 'text': f'board game night was fun {i}'} for i in range(6)]}))
            with patch.object(w, 'start_model', lambda *_, **__: process), patch.object(w, 'wait_for_model', lambda *_: None), patch.object(w, 'request', lambda *_, **__: (200, reply)):
                w.name_call(folder, transcript, {})
                self.assertEqual(json.loads((folder / 'title.json').read_text()), {'title': 'board game night'})
                self.assertEqual(stopped, [1])
                w.name_call(folder, transcript, {})
            self.assertEqual(stopped, [1], 'a named call is left alone')

    def test_only_one_run_names_a_call_at_a_time(self):
        import fcntl
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            with (folder / '.title-lock').open('w') as held:
                fcntl.flock(held, fcntl.LOCK_EX)
                with patch.object(w, 'write_title') as write:
                    w.name_call(folder, folder / 'transcript.json', {})
                write.assert_not_called()

    def test_a_model_that_ignores_stop_is_killed(self):
        calls = []
        def wait(timeout=None):
            calls.append(timeout)
            if timeout:
                raise subprocess.TimeoutExpired('model', timeout)
        process = SimpleNamespace(terminate=lambda: None, wait=wait, kill=lambda: calls.append('kill'))
        w.stop_model(process)
        self.assertEqual(calls, [5, 'kill', None])

    def test_an_invented_title_leaves_the_call_unnamed(self):
        process = SimpleNamespace(terminate=lambda: None, wait=lambda timeout=None: 0)
        reply = {'choices': [{'finish_reason': 'stop', 'message': {'content': '{"title": "Quarterly budget planning"}'}}]}
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            transcript = folder / 'transcript.json'
            transcript.write_text(json.dumps({'entries': [{'source': 'mic', 'text': f'board game night trends are strange {i}'} for i in range(6)]}))
            with patch.object(w, 'start_model', lambda *_, **__: process), patch.object(w, 'wait_for_model', lambda *_: None), patch.object(w, 'request', lambda *_, **__: (200, reply)):
                w.name_call(folder, transcript, {})
            self.assertFalse((folder / 'title.json').exists())

    def test_text_echo_stays_fast_on_a_long_call(self):
        import time
        line = lambda i: f'word{i} word{i + 1} word{i + 2} word{i + 3} word{i + 4}'
        rows = [{'id': f'{source}{i}', 'source': source, 'start_ms': i * 3000, 'text': line(i)} for i in range(1800) for source in ('you', 'other_audio')]
        started = time.monotonic()
        self.assertEqual(len(w.text_echoes(rows, 'you')), 1800)
        self.assertLess(time.monotonic() - started, 1, 'a 90 minute call is checked in under a second')

    def test_whisper_fallback_checks_its_lines_against_streamed_lines(self):
        remote, ed, mic = self.scenario()
        said = {'start': 5, 'end': 7, 'text': 'We agreed to ship the fictional report on Friday.', 'no_speech_prob': .1, 'compression_ratio': 1.3}
        streamed = [{'id': 'asr-1', 'source': 'other_audio', 'start_ms': 5000, 'end_ms': 7000, 'text': said['text'], 'finalized': True}]
        with tempfile.TemporaryDirectory() as directory:
            job = self.call_folder(Path(directory), mic, remote)
            result, _ = self.fake_transcribe(Path(directory), job, lambda n: [] if n == 1 else [said], streamed=streamed)
        self.assertEqual([(e['source'], e['text']) for e in result['entries']], [('system', said['text'])])
        self.assertEqual(len(result['echo_suppressed']), 1)

    def test_whisper_updates_keep_streamed_echo_out_and_audit_names_it_by_feed_id(self):
        remote, ed, mic = self.scenario()
        text = 'We agreed to ship the fictional report on Friday.'
        streamed = [{'id': 'asr-them', 'source': 'other_audio', 'start_ms': 5000, 'end_ms': 7000, 'text': text, 'finalized': True},
                    {'id': 'asr-echo', 'source': 'you', 'start_ms': 5100, 'end_ms': 7100, 'text': text, 'finalized': True}]
        said = {'start': 20, 'end': 22, 'text': 'A later fictional line from the mic.', 'no_speech_prob': .1, 'compression_ratio': 1.3}
        with tempfile.TemporaryDirectory() as directory:
            job = self.call_folder(Path(directory), mic, remote)
            result, _ = self.fake_transcribe(Path(directory), job, lambda n: [said], streamed=streamed)
        self.assertNotIn('asr-echo', [e.get('stream_id') for e in result['entries']], 'a dropped line does not return')
        self.assertIn('asr-them', [e.get('stream_id') for e in result['entries']])
        self.assertIn('asr-echo', [r['stream_id'] for r in result['echo_suppressed']])

    def test_whisper_updates_hold_a_streamed_decision_a_fresh_check_would_undo(self):
        remote, ed, mic = self.scenario()
        streamed = [{'id': 'asr-them', 'source': 'other_audio', 'start_ms': 5000, 'end_ms': 7000, 'text': 'Something else entirely.', 'finalized': True},
                    {'id': 'asr-echo', 'source': 'you', 'start_ms': 5100, 'end_ms': 7100, 'text': 'We agreed to ship the report.', 'finalized': True, 'echo': True}]
        with tempfile.TemporaryDirectory() as directory:
            job = self.call_folder(Path(directory), mic, remote)
            result, _ = self.fake_transcribe(Path(directory), job, lambda n: [], streamed=streamed)
        self.assertNotIn('asr-echo', [e.get('stream_id') for e in result['entries']])
        self.assertEqual([r['stream_id'] for r in result['echo_suppressed']], ['asr-echo'])
        self.assertTrue(any('Suppressed 1 microphone' in warning for warning in result['warnings']))


class EchoCleaningFallbackTests(unittest.TestCase):
    """Runs without the canceller installed too: a missing package must be visible, never silent."""

    def test_missing_canceller_warns_and_keeps_raw_audio(self):
        import numpy as np
        from scipy.io import wavfile
        R = 48000
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name, value in (('system.wav', .05), ('mic-0.wav', .02)):
                wavfile.write(root / name, R, np.full(10 * R, value, dtype=np.float32))
            stats = {'samples': 10 * R, 'sample_rate': R}
            job = {'recording_key': 'k', 'runtime': {'asr_model': 'unused'}, 'session': {'system': stats, 'mic_segments': [{'file': 'mic-0.wav', 'offset_ms': 0, 'stats': stats}]}}
            mx = SimpleNamespace(gpu='gpu', cpu='cpu', metal=SimpleNamespace(is_available=lambda: True), set_default_device=lambda d: None)
            with patch.dict(sys.modules, {'mlx': SimpleNamespace(core=mx), 'mlx.core': mx, 'mlx_whisper': SimpleNamespace(transcribe=lambda a, **k: {'segments': []})}), \
                 patch.object(w, 'echo_cleaning_available', lambda: False):
                result = w.transcribe(root, job, lambda *_: None)
        self.assertTrue(result['complete'])
        self.assertTrue(result['pipeline_version'].endswith('-aec0'))
        self.assertIn('echo canceller not installed', result['cleaning']['degraded'])
        self.assertTrue(any('fell back to raw microphone audio' in warning for warning in result['warnings']))


@unittest.skipUnless(w.echo_cleaning_available(), 'pywebrtc-audio is not installed in this Python')
class EchoCleaningStreamTests(unittest.TestCase):
    R = 48000

    def manifest(self, root, system_samples, mic_samples, active=True):
        R = self.R
        w.atomic_json(root / 'session.json', {'id': 'call', 'started_at': 't', 'active': active, 'mic_yielded': False, 'notes': '', 'title': '',
            'system': {'samples': system_samples, 'sample_rate': R}, 'mic_segments': [{'file': 'mic-0.wav', 'offset_ms': 0, 'stats': {'samples': mic_samples, 'sample_rate': R}}]})

    def mic_windows(self, system_s, mic_s):
        import numpy as np
        from scipy.io import wavfile
        R = self.R
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            wavfile.write(root / 'system.wav', R, np.zeros(40 * R, np.float32))
            wavfile.write(root / 'mic-0.wav', R, np.zeros(40 * R, np.float32))
            self.manifest(root, system_s * R, mic_s * R)
            job = {'session': json.loads((root / 'session.json').read_text()), 'echo_cleaning': True}
            out = []
            def stop_after_one_poll(_):
                raise StopIteration
            gen = w.growing_tasks(root, job, {})
            try:
                with patch.object(w.time, 'sleep', stop_after_one_poll):
                    for _, name, source, _, start, _, _ in gen:
                        if source == 'mic':
                            out.append(start // R)
            except (StopIteration, RuntimeError):
                pass
            return out

    def test_short_reference_lag_holds_mic_windows_in_order(self):
        # Reference 8 s, mic 12 s: the first mic window needs 8.3 s of reference, so it and every later
        # window of that file wait (never a later window first, which would strand the earlier one).
        self.assertEqual(self.mic_windows(8, 12), [])

    def test_stalled_reference_releases_mic_windows_in_order(self):
        # Mic 30 s, reference stuck at 8 s (22 s behind > AEC_STALL): released, oldest first.
        self.assertEqual(self.mic_windows(8, 30), [0, 7, 14, 21])

    def test_restart_beyond_warmup_publishes_clean_audio_at_once(self):
        import numpy as np
        R = self.R
        remote = EchoCleaningTests.speech(30, 11, -38)
        mic = EchoCleaningTests.echo(remote, 28, 10 ** (-22 / 20))
        c = w.MicEchoCanceller(0, 21 * R)  # worker restarted at 21 s: warms up from 11 s, not from 0
        self.assertEqual(c.done, 11 * R - w.AEC_HOLD)
        c.advance(mic, remote, 22 * R)
        first = c.window(21 * R, 22 * R)
        self.assertGreater(EchoCleaningTests.db(mic[21 * R:22 * R]) - EchoCleaningTests.db(first), 15)

    def test_post_call_two_segments_with_30_second_windows_are_cleaned_throughout(self):
        import numpy as np
        from scipy.io import wavfile
        R = self.R
        remote = EchoCleaningTests.speech(80, 12, -38)
        echo = EchoCleaningTests.echo(remote, 28, 10 ** (-22 / 20))
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            wavfile.write(root / 'system.wav', R, remote)
            wavfile.write(root / 'mic-0.wav', R, echo[:35 * R])
            wavfile.write(root / 'mic-1.wav', R, echo[40 * R:75 * R])  # dictation took the mic for 5 s
            st = lambda n: {'samples': n, 'sample_rate': R}
            job = {'recording_key': 'k', 'runtime': {'asr_model': 'unused'}, 'session': {'system': st(80 * R), 'mic_segments': [
                {'file': 'mic-0.wav', 'offset_ms': 0, 'stats': st(35 * R)}, {'file': 'mic-1.wav', 'offset_ms': 40000, 'stats': st(35 * R)}]}}
            mx = SimpleNamespace(gpu='gpu', cpu='cpu', metal=SimpleNamespace(is_available=lambda: True), set_default_device=lambda d: None)
            seen = []
            def decode(audio, **options):
                seen.append(np.asarray(audio)); return {'segments': []}
            with patch.dict(sys.modules, {'mlx': SimpleNamespace(core=mx), 'mlx.core': mx, 'mlx_whisper': SimpleNamespace(transcribe=decode)}):
                result = w.transcribe(root, job, lambda *_: None)
        self.assertEqual(result['cleaning']['raw'], 0)
        self.assertEqual(sorted(result['chunk_cleaning']), ['mic-0.wav:0', 'mic-0.wav:1392000', 'mic-1.wav:0', 'mic-1.wav:1392000'])
        mic_windows = [a for a in seen if len(a) and EchoCleaningTests.db(a) < -62]  # mic windows (cleaned), at 16 kHz
        self.assertEqual(len(mic_windows), 4)
        for window in mic_windows:  # skip each segment's first 2 s while the canceller converges
            self.assertLess(EchoCleaningTests.db(window[2 * 16000:]), EchoCleaningTests.db(echo[10 * R:12 * R]) - 15)


@unittest.skipUnless(w.echo_cleaning_available(), 'pywebrtc-audio is not installed in this Python')
class EchoCleaningRetryTests(unittest.TestCase):
    R = 48000

    def run_call(self, root, system, mic, system_rate=48000, decode=None):
        import numpy as np
        from scipy.io import wavfile
        wavfile.write(root / 'system.wav', system_rate, system)
        wavfile.write(root / 'mic-0.wav', self.R, mic)
        job = {'recording_key': 'k', 'runtime': {'asr_model': 'unused'}, 'session': {
            'system': {'samples': len(system), 'sample_rate': system_rate},
            'mic_segments': [{'file': 'mic-0.wav', 'offset_ms': 0, 'stats': {'samples': len(mic), 'sample_rate': self.R}}]}}
        mx = SimpleNamespace(gpu='gpu', cpu='cpu', metal=SimpleNamespace(is_available=lambda: True), set_default_device=lambda d: None)
        calls = []
        def fake(audio, **options):
            calls.append(1); return {'segments': []}
        with patch.dict(sys.modules, {'mlx': SimpleNamespace(core=mx), 'mlx.core': mx, 'mlx_whisper': SimpleNamespace(transcribe=decode or fake)}):
            return w.transcribe(root, job, lambda *_: None), len(calls)

    def test_partly_missing_reference_is_retried_and_warned(self):
        R = self.R
        remote = EchoCleaningTests.speech(8, 21, -38)
        mic = EchoCleaningTests.echo(EchoCleaningTests.speech(40, 21, -38), 28, .08)
        with tempfile.TemporaryDirectory() as directory:
            result, _ = self.run_call(Path(directory), remote, mic)
        self.assertIn('raw', result['chunk_cleaning'].values(), 'mic far beyond the reference is not "cleaned"')
        self.assertTrue(any('fell back to raw microphone audio' in warning for warning in result['warnings']))

    def test_unsupported_system_rate_is_never_retried(self):
        import numpy as np
        R = self.R
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            system = np.full(40 * 16000, .01, np.float32)
            mic = EchoCleaningTests.speech(40, 22, -60)
            first, decoded = self.run_call(root, system, mic, system_rate=16000)
            self.assertEqual(set(first['chunk_cleaning'].values()), {'unsupported'})
            again, decoded_again = self.run_call(root, system, mic, system_rate=16000)
        self.assertEqual(decoded_again, 0, 'a finished transcript with only unsupported windows is reused')

    def test_healthy_retry_clears_the_fallback_warning(self):
        R = self.R
        remote = EchoCleaningTests.speech(35, 23, -38)
        mic = EchoCleaningTests.echo(remote, 28, .08)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with patch.object(w, 'MicEchoCanceller', side_effect=RuntimeError('fictional')):
                failed, _ = self.run_call(root, remote, mic)
            self.assertTrue(any('fell back' in warning for warning in failed['warnings']))
            retried, decoded = self.run_call(root, remote, mic)
        self.assertGreater(decoded, 0, 'raw windows are redone once cleaning works')
        self.assertEqual(set(retried['chunk_cleaning'].values()), {'cleaned'})
        self.assertFalse(any('fell back' in warning for warning in retried['warnings']))

class StreamTests(unittest.TestCase):
    """Live streaming against fake_stream_asr.py, which speaks the sidecar's
    protocol without a model: each loud 100 ms frame adds a word, 1 s of quiet ends the line."""
    setUp_feed = LocalFeedTests.setUp
    state = LocalFeedTests.state

    def setUp(self):
        self.setUp_feed()
        for name, value in (('STREAM_POLL_S', .001), ('STREAM_PING_S', .2), ('STREAM_REPLY_S', 2)):
            patcher = patch.object(w, name, value); patcher.start(); self.addCleanup(patcher.stop)
        patcher = patch.object(w, 'echo_cleaning_available', lambda: False); patcher.start(); self.addCleanup(patcher.stop)
        self.calls = self.output / 'call'; self.calls.mkdir()
        self.models = self.output / 'models'; self.models.mkdir(); (self.models / 'metadata.json').write_text('{"chunk_ms": 560}')
        self.fake = self.output / 'fake-asr'
        self.fake.write_text(f'#!/bin/sh\nexec {sys.executable} -I {Path(w.__file__).with_name("fake_stream_asr.py")} "$@"\n')
        self.fake.chmod(0o755)
        self.log = self.output / 'fake.log'
        self.env = patch.dict('os.environ', {'FAKE_LOG': str(self.log), 'FAKE_MARK': str(self.output / 'crashed')}); self.env.start(); self.addCleanup(self.env.stop)

    def audio(self, *parts):
        import numpy as np
        return np.concatenate([np.full(int(48000 * seconds), .5 if loud else 0, dtype=np.float32) for seconds, loud in parts])

    def call(self, system, mics):
        """A finished call: system samples and [(file, offset_ms, samples)]."""
        from scipy.io import wavfile
        wavfile.write(self.calls / 'system.wav', 48000, system)
        segments = []
        for name, offset, samples in mics:
            wavfile.write(self.calls / name, 48000, samples)
            segments.append({'file': name, 'offset_ms': offset, 'stats': {'samples': len(samples), 'sample_rate': 48000}})
        session = {'id': 'saved-call', 'started_at': 'fictional', 'active': False, 'mic_yielded': len(mics) > 1, 'notes': '', 'title': '',
                   'system': {'samples': len(system), 'sample_rate': 48000}, 'mic_segments': segments}
        (self.calls / 'session.json').write_text(json.dumps(session))
        return session

    def run_stream(self, session, runtime=None, mode=''):
        os.environ['FAKE_MODE'] = mode
        feed = w.LocalTranscriptFeed(self.target, self.binding, self.output)
        job = {'session': session, 'runtime': runtime if runtime is not None else {'stream_asr': str(self.fake), 'stream_models': str(self.models)}}
        return w.stream_live(self.calls, job, feed, self.output, lambda *a, **k: None)

    def segments(self):
        return self.state()['feed']['segments']

    def checkpoint(self):
        return json.loads((self.output / 'stream-checkpoint.json').read_text())

    def test_text_echo_is_left_out_of_the_feed_and_the_saved_transcript(self):
        session = self.call(self.audio((2, 1), (2, 0), (1, 1), (2, 0)), [('mic-0.wav', 0, self.audio((1, 0), (1.5, 1), (2, 0)))])
        with patch.object(w, 'text_echoes', lambda rows, mic, since_ms=0: {r['id'] for r in rows if r['source'] == mic}):
            result = self.run_stream(session)
        self.assertTrue(result['complete'])
        self.assertNotIn('you', [s['source'] for s in self.segments()])
        saved = json.loads((self.output / 'transcript.json').read_text())
        self.assertEqual({e['source'] for e in saved['entries']}, {'system'})
        self.assertTrue(saved['echo_suppressed'] and all(r['stream_id'] for r in saved['echo_suppressed']))
        self.assertIn('Suppressed', saved['warnings'][0])
        rows = [json.loads(l) for l in (self.output / 'worker-journal.jsonl').read_text().splitlines()]
        self.assertTrue(any(r['kind'] == 'line' and r['stage'] == 'dropped' and r.get('reason') == 'echo' for r in rows))
        self.assertTrue(any(r.get('echo') for r in self.checkpoint()['finals']), 'a restart or fallback keeps the decision')

    def test_a_late_final_is_checked_for_echo_whatever_its_age(self):
        # Catch-up can finish a mic line well behind the other track: a final at 2 s after one at 8 s still counts.
        session = self.call(self.audio((2, 1), (6, 0)), [('mic-0.wav', 0, self.audio((1, 1), (7, 0)))])
        seen = []
        original = w.text_echoes
        def spy(rows, mic, since_ms=0):
            seen.append((len(rows), since_ms))
            return original(rows, mic, since_ms)
        with patch.object(w, 'text_echoes', spy):
            self.run_stream(session)
        self.assertTrue(all(since <= 0 for count, since in seen if count), 'old lines stay inside the checked range')

    def test_lines_grow_then_finalize_on_both_tracks(self):
        session = self.call(self.audio((2, 1), (2, 0), (1, 1), (2, 0)), [('mic-0.wav', 0, self.audio((1, 0), (1.5, 1), (2, 0)))])
        result = self.run_stream(session)
        self.assertTrue(result['complete'])
        lines = self.segments()
        self.assertEqual([(s['source'], len(s['text'].split()), s['finalized']) for s in lines],
                         # one word per loud 100 ms, plus the first quiet frame, which the decimator's context smears
                         [('other_audio', 21, True), ('you', 16, True), ('other_audio', 11, True)])
        self.assertEqual([s['start_ms'] for s in lines], [0, 1000, 4000])
        # a line's boundary is where it was finalized: 1 s of quiet after its last word
        self.assertEqual(self.checkpoint()['boundaries'], {'system.wav': int(6.1 * 48000), 'mic-0.wav': int(3.6 * 48000)})
        saved = json.loads((self.output / 'transcript.json').read_text())
        self.assertEqual((saved['complete'], [e['id'] for e in saved['entries']], [e['source'] for e in saved['entries']]),
                         (True, [1, 2, 3], ['system', 'mic', 'system']))

    def test_step_journal_keeps_every_line_event_and_each_feed_send_and_ack(self):
        # Observatory contract: line events before throttling, feed send before ack, contiguous seq; a restart is linked.
        session = self.call(self.audio((2, 1), (1.5, 0), (2, 1), (1.5, 0), (2, 1), (2, 0)), [('mic-0.wav', 0, self.audio((11, 0)))])
        self.run_stream(session, mode='crash_once:120')  # after the first line is final, so there is a point to resume from
        rows = [json.loads(l) for l in (self.output / 'worker-journal.jsonl').read_text().splitlines()]
        self.assertEqual([r['seq'] for r in rows], list(range(1, len(rows) + 1)))
        engines = [r for r in rows if r['kind'] == 'engine']
        self.assertEqual([e['event'] for e in engines], ['ready', 'failure', 'ready'])
        self.assertEqual(engines[0]['resume'], {})
        self.assertTrue(engines[2]['resume'])  # the restart resumed from the checkpoint
        finals = {r['line'] for r in rows if r['kind'] == 'line' and r['stage'] == 'final'}
        self.assertEqual(finals, {s['id'] for s in self.segments()})
        guesses = [r for r in rows if r['kind'] == 'line' and r['stage'] == 'guess']
        published = {u['text'] for r in rows if r['kind'] == 'feed' and r['event'] == 'send' for u in r['upserts'] if not u['finalized']}
        self.assertGreaterEqual(len({g['text'] for g in guesses}), len(published))  # nothing published that was not journalled
        sends = [r['sequence'] for r in rows if r['kind'] == 'feed' and r['event'] == 'send']
        acks = [r['sequence'] for r in rows if r['kind'] == 'feed' and r['event'] == 'ack']
        self.assertEqual(sends, acks)

    def test_a_reply_taken_when_a_deadline_gives_up_is_kept_for_the_fallback_drain(self):
        import queue
        engine = object.__new__(w.StreamEngine)
        engine.queue, engine.events, engine.held = queue, queue.Queue(), None
        engine.waiting = {1: 0.0}  # a flush that is already overdue
        flushed = {'event': 'flushed', 'track': 'mic', 'id': 2}
        engine.events.put(flushed)
        with self.assertRaises(w.StreamFallback):
            engine.next()
        self.assertIs(engine.held, flushed, 'a mic reset marker must reach the drain, or its lines land in the old file')

    def test_mic_moves_to_its_next_file_with_a_reset(self):
        session = self.call(self.audio((9, 0)), [('mic-0.wav', 0, self.audio((1, 1), (.5, 0))),
                                                 ('mic-1.wav', 5000, self.audio((1, 1), (1.5, 0)))])
        self.run_stream(session)
        mic = [s for s in self.segments() if s['source'] == 'you']
        self.assertEqual([(s['start_ms'], len(s['text'].split())) for s in mic], [(0, 11), (5000, 11)])
        commands = self.log.read_text().split('\n')
        self.assertEqual(sum(c.startswith('3 mic') for c in commands), 2)  # one reset per mic file
        self.assertIn('2 mic', ' '.join(commands))  # the yielded file's open line was flushed

    def test_one_crash_resumes_from_the_checkpoint_without_losing_or_repeating_lines(self):
        session = self.call(self.audio((2, 1), (1.5, 0), (2, 1), (1.5, 0), (2, 1), (2, 0)), [('mic-0.wav', 0, self.audio((11, 0)))])
        self.run_stream(session, mode='crash_once:60')
        self.assertEqual(self.checkpoint()['failures'], 1)
        lines = [s for s in self.segments() if s['source'] == 'other_audio']
        self.assertEqual([(s['start_ms'], len(s['text'].split()), s['finalized']) for s in lines], [(0, 21, True), (3500, 21, True), (7000, 21, True)])
        self.assertEqual(len({s['id'] for s in self.checkpoint()['finals']}), len(self.checkpoint()['finals']))

    def test_restart_drops_open_lines_and_keeps_checkpointed_finals(self):
        session = self.call(self.audio((2, 1), (2, 0)), [('mic-0.wav', 0, self.audio((4, 0)))])
        feed = w.LocalTranscriptFeed(self.target, self.binding, self.output)
        stale = {'id': 'asr-stale', 'source': 'you', 'start_ms': 0, 'end_ms': 10, 'text': 'half a', 'finalized': False}
        feed.publish([stale], {}, history=False)
        self.run_stream(session)
        self.assertNotIn('asr-stale', [s['id'] for s in self.segments()])
        self.assertEqual(len(self.segments()), 1)

    def test_second_failure_falls_back_for_good(self):
        session = self.call(self.audio((3, 1), (2, 0)), [('mic-0.wav', 0, self.audio((5, 0)))])
        with self.assertRaises(w.StreamFallback):
            self.run_stream(session, mode='crash:5')
        self.assertEqual((self.checkpoint()['failures'], self.checkpoint()['fallback']), (2, 'speech engine exited'))
        with self.assertRaises(w.StreamFallback):  # a respawned worker does not try again
            self.run_stream(session)

    def test_hang_and_malformed_output_fall_back(self):
        import time
        session = self.call(self.audio((3, 1), (2, 0)), [('mic-0.wav', 0, self.audio((5, 0)))])
        started = time.monotonic()
        with self.assertRaises(w.StreamFallback) as hang:
            self.run_stream(session, mode='hang:3')
        self.assertLess(time.monotonic() - started, 15)
        self.assertIn('stopped', str(hang.exception))
        (self.output / 'stream-checkpoint.json').unlink()
        with self.assertRaises(w.StreamFallback) as garbage:
            self.run_stream(session, mode='garbage:3')
        self.assertIn('malformed', str(garbage.exception))

    def test_missing_or_invalid_configuration_uses_whisper(self):
        session = self.call(self.audio((1, 0)), [('mic-0.wav', 0, self.audio((1, 0)))])
        for runtime in ({}, {'stream_asr': 'relative', 'stream_models': str(self.models)}, {'stream_asr': str(self.fake), 'stream_models': str(self.output)}):
            self.assertIsNone(w.stream_config(runtime))
        with self.assertRaises(w.StreamFallback):
            self.run_stream(session, runtime={})
        self.assertEqual(self.checkpoint()['fallback'], 'live speech engine not configured')

    def test_unlaunchable_engine_and_incomplete_lines_fall_back(self):
        session = self.call(self.audio((3, 1), (2, 0)), [('mic-0.wav', 0, self.audio((5, 0)))])
        broken = self.output / 'not-a-program'
        broken.write_text('this is not an executable format'); broken.chmod(0o755)
        with self.assertRaises(w.StreamFallback):
            self.run_stream(session, runtime={'stream_asr': str(broken), 'stream_models': str(self.models)})
        self.assertEqual(self.checkpoint()['fallback'], 'speech engine could not be launched')
        (self.output / 'stream-checkpoint.json').unlink()
        for mode in ('badfield:3', 'badtrack:3', 'badpong:3', 'farend:3'):
            if (self.output / 'stream-checkpoint.json').exists():
                (self.output / 'stream-checkpoint.json').unlink()
            with self.assertRaises(w.StreamFallback, msg=mode) as bad:
                self.run_stream(session, mode=mode)
            self.assertIn('malformed', str(bad.exception))
            # genuine lines finished before the bad one may be kept; nothing past the real audio (5 s) is trusted
            self.assertTrue(all(v <= 5 * 48000 for v in self.checkpoint()['boundaries'].values()), mode)

    def test_positions_are_bounded_by_the_current_mic_file(self):
        # mic-0 is 3 s, mic-1 1 s: after the reset, a final claiming 3 s of mic-1 audio must not be trusted
        # (4 s of mic audio was sent in all, so a bound across files would let it through).
        session = self.call(self.audio((9, 0)), [('mic-0.wav', 0, self.audio((3, 0))), ('mic-1.wav', 5000, self.audio((1, 0)))])
        with self.assertRaises(w.StreamFallback) as bad:
            self.run_stream(session, mode='nextfile')
        self.assertIn('malformed', str(bad.exception))
        self.assertNotIn('mic-1.wav', self.checkpoint()['boundaries'])

    def test_whisper_fallback_resumes_after_the_streamed_lines(self):
        import numpy as np
        session = self.call(self.audio((30, 0)), [('mic-0.wav', 0, self.audio((30, 0)))])
        job = {'session': session, 'echo_cleaning': False}
        windows = [(name, start) for _, name, _, _, start, _, _ in w.growing_tasks(self.calls, job, {}, {'system.wav': 20 * 48000, 'mic-0.wav': 30 * 48000})]
        self.assertEqual([start / 48000 for name, start in windows if name == 'system.wav'], [20, 27])  # from the boundary, no overlap
        self.assertEqual([n for n, _ in windows if n == 'mic-0.wav'], [])  # a fully streamed file is not transcribed again
        feed = w.LocalTranscriptFeed(self.target, self.binding, self.output)
        kept = w.stream_entry({'id': 'asr-kept', 'source': 'you', 'start_ms': 0, 'end_ms': 900, 'text': 'streamed before the fallback', 'finalized': True})
        feed({'complete': False, 'entries': [kept, {'id': 1, 'source': 'system', 'track': 'system.wav', 'chunk': 0, 'start_ms': 21000, 'end_ms': 22000, 'text': 'whisper after it'}]})
        self.assertEqual([(s['id'], s['text']) for s in self.segments()][0], ('asr-kept', 'streamed before the fallback'))
        self.assertEqual(len(self.segments()), 2)

    def test_fallback_transcript_keeps_the_streamed_lines(self):
        import numpy as np
        from scipy.io import wavfile
        root = self.output / 'silent'; root.mkdir()
        wavfile.write(root / 'system.wav', 16000, np.zeros(16000 * 5, dtype=np.float32))
        job = {'recording_key': 'fixture', 'runtime': {'asr_model': 'unused'}, 'session': {'system': {'samples': 16000 * 5, 'sample_rate': 16000}, 'mic_segments': []}}
        row = {'id': 'asr-kept', 'source': 'other_audio', 'start_ms': 100, 'end_ms': 900, 'text': 'said before the fallback', 'finalized': True}
        saved = w.transcribe(root, job, lambda *a: None, streamed=[row])
        self.assertTrue(saved['complete'])
        self.assertEqual([(e['id'], e['source'], e['text'], e['stream_id']) for e in saved['entries']], [(1, 'system', 'said before the fallback', 'asr-kept')])

    def test_wav_cursor_counts_whole_frames_and_never_moves_back(self):
        import struct
        path = self.output / 'growing.wav'
        def write(data_frames, extra=b'', declared=None, kind=0xFFFE):
            fmt = struct.pack('<HHIIHH', kind, 1, 48000, 192000, 4, 32) + (struct.pack('<HHIH', 22, 32, 0, 3) + b'\0' * 14 if kind == 0xFFFE else b'')
            data = b'\0' * (4 * data_frames) + extra
            size = len(data) if declared is None else declared
            path.write_bytes(b'RIFF' + struct.pack('<I', 4 + 8 + len(fmt) + 8 + size) + b'WAVE' + b'fmt ' + struct.pack('<I', len(fmt)) + fmt + b'data' + struct.pack('<I', size) + data)
        cursor = w.WavCursor(path)
        write(100, declared=0)  # header not yet updated: the file size counts
        self.assertEqual(cursor.poll(), 100)
        write(150, extra=b'\1\2')  # half-written frame
        self.assertEqual(cursor.poll(), 150)
        write(120)  # a shorter read never moves the cursor back
        self.assertEqual(cursor.poll(), 150)
        path.write_bytes(b'RIFF')  # header mid-write
        self.assertEqual(cursor.poll(), 150)
        self.assertEqual(w.WavCursor(path).poll(), 0)
        write(10, kind=1)  # 16-bit PCM is not what capture writes
        self.assertEqual(w.WavCursor(path).poll(), 0)


if __name__ == '__main__': unittest.main()
