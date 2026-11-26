import concurrent.futures
import copy
import json
import sqlite3
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import bridge


class QuestionsTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.folder = Path(self.temp.name)
        self.initial = bridge.initial("meeting-" + "1" * 32)
        bridge.save(self.folder / "state.json", self.initial)

    def command(self, name, value=None):
        return bridge.mutate(self.folder, name, value or {}, self.initial["run_id"])

    def start(self):
        return self.command("controls", {"sharing": True, "proactive": False})

    def ask(self):
        return self.command("ask", {"question": "What date is agreed?"})

    def reply(self, event, **changes):
        return self.command("reply", {"event_id": event["event_id"], "text": "Friday, conditional on accessibility.", "sources": ["v1-1"], **changes})

    def test_question_follow_up_and_sources(self):
        with self.assertRaises(ValueError): self.ask()
        self.start();self.ask()
        with self.assertRaises(ValueError): self.ask()
        event = bridge.wait(self.folder, self.initial["run_id"], .05)
        self.assertEqual(event["question_id"], 1)
        with self.assertRaises(ValueError): self.reply(event, sources=["invented"])
        self.assertEqual(self.reply(event)["status"], "published")
        with self.assertRaises(ValueError): self.reply(event)
        self.ask(); event2 = bridge.wait(self.folder, self.initial["run_id"], .05)
        self.assertEqual(event2["question_id"], 2)
        self.assertEqual(event2["recent_answers"][0]["event_id"], "q1")

    def test_quiet_revision_and_outdated_answer(self):
        self.start();self.ask();event = bridge.wait(self.folder, self.initial["run_id"], .05)
        self.command("update", {"sources": [{"id":"v2-1","text":"Now Monday; review passed"}]})
        self.assertEqual(self.reply(event)["status"], "outdated")
        self.assertEqual(bridge.wait(self.folder, self.initial["run_id"], .01)["status"], "timeout")
        self.ask();new = bridge.wait(self.folder, self.initial["run_id"], .05)
        self.assertEqual(new["version"], 2)
        self.assertIn("Monday", new["transcript"]["sources"][0]["text"])

    def test_stop_gate_and_cannot_restart(self):
        self.start();self.ask();event = bridge.wait(self.folder, self.initial["run_id"], .05)
        self.command("stop")
        self.assertEqual(self.reply(event)["status"], "disabled")
        self.assertEqual(bridge.wait(self.folder, self.initial["run_id"], .01), {"status":"disabled"})
        self.assertEqual(self.command("snapshot")["replies"], [])
        with self.assertRaises(ValueError): self.start()

    def test_pointer_toggle_and_quiet_frequency(self):
        self.start()
        self.command("controls", {"sharing":True,"proactive":True})
        event = bridge.wait(self.folder, self.initial["run_id"], .05)
        self.command("controls", {"sharing":True,"proactive":False})
        self.assertEqual(self.reply(event)["status"], "suppressed")
        self.command("update", {"sources":[{"id":"v2-1","text":"A fictional conflicting draft"}]})
        self.command("controls", {"sharing":True,"proactive":True})
        event = bridge.wait(self.folder, self.initial["run_id"],.05)
        self.reply(event,sources=["v2-1"])
        self.command("update", {"sources":[{"id":"v3-1","text":"Another conflicting draft"}]})
        self.assertEqual(bridge.wait(self.folder, self.initial["run_id"],.01)["status"], "timeout")

    def test_expiry_and_parent_brief(self):
        self.start();self.ask();bridge.wait(self.folder, self.initial["run_id"],.01)
        deadline=self.command("snapshot")["deadline_ms"]
        self.command("brief", {"text":"Keep answers brief", "source":"conversation", "marker":"fictional-context"})
        with self.assertRaises(ValueError): self.command("brief", {"text":"Second", "source":"conversation", "marker":"again"})
        with patch.object(bridge, "now", return_value=deadline+1):
            self.assertEqual(bridge.wait(self.folder, self.initial["run_id"],.01)["status"], "expired")
            self.assertFalse(self.command("snapshot")["sharing"])
            with self.assertRaises(ValueError): self.start()
        self.assertEqual(self.command("snapshot")["deadline_ms"], deadline)

    def test_waiting_for_setup_does_not_consume_active_time(self):
        with patch.object(bridge,"now",return_value=1000000):
            armed=self.start()
        self.assertIsNone(armed["deadline_ms"])
        with patch.object(bridge,"now",return_value=1600000):
            self.assertEqual(self.command("snapshot")["status"], "waiting")
            self.ask();bridge.wait(self.folder, self.initial["run_id"],.01)
            active=self.command("snapshot")
            self.assertEqual(active["deadline_ms"], 1600000+480000)
            self.command("controls",{"sharing":True,"proactive":True})
            self.assertEqual(self.command("snapshot")["deadline_ms"],active["deadline_ms"])

    def test_startup_deadline_cannot_be_extended_or_revived(self):
        armed=self.start()
        with patch.object(bridge,"now",return_value=armed["startup_deadline_ms"]+1):
            self.assertEqual(bridge.wait(self.folder, self.initial["run_id"],.01)["status"],"expired")
            with self.assertRaises(ValueError):self.start()
            self.assertFalse(bridge.read(self.folder/'state.json')["worker_ready"])

    def test_concurrent_asks_have_one_pending_request(self):
        self.start()
        def attempt(_):
            try: self.ask();return True
            except ValueError: return False
        with concurrent.futures.ThreadPoolExecutor(2) as pool:
            results=list(pool.map(attempt, range(2)))
        self.assertEqual(sum(results), 1)
        self.assertEqual(len(self.command("snapshot")["questions"]), 1)

    def test_oversized_and_linked_state_rejected(self):
        p=self.folder/'state.json'
        p.write_bytes(b'x'*65537)
        with self.assertRaises(ValueError):self.command('snapshot')
        p.unlink();p.symlink_to(self.folder/'missing-state.json')
        with self.assertRaises(OSError):self.command('snapshot')



class RegistryTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def call(self, command, run=None, value=None):
        return bridge.dispatch(self.root, command, value or {}, run)

    def create(self):
        return self.call("create")["run_id"]

    def test_switch_cancels_old_pending_question_and_separates_consent(self):
        a = self.create()
        self.call("controls", a, {"sharing":True, "proactive":True})
        self.call("ask", a, {"question":"Fictional A?"})
        b = self.create()
        old = self.call("snapshot", a)
        self.assertEqual(old["status"], "disabled")
        self.assertEqual(old["questions"][0]["status"], "cancelled")
        fresh = self.call("current")
        self.assertEqual(fresh["run_id"], b)
        self.assertFalse(fresh["sharing"] or fresh["proactive"])
        self.assertEqual(fresh["questions"], [])
        with self.assertRaises(ValueError):self.call("stop", a)
        with self.assertRaises(ValueError):self.call("controls", a, {"sharing":True, "proactive":False})
        self.assertEqual(self.call("current")["run_id"], b)

    def test_worker_with_wrong_identity_cannot_read_or_publish_other_meeting(self):
        a = self.create();b = self.create()
        self.call("controls", b, {"sharing":True, "proactive":False})
        self.call("ask", b, {"question":"Fictional B?"})
        with self.assertRaises(ValueError):bridge.wait(self.root/b, a, .01)
        with self.assertRaises(ValueError):bridge.mutate(self.root/b, "reply", {"event_id":"q1","text":"Wrong meeting","sources":["v1-1"]}, a)
        self.assertEqual(self.call("current")["replies"], [])

    def test_handoff_is_scoped_and_requires_current_consent(self):
        a = self.create()
        with self.assertRaises(ValueError): self.call("handoff", a)
        self.call("controls", a, {"sharing":True,"proactive":False})
        prompt = self.call("handoff", a)["prompt"]
        self.assertIn(str(self.root/a), prompt)
        self.assertIn(f"wait {self.root/a} {a}", prompt)
        self.assertIn("Maximum eight waits and six events", prompt)
        b = self.create()
        with self.assertRaises(ValueError):self.call("handoff", a)
        with self.assertRaises(ValueError):self.call("handoff", b)

    def test_restart_recovery_never_resumes_consent(self):
        a = self.create();self.call("controls", a, {"sharing":True, "proactive":True})
        self.call("recover")
        self.assertEqual(bridge.wait(self.root/a,a,.01)["status"], "disabled")
        with self.assertRaises(ValueError):self.call("current")
        b = self.create();self.assertNotEqual(a,b)
        self.assertFalse(self.call("current")["sharing"])

    def test_unknown_and_linked_paths_fail_closed(self):
        a = self.create()
        with self.assertRaises(ValueError):self.call("snapshot", "../../outside")
        target = self.root/a
        moved = self.root/"original";target.rename(moved);target.symlink_to(moved)
        with self.assertRaises(ValueError):self.call("snapshot", a)

    def test_fifo_state_does_not_block(self):
        import os,time
        a=self.create();p=self.root/a/"state.json";p.unlink();os.mkfifo(p)
        start=time.monotonic()
        with self.assertRaises(ValueError):self.call("snapshot",a)
        self.assertLess(time.monotonic()-start,.2)

    def test_parallel_creation_has_one_active_owner(self):
        with concurrent.futures.ThreadPoolExecutor(2) as pool:
            ids=list(pool.map(lambda _:self.create(),range(2)))
        self.assertEqual(len(set(ids)),2)
        registry=bridge.read(self.root/"registry.json")
        self.assertIn(registry["active"],ids)
        self.assertEqual(sum(self.call("snapshot",r)["status"]=="off" for r in ids),1)

    def test_catalog_grows_past_json_limit_and_keeps_old_sessions(self):
        ids=[self.create() for _ in range(512)]
        self.assertEqual(len(bridge.read(self.root/'registry.json')['sessions']),32)
        self.assertLess((self.root/'registry.json').stat().st_size,2048)
        self.assertGreater((self.root/'sessions.sqlite3').stat().st_size,bridge.LIMIT)
        self.assertEqual(self.call('snapshot',ids[0])['run_id'],ids[0])
        self.assertEqual(self.call('current')['run_id'],ids[-1])
        self.call('recover')
        self.assertEqual(self.call('snapshot',ids[0])['run_id'],ids[0])
        newest=self.create()
        self.assertNotIn(newest,ids)

    def test_failed_catalog_registration_keeps_current_consent(self):
        active=self.create()
        self.call('controls',active,{'sharing':True,'proactive':True})
        before=(self.root/active/'state.json').read_bytes()
        pointer=(self.root/'registry.json').read_bytes()
        with patch.object(bridge.SessionRegistry,'register',side_effect=sqlite3.OperationalError('synthetic full disk')):
            with self.assertRaises(ValueError):self.create()
        self.assertEqual((self.root/active/'state.json').read_bytes(),before)
        self.assertEqual((self.root/'registry.json').read_bytes(),pointer)
        self.assertTrue(self.call('current')['sharing'])

    def batches(self):
        return json.loads(Path(__file__).with_name("fictional_stream.json").read_text())["batches"]

    def test_incremental_append_correction_retry_and_local_only_gate(self):
        run=self.create();one,two=self.batches()
        first=self.call("transcript",run,one)
        self.assertEqual((first["feed_sequence"],first["version"]),(1,2))
        self.assertEqual(bridge.wait(self.root/run,run,.01),{"status":"off"})
        self.assertFalse((self.root/run/"ready.json").exists())
        before=(self.root/run/"state.json").read_bytes()
        self.assertEqual(self.call("transcript",run,one),first)
        self.assertEqual((self.root/run/"state.json").read_bytes(),before)
        latest=self.call("transcript",run,two)
        self.assertEqual((latest["feed_sequence"],latest["version"]),(2,3))
        state=bridge.read(self.root/run/"state.json");sources=state["transcripts"][-1]["sources"]
        self.assertEqual(len([s for s in sources if s["id"]=="t-review"]),1)
        self.assertIn("It passed",next(s["text"] for s in sources if s["id"]=="t-review"))
        self.assertIn("t-launch",[s["id"] for s in sources])
        self.assertEqual(len(state["transcripts"]),2)
        unchanged={**two,"sequence":3,"base_version":3}
        self.assertEqual(self.call("transcript",run,unchanged)["version"],3)

    def test_invalid_batches_are_atomic_and_retries_cannot_change_payload(self):
        run=self.create();one,two=self.batches();self.call("transcript",run,one)
        invalid=[]
        for edits in ({"sequence":3},{"base_version":1},{"sequence":True},{"extra":1}):
            invalid.append({**two,**edits})
        for edits in ({"finalized":"yes"},{"source":"unknown"},{"source":"you"},{"start_ms":-1},{"end_ms":True},{"text":" "},{"text":"x"*1001},{"id":"../../elsewhere"}):
            altered=copy.deepcopy(two);altered["segments"][0].update(edits);invalid.append(altered)
        duplicate=copy.deepcopy(two);duplicate["segments"]*=2;invalid.append(duplicate)
        retry=copy.deepcopy(one);retry["segments"][0]["text"]="Conflicting retry";invalid.append(retry)
        before=(self.root/run/"state.json").read_bytes()
        for batch in invalid:
            with self.assertRaises(ValueError):self.call("transcript",run,batch)
            self.assertEqual((self.root/run/"state.json").read_bytes(),before)

    def test_revised_transcript_rejects_in_flight_answer_and_uses_new_sources(self):
        run=self.create();one,two=self.batches();self.call("transcript",run,one)
        self.call("controls",run,{"sharing":True,"proactive":False})
        self.call("ask",run,{"question":"What blocks launch?"});old=bridge.wait(self.root/run,run,.01)
        self.call("transcript",run,two)
        reply={"event_id":old["event_id"],"text":"The review has not passed.","sources":["t-review"]}
        self.assertEqual(bridge.mutate(self.root/run,"reply",reply,run)["status"],"outdated")
        new=bridge.wait(self.root/run,run,.01)
        self.assertEqual(new["question_id"],old["question_id"])
        self.assertNotEqual(new["event_id"],old["event_id"])
        self.assertEqual(len(self.call("snapshot",run)["questions"]),1)
        self.assertEqual(new["version"],3)
        self.assertIn("It passed",next(s["text"] for s in new["transcript"]["sources"] if s["id"]=="t-review"))
        reply.update(event_id=new["event_id"],text="The review passed.")
        self.assertEqual(bridge.mutate(self.root/run,"reply",reply,run)["status"],"published")

    def test_old_displayed_answers_are_archived_instead_of_presented_as_current(self):
        run=self.create();one,two=self.batches();self.call("transcript",run,one)
        self.call("controls",run,{"sharing":True,"proactive":False});self.call("ask",run,{"question":"Blocker?"})
        event=bridge.wait(self.root/run,run,.01)
        bridge.mutate(self.root/run,"reply",{"event_id":event["event_id"],"text":"The review is pending.","sources":["t-review"]},run)
        self.assertEqual(len(self.call("snapshot",run)["replies"]),1)
        self.call("transcript",run,two)
        self.assertEqual(self.call("snapshot",run)["replies"],[])
        self.assertEqual(len(bridge.read(self.root/run/"state.json")["replies"]),1)

    def test_incremental_pointers_reject_old_revision_and_respect_off(self):
        run=self.create();one,two=self.batches();self.call("transcript",run,one)
        self.call("controls",run,{"sharing":True,"proactive":True})
        old=bridge.wait(self.root/run,run,.01);self.call("transcript",run,two)
        reply={"event_id":old["event_id"],"text":"Review is pending.","sources":["t-review"]}
        self.assertEqual(bridge.mutate(self.root/run,"reply",reply,run)["status"],"outdated")
        new=bridge.wait(self.root/run,run,.01);self.assertEqual(new["version"],3)
        self.call("controls",run,{"sharing":True,"proactive":False})
        reply.update(event_id=new["event_id"],text="The draft needs correction.",sources=["t-draft"])
        self.assertEqual(bridge.mutate(self.root/run,"reply",reply,run)["status"],"suppressed")
        self.assertEqual(self.call("snapshot",run)["replies"],[])

    def test_stop_and_switch_freeze_old_feed(self):
        run=self.create();one,two=self.batches();self.call("transcript",run,one)
        self.call("stop",run);before=(self.root/run/"state.json").read_bytes()
        with self.assertRaises(ValueError):self.call("transcript",run,two)
        self.assertEqual((self.root/run/"state.json").read_bytes(),before)
        new=self.create()
        with self.assertRaises(ValueError):self.call("transcript",run,two)
        self.assertEqual(self.call("snapshot",new)["feed_sequence"],0)

    def test_local_only_binding_blocks_every_assistant_route(self):
        run=self.call("create_local",value={"call_id":"saved-call","recording_key":"a"*64})["run_id"]
        state=bridge.read(self.root/run/"state.json")
        self.assertTrue(state["local_only"])
        self.assertEqual(state["transcripts"][0]["sources"],[])
        self.call("transcript",run,self.batches()[0])
        before=(self.root/run/"state.json").read_bytes()
        for command,value in [("controls",{"sharing":True,"proactive":True}),("ask",{"question":"Read private text"}),("handoff",{}),("brief",{}),("reply",{}),("update",{})]:
            with self.assertRaises(ValueError):
                if command in ("brief","reply","update"):bridge.mutate(self.root/run,command,value,run)
                else:self.call(command,run,value)
        self.assertEqual(bridge.wait(self.root/run,run,.01),{"status":"local_only"})
        self.assertFalse((self.root/run/"ready.json").exists())
        self.assertEqual((self.root/run/"state.json").read_bytes(),before)

    def test_withdrawal_reconciles_refinement_and_is_idempotent(self):
        run=self.create();self.call("transcript",run,self.batches()[0])
        remove={"sequence":2,"base_version":2,"segments":[],"remove_ids":["review"]}
        ack=self.call("transcript",run,remove);self.assertEqual(self.call("transcript",run,remove),ack)
        current=bridge.read(self.root/run/"state.json")
        self.assertEqual([s["id"] for s in current["feed"]["segments"]],["launch"])
        before=(self.root/run/"state.json").read_bytes()
        with self.assertRaises(ValueError):self.call("transcript",run,{**remove,"sequence":3,"base_version":3})
        self.assertEqual((self.root/run/"state.json").read_bytes(),before)

    def test_parallel_retry_is_applied_once(self):
        run=self.create();one=self.batches()[0]
        with concurrent.futures.ThreadPoolExecutor(2) as pool:
            snapshots=list(pool.map(lambda _:self.call("transcript",run,one),range(2)))
        self.assertEqual([s["version"] for s in snapshots],[2,2])
        self.assertEqual(len(bridge.read(self.root/run/"state.json")["feed"]["segments"]),2)

    def test_context_and_sequence_caps_preserve_last_good_state(self):
        run=self.create();sequence=1
        for _ in range(8):
            current=self.call("snapshot",run);before=(self.root/run/"state.json").read_bytes()
            segments=[{"id":f"s{sequence}-{i}","source":"you","start_ms":sequence*1000+i,"end_ms":sequence*1000+i+1,"text":"x"*900,"finalized":True} for i in range(4)]
            batch={"sequence":sequence,"base_version":current["version"],"segments":segments}
            try:self.call("transcript",run,batch)
            except ValueError:
                self.assertEqual((self.root/run/"state.json").read_bytes(),before);break
            sequence+=1
        else:self.fail("Context cap was not enforced")
        with self.assertRaises(ValueError):self.call("transcript",run,{**batch,"sequence":25})
        fresh=self.create();one=self.batches()[0];self.call("transcript",fresh,one)
        for seq in range(2,25):
            self.assertEqual(self.call("transcript",fresh,{**one,"sequence":seq,"base_version":2})["version"],2)
        before=(self.root/fresh/"state.json").read_bytes()
        with self.assertRaises(ValueError):self.call("transcript",fresh,{**one,"sequence":25,"base_version":2})
        self.assertEqual((self.root/fresh/"state.json").read_bytes(),before)

class CatalogTest(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.data=Path(self.temp.name);self.root=self.data/'assistie';self.root.mkdir()
        self.call=self.data/'calls/fictional-catalog-25';self.call.mkdir(parents=True)
        bridge.save(self.call/'session.json',{'id':self.call.name,'active':False,'notes':'Fictional notes must survive'})
        self.ids=['meeting-'+f'{index:032x}' for index in range(32)]
        for index,run in enumerate(self.ids):
            folder=self.root/run;folder.mkdir()
            state=bridge.initial(run)
            state.update(ended=True,call_binding={'call_id':self.call.name},questions=[{'id':1,'text':f'Fictional question {index}','version':1,'status':'answered'}],
                replies=[{'event_id':'q1','question_id':1,'kind':'answer','version':1,'snapshot_at_ms':index+1,'text':f'Fictional answer {index}',
                          'quotes':[{'id':'v1-1','text':f'Original fictional quote {index}'}]}])
            bridge.save(folder/'state.json',state)
        bridge.save(self.root/'registry.json',{'active':None,'sessions':self.ids})
        self.before={p:p.read_bytes() for p in self.data.rglob('*.json')}

    def history(self,offset=0):
        return bridge.dispatch(self.root,'call_history',{'call_id':self.call.name,'offset':offset})

    def assert_content_unchanged(self):
        for path,original in self.before.items():
            if path.name!='registry.json':self.assertEqual(path.read_bytes(),original)

    def test_migrate_legacy_grow_and_reopen_all_original_answers(self):
        page=self.history();self.assertIn('Fictional answer 31',json.dumps(page))
        self.assertEqual((self.root/'registry.json').read_bytes(),self.before[self.root/'registry.json'])
        ids=[bridge.dispatch(self.root,'create',{})['run_id'] for _ in range(130)]
        self.assert_content_unchanged()
        self.assertNotIn(self.ids[0],bridge.read(self.root/'registry.json')['sessions'])
        active_before=(self.root/ids[-1]/'state.json').read_bytes()
        original_read=bridge.read
        def only_matching(path,*limit):
            if path.parent.name in ids:self.fail('Unrelated session was read during call history lookup')
            return original_read(path,*limit)
        with patch.object(bridge,'read',side_effect=only_matching):
            oldest=self.history(28)
        self.assertIn('Original fictional quote 0',json.dumps(oldest))
        self.assertEqual((self.root/ids[-1]/'state.json').read_bytes(),active_before)
        bridge.dispatch(self.root,'recover',{})
        self.assertEqual(len(self.history(28)['replies']),4)
        with sqlite3.connect(self.root/'sessions.sqlite3') as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM sessions').fetchone()[0],162)
        self.assert_content_unchanged()

    def test_interrupted_migration_rolls_back_and_retries_without_content_changes(self):
        original_read=bridge.read
        def interrupted(path):
            if path.parent.name==self.ids[1]:raise ValueError('Synthetic migration interruption')
            return original_read(path)
        with patch.object(bridge,'read',side_effect=interrupted):
            with self.assertRaises(ValueError):self.history()
        with sqlite3.connect(self.root/'sessions.sqlite3') as db:
            self.assertEqual(db.execute('PRAGMA user_version').fetchone()[0],0)
        self.assertEqual((self.root/'registry.json').read_bytes(),self.before[self.root/'registry.json'])
        self.assert_content_unchanged()
        self.history();self.history()
        with sqlite3.connect(self.root/'sessions.sqlite3') as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM sessions').fetchone()[0],32)

    def test_catalog_and_journal_links_are_rejected_without_touching_target(self):
        outside=self.data/'outside';outside.write_text('untouched')
        catalog=self.root/'sessions.sqlite3';catalog.symlink_to(outside)
        with self.assertRaises(OSError):self.history()
        catalog.unlink()
        journal=Path(str(catalog)+'-journal');journal.symlink_to(outside)
        with self.assertRaises(ValueError):self.history()
        self.assertEqual(outside.read_text(),'untouched')
        self.assert_content_unchanged()

    def test_unrecognized_catalog_is_preserved_and_never_reinitialized(self):
        path=self.root/'sessions.sqlite3'
        with sqlite3.connect(path) as db:db.execute('CREATE TABLE unrelated (text TEXT)')
        before=path.read_bytes()
        with self.assertRaises(ValueError):self.history()
        self.assertEqual(path.read_bytes(),before)
        self.assert_content_unchanged()

    def test_local_only_store_also_grows_without_unlocking_old_runs(self):
        local=self.data/'assistie-local';local.mkdir()
        ids=[bridge.dispatch(local,'create_local',{'call_id':f'fictional-{i}','recording_key':'a'*64})['run_id'] for i in range(40)]
        self.assertEqual(len(bridge.read(local/'registry.json')['sessions']),32)
        self.assertTrue(bridge.dispatch(local,'snapshot',{},ids[0])['local_only'])
        with self.assertRaises(ValueError):bridge.dispatch(local,'controls',{'sharing':True,'proactive':False},ids[-1])


class CallConsentTest(unittest.TestCase):
    def setUp(self):
        import os
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.data = Path(self.temp.name)
        self.root = self.data / 'assistie'; self.root.mkdir()
        self.local = self.data / 'assistie-local'; self.local.mkdir()
        self.call = self.data / 'calls' / 'fictional-call-21'; self.call.mkdir(parents=True)
        self.pid = os.getpid()
        self.source = bridge.dispatch(self.local, 'create_local', {'call_id': self.call.name, 'recording_key': 'a' * 64})['run_id']
        self.manifest(True)
        bridge.save(self.call / 'live-feed.json', {'run_id': self.source, 'status': 'following', 'local_only': True})
        self.append('Friday only after review')
        self.run = bridge.dispatch(self.root, 'create_call', {'call_id': self.call.name, 'owner_pid': self.pid})['run_id']
        self.folder = self.root / self.run

    def manifest(self, active):
        bridge.save(self.call / 'session.json', {'id': self.call.name, 'active': active, 'notes': 'PRIVATE NOTES NEVER EXPORT'})

    def append(self, text, sid='s1', removals=None, finalized=True):
        state = bridge.read(self.local / self.source / 'state.json')
        bridge.dispatch(self.local, 'transcript', {'sequence': state.get('feed', {}).get('sequence', 0) + 1, 'base_version': state['version'], 'segments': [] if text is None else [{'id': sid, 'source': 'other_audio', 'start_ms': 0, 'end_ms': 1000, 'text': text, 'finalized': finalized}], 'remove_ids': removals or []}, self.source)

    def command(self, name, value=None):
        return bridge.dispatch(self.root, name, value or {}, self.run)

    def consent(self, proactive=False):
        return self.command('controls', {'sharing': True, 'proactive': proactive})

    def ask(self):
        self.command('ask', {'question': 'What is the agreed launch?'})
        return bridge.wait(self.folder, self.run, .05)

    def reply(self, event):
        return bridge.mutate(self.folder, 'reply', {'event_id': event['event_id'], 'text': 'A fictional answer.', 'sources': ['t-s1']}, self.run)

    def test_open_is_empty_and_does_not_read_source_or_grant_consent(self):
        original_read = bridge.read
        def read_without_source(path, *limit):
            if path == self.local / self.source / 'state.json':
                self.fail('Unconsented transcript read')
            return original_read(path, *limit)
        with patch.object(bridge, 'read', side_effect=read_without_source):
            self.assertEqual(self.command('snapshot')['status'], 'off')
            same = bridge.dispatch(self.root, 'create_call', {'call_id': self.call.name, 'owner_pid': self.pid})
        self.assertEqual(same['run_id'], self.run)
        self.assertFalse(same['sharing'])
        self.assertEqual(bridge.read(self.folder / 'state.json')['transcripts'][0]['sources'], [])
        self.assertEqual(bridge.wait(self.folder, self.run, .01), {'status': 'off'})
        with self.assertRaises(ValueError): self.command('handoff')

    def test_current_and_incremental_text_corrections_are_consent_scoped(self):
        source_before = (self.local / self.source / 'state.json').read_bytes()
        allowed = self.consent()
        self.assertEqual(allowed['call_id'], self.call.name)
        event = self.ask()
        self.assertEqual(event['transcript']['sources'][0]['text'], 'Friday only after review')
        self.assertNotIn('PRIVATE NOTES', json.dumps(event))
        self.assertEqual(self.reply(event)['status'], 'published')
        self.assertEqual((self.local / self.source / 'state.json').read_bytes(), source_before)
        self.assertEqual(bridge.wait(self.local / self.source, self.source, .01), {'status': 'local_only'})
        self.append('Monday, review passed')
        historical = self.command('snapshot')['replies'][0]
        self.assertEqual(historical['source_status'], 'revised')
        self.assertEqual(historical['quotes'][0]['text'], 'Friday only after review')
        later = self.ask()
        self.assertEqual(later['recent_answers'], [])
        self.assertEqual(later['transcript']['sources'][0]['id'], 't-s1')
        self.assertIn('Monday', later['transcript']['sources'][0]['text'])
        self.assertGreater(later['version'], event['version'])
        self.assertEqual(self.reply(later)['status'], 'published')
        handoff = self.command('handoff')['prompt']
        self.assertIn('consented live Handy meeting', handoff)
        self.assertNotIn('fictional transcript', handoff)
        with self.assertRaises(ValueError): self.command('transcript', {'sequence': 1})

    def test_completed_answer_survives_window_eviction_and_stop(self):
        self.consent(); event = self.ask()
        self.assertEqual(self.reply(event)['status'], 'published')
        before = self.command('snapshot')['replies'][0]
        self.append(None, removals=['s1'])
        old = self.command('snapshot')['replies'][0]
        self.assertEqual(old['source_status'], 'outside_window')
        for key in ('text', 'quotes', 'snapshot_at_ms', 'version'):
            self.assertEqual(old[key], before[key])
        later = self.ask()
        self.assertEqual(later['recent_answers'], [])
        self.assertEqual(later['transcript']['sources'], [])
        self.assertEqual(len(self.command('snapshot')['replies']), 1)
        stopped = self.command('stop')
        self.assertFalse(stopped['sharing'])
        self.assertEqual(stopped['questions'][-1]['status'], 'cancelled')
        self.assertEqual(stopped['replies'][0], old)
        self.assertEqual(self.reply(later)['status'], 'disabled')

    def test_saved_call_history_reopens_after_recovery_without_sync_or_reconnecting(self):
        self.consent(); event=self.ask(); self.reply(event)
        bridge.dispatch(self.root,'recover',{})
        registry_before=(self.root/'registry.json').read_bytes()
        state_before=(self.folder/'state.json').read_bytes()
        with patch.object(bridge,'sync_call',side_effect=AssertionError('History must not sync')):
            saved=bridge.dispatch(self.root,'call_history',{'call_id':self.call.name,'offset':0})
        self.assertTrue(saved['archive']);self.assertFalse(saved['sharing'])
        self.assertEqual(saved['status'],'disabled')
        self.assertEqual(saved['replies'][0]['quotes'][0]['text'],'Friday only after review')
        self.assertEqual(saved['questions'][0]['text'],'What is the agreed launch?')
        self.assertEqual((self.root/'registry.json').read_bytes(),registry_before)
        self.assertEqual((self.folder/'state.json').read_bytes(),state_before)
        self.assertEqual(bridge.dispatch(self.root,'identity',{}),{'run_id':None})
        self.assertEqual(bridge.dispatch(self.root,'call_history',{'call_id':self.call.name,'offset':4})['replies'],[])
        for bad in ('../elsewhere','missing'):
            with self.assertRaises(ValueError): bridge.dispatch(self.root,'call_history',{'call_id':bad,'offset':0})

    def test_meeting_length_simulates_96_minutes_and_pages_all_64_answers(self):
        start=bridge.now()
        self.consent()
        original_deadline=None
        for index in range(64):
            with patch.object(bridge,'now',return_value=start+index*90000):
                self.append(f'Fictional plan revision {index}')
                event=self.ask()
                self.assertEqual(event['question_id'],index+1)
                self.assertEqual(self.reply(event)['status'],'published')
                state=bridge.read(self.folder/'state.json')
                if original_deadline is None:original_deadline=state['deadline_ms']
                self.assertEqual(state['deadline_ms'],original_deadline)
                self.assertLessEqual(len(state['questions']),4)
                self.assertLessEqual(len(state['replies']),3)
                self.assertLessEqual(len(state['delivered']),6)
                self.assertLess((self.folder/'state.json').stat().st_size,bridge.LIMIT)
        self.assertEqual(original_deadline,start+7200000)
        with patch.object(bridge,'now',return_value=start+64*90000):
            self.assertEqual(bridge.wait(self.folder,self.run,.01)['status'],'timeout')
            snap=self.command('snapshot')
            self.assertTrue(snap['sharing'])
            self.assertEqual(snap['questions_asked'],64)
            with self.assertRaises(ValueError):self.ask()
        with bridge.locked(self.folder,self.run) as state:
            state['worker_seen_ms']=original_deadline
            bridge.save(self.folder/'state.json',state)
        with patch.object(bridge,'now',return_value=original_deadline+1):
            self.assertFalse(self.command('snapshot')['sharing'])
            with self.assertRaises(ValueError):self.command('controls',{'sharing':True,'proactive':False})
        self.command('stop')
        bridge.dispatch(self.root,'recover',{})
        answers=[]
        for offset in range(0,64,4):
            page=bridge.dispatch(self.root,'call_history',{'call_id':self.call.name,'offset':offset})
            self.assertEqual(len(page['replies']),4)
            self.assertEqual(page['history_more'],offset<60)
            self.assertFalse(page['sharing'])
            answers.extend(r['event_id'] for r in page['replies'])
        self.assertEqual(len(set(answers)),64)
        first=bridge.dispatch(self.root,'call_history',{'call_id':self.call.name,'offset':60})
        self.assertIn('Fictional plan revision 0',json.dumps(first))
        self.assertEqual(len(list(self.folder.glob('reply-*.json'))),64)

    def test_worker_heartbeat_expiry_never_rearms_consent(self):
        self.consent();event=self.ask();self.reply(event)
        seen=bridge.read(self.folder/'state.json')['worker_seen_ms']
        with patch.object(bridge,'now',return_value=seen+120001):
            self.assertFalse(self.command('snapshot')['sharing'])
            self.assertEqual(bridge.wait(self.folder,self.run,.01)['status'],'expired')
            with self.assertRaises(ValueError):self.command('controls',{'sharing':True,'proactive':False})
            with self.assertRaises(ValueError):self.ask()

    def test_meeting_wait_cap_and_archive_symlinks_fail_closed(self):
        self.consent();event=self.ask();self.reply(event)
        for index in range(8):
            state=bridge.read(self.folder/'state.json')
            bridge.discard_reply(self.folder,state,{'event_id':f'fictional-{index}','question_id':None},'outdated')
        self.assertEqual(len(bridge.read(self.folder/'state.json')['discarded']),6)
        with bridge.locked(self.folder,self.run) as state:
            state['wait_count']=192;bridge.save(self.folder/'state.json',state)
        self.assertEqual(bridge.wait(self.folder,self.run,.01)['status'],'limit')
        record=self.folder/'reply-000001.json';record.unlink();record.symlink_to(self.local/self.source/'state.json')
        with self.assertRaises(OSError):bridge.dispatch(self.root,'call_history',{'call_id':self.call.name,'offset':0})

    def test_archive_read_preserves_a_different_active_meeting(self):
        self.consent();event=self.ask();self.reply(event)
        fresh=bridge.dispatch(self.root,'create',{})
        bridge.dispatch(self.root,'controls',{'sharing':True,'proactive':False},fresh['run_id'])
        registry=(self.root/'registry.json').read_bytes()
        current=(self.root/fresh['run_id']/'state.json').read_bytes()
        result=bridge.dispatch(self.root,'call_history',{'call_id':self.call.name,'offset':0})
        self.assertEqual(len(result['replies']),1)
        self.assertEqual((self.root/'registry.json').read_bytes(),registry)
        self.assertEqual((self.root/fresh['run_id']/'state.json').read_bytes(),current)

    def test_legacy_invalidated_answer_visible_without_resurrecting_pointer(self):
        self.consent(True); event = self.ask(); self.reply(event)
        pointer = bridge.wait(self.folder, self.run, .05)
        self.assertEqual(self.reply(pointer)['status'], 'published')
        with bridge.locked(self.folder, self.run) as state:
            for reply in state['replies']: reply['invalidated'] = True
            bridge.save(self.folder/'state.json', state)
        replies = self.command('snapshot')['replies']
        self.assertEqual([r['kind'] for r in replies], ['answer'])
        self.assertEqual(replies[0]['source_status'], 'unavailable')

    def test_appended_speech_does_not_restart_inflight_answer(self):
        self.consent(); event = self.ask()
        self.append('A new unrelated statement', sid='s2')
        snap=self.command('snapshot')
        self.assertGreater(snap['version'],event['version'])
        self.assertEqual(snap['questions'][0]['version'],event['version'])
        self.assertEqual(self.reply(event)['status'],'published')
        self.append('More speech after the answer', sid='s3')
        reply=self.command('snapshot')['replies'][0]
        self.assertEqual(reply['version'],event['version'])
        self.assertIsInstance(reply['snapshot_at_ms'],int)
        self.assertEqual(reply['quotes'][0]['text'],'Friday only after review')
        self.assertNotIn('inflight',bridge.read(self.folder/'state.json'))

    def test_new_sources_cannot_be_cited_in_an_earlier_snapshot_reply(self):
        self.consent(); event=self.ask(); self.append('Newer speech', sid='s2')
        with self.assertRaises(ValueError):
            bridge.mutate(self.folder,'reply',{'event_id':event['event_id'],'text':'Not from that snapshot','sources':['t-s2']},self.run)
        self.assertEqual(self.command('snapshot')['replies'],[])

    def test_pointers_off_blocks_a_pinned_reply_and_questions_still_work(self):
        self.consent(True); pointer=bridge.wait(self.folder,self.run,.05)
        self.append('New speech',sid='s2')
        self.command('controls',{'sharing':True,'proactive':False})
        self.assertEqual(self.reply(pointer)['status'],'suppressed')
        event=self.ask();self.append('More new speech',sid='s3')
        self.assertEqual(self.reply(event)['status'],'published')
        self.assertFalse(self.command('snapshot')['proactive'])
        self.assertEqual([r['kind'] for r in self.command('snapshot')['replies']],['answer'])

    def test_one_pinned_event_at_a_time_and_bounded_snapshot_file(self):
        self.consent(True);event=self.ask()
        pin=(self.folder/'inflight.json').read_bytes()
        self.assertLess(len(pin),bridge.LIMIT)
        self.append('More speech',sid='s2')
        self.assertEqual(bridge.wait(self.folder,self.run,.01)['status'],'timeout')
        self.assertEqual((self.folder/'inflight.json').read_bytes(),pin)
        self.assertEqual(len(bridge.read(self.folder/'state.json')['delivered']),1)
        self.assertEqual(self.reply(event)['status'],'published')

    def test_removed_or_rolled_out_cited_source_still_requeues(self):
        self.consent(); event=self.ask()
        self.append(None,removals=['s1'])
        self.assertEqual(self.reply(event)['status'],'outdated')
        self.assertEqual(self.command('snapshot')['replies'],[])
        next_event=bridge.wait(self.folder,self.run,.05)
        self.assertNotEqual(next_event['event_id'],event['event_id'])
        self.assertEqual(next_event['transcript']['sources'],[])

    def test_changed_or_linked_pinned_snapshot_fails_closed(self):
        self.consent(); event=self.ask()
        pin=self.folder/'inflight.json';saved=bridge.read(pin)
        saved['run_id']='meeting-'+'a'*32;bridge.save(pin,saved)
        with self.assertRaises(ValueError):self.reply(event)
        pin.unlink();pin.symlink_to(self.local/self.source/'state.json')
        with self.assertRaises(OSError):self.reply(event)
        self.command('stop')
        self.assertEqual(self.reply(event)['status'],'disabled')

    def test_revision_during_reply_requires_fresh_answer(self):
        self.consent(); event = self.ask()
        self.append('Monday instead of Friday')
        self.assertEqual(self.reply(event)['status'], 'outdated')
        new = bridge.wait(self.folder, self.run, .05)
        self.assertNotEqual(event['event_id'], new['event_id'])
        self.assertEqual(self.reply(new)['status'], 'published')

    def test_off_mid_reply_stops_copy_and_preserves_local_work(self):
        self.consent(True)
        pointer = bridge.wait(self.folder, self.run, .05)
        self.command('controls', {'sharing': True, 'proactive': False})
        self.assertEqual(self.reply(pointer)['status'], 'suppressed')
        self.command('controls', {'sharing': False, 'proactive': False})
        frozen = (self.folder / 'state.json').read_bytes()
        self.append('A later private update')
        self.assertEqual(bridge.wait(self.folder, self.run, .01), {'status': 'disabled'})
        self.assertEqual(self.reply(pointer)['status'], 'disabled')
        self.assertEqual((self.folder / 'state.json').read_bytes(), frozen)
        self.assertFalse(bridge.read(self.local / self.source / 'state.json')['ended'])
        with self.assertRaises(ValueError): self.consent()

    def test_stop_recording_or_switch_source_fails_closed(self):
        self.consent(); event = self.ask(); self.manifest(False)
        self.assertEqual(self.reply(event)['status'], 'disabled')
        self.assertTrue(self.command('snapshot')['feed_error'])
        self.assertFalse(self.command('snapshot')['sharing'])

    def test_revocation_identity_check_never_refreshes_transcript(self):
        self.consent()
        original_read = bridge.read
        def read_without_source(path):
            if path == self.local / self.source / 'state.json':
                self.fail('Revocation read fresh transcript text')
            return original_read(path)
        with patch.object(bridge, 'read', side_effect=read_without_source):
            self.assertEqual(bridge.dispatch(self.root, 'identity', {})['run_id'], self.run)
            self.command('controls', {'sharing': False, 'proactive': False})

    def test_native_stop_is_call_scoped_and_does_not_end_local_asr(self):
        self.consent(); event = self.ask()
        ignored = bridge.dispatch(self.root, 'stop_call', {'call_id': 'another-call'})
        self.assertEqual(ignored['status'], 'no_matching_call')
        self.assertTrue(self.command('snapshot')['sharing'])
        result = bridge.dispatch(self.root, 'stop_call', {'call_id': self.call.name})
        self.assertEqual(result['status'], 'disabled')
        self.assertEqual(self.reply(event)['status'], 'disabled')
        self.assertFalse(bridge.read(self.local / self.source / 'state.json')['ended'])

    def test_missing_capture_heartbeat_stops_before_answer(self):
        import os, time
        self.consent(); event = self.ask()
        os.utime(self.call / 'session.json', (time.time() - 11, time.time() - 11))
        self.assertEqual(self.reply(event)['status'], 'disabled')

    def hold(self, opener, seconds=1.3):
        """Hold a local store lock from another thread, as a recorder under load did on 2026-10-28."""
        import threading, time
        held = threading.Event()
        def run():
            with opener():
                held.set()
                time.sleep(seconds)
        thread = threading.Thread(target=run)
        thread.start()
        held.wait(2)
        return thread

    def hold_catalog(self):
        import contextlib, sqlite3
        @contextlib.contextmanager
        def opener():
            db = sqlite3.connect(self.local / 'sessions.sqlite3')
            db.execute('BEGIN IMMEDIATE')
            try:
                yield
            finally:
                db.rollback(); db.close()
        return opener

    def survives_busy(self, opener):
        self.consent()
        busy = self.hold(opener)
        during = self.command('snapshot')  # its copy waits out the 1 s lock limit
        busy.join()
        self.assertTrue(during['sharing'], 'a busy store is temporary; sharing must survive it')
        self.append('Spoken while the store was busy', sid='s2')
        self.assertTrue(self.command('snapshot')['sharing'])
        state = bridge.read(self.folder / 'state.json')
        self.assertIn('t-s2', [s['id'] for s in state['transcripts'][-1]['sources']])
        self.assertNotIn('sync_busy_since_ms', state, 'a good copy clears the busy marker')

    def test_busy_registry_lock_skips_one_copy_instead_of_ending_sharing(self):
        self.survives_busy(lambda: bridge.registry_locked(self.local))

    def test_busy_catalog_skips_one_copy_instead_of_ending_sharing(self):
        self.survives_busy(self.hold_catalog())

    def busy_store(self):
        """The local store always busy, without real 1 s waits, so a fake clock can step past the limit."""
        real = bridge.registry_locked
        def busy(root):
            if root == self.local:
                raise TimeoutError("Meeting store is busy; retry")
            return real(root)
        return patch.object(bridge, 'registry_locked', side_effect=busy)

    def test_store_busy_for_30_seconds_ends_sharing_once_and_not_before(self):
        self.consent()
        version = bridge.read(self.folder / 'state.json')['version']
        start = bridge.now()
        with self.busy_store():
            for offset in (0, 10000, 29999):
                with patch.object(bridge, 'now', return_value=start + offset):
                    self.assertTrue(self.command('snapshot')['sharing'], f'still sharing {offset} ms into a busy store')
                state = bridge.read(self.folder / 'state.json')
                self.assertEqual(state['sync_busy_since_ms'], start, 'the busy clock starts once and is never reset')
                self.assertEqual(state['version'], version, 'a skipped copy changes no transcript')
            with patch.object(bridge, 'now', return_value=start + 30000):
                ended = self.command('snapshot')
        self.assertFalse(ended['sharing'])
        state = bridge.read(self.folder / 'state.json')
        self.assertIn('busy', state['feed_error'])
        self.assertTrue(state['feed_error_detail'].startswith('TimeoutError in busy'), state['feed_error_detail'])

    def test_busy_marker_clears_on_an_unchanged_copy(self):
        self.consent()
        with self.busy_store():
            self.command('snapshot')
        self.assertIn('sync_busy_since_ms', bridge.read(self.folder / 'state.json'))
        self.assertTrue(self.command('snapshot')['sharing'])
        self.assertNotIn('sync_busy_since_ms', bridge.read(self.folder / 'state.json'))

    def test_permanent_feed_failure_records_where_not_what(self):
        import os, time
        self.consent()
        os.utime(self.call / 'session.json', (time.time() - 11, time.time() - 11))
        self.assertFalse(self.command('snapshot')['sharing'])
        detail = bridge.read(self.folder / 'state.json')['feed_error_detail']
        self.assertTrue(detail.startswith('ValueError in call_paths (bridge.py:'), detail)

    def test_failure_detail_never_holds_message_text(self):
        self.consent()
        with patch.object(bridge, 'call_paths', side_effect=ValueError('PRIVATE transcript sentinel')):
            self.assertFalse(self.command('snapshot')['sharing'])
        self.assertNotIn('PRIVATE', (self.folder / 'state.json').read_text())
        self.assertIn('ValueError', bridge.read(self.folder / 'state.json')['feed_error_detail'])

    def test_local_worker_end_stops_connection(self):
        self.consent(); event = self.ask()
        bridge.dispatch(self.local, 'stop', {}, self.source)
        self.assertEqual(self.reply(event)['status'], 'disabled')

    def test_new_local_run_cannot_inherit_consent(self):
        self.consent(); event = self.ask()
        newer = bridge.dispatch(self.local, 'create_local', {'call_id': self.call.name, 'recording_key': 'b' * 64})['run_id']
        bridge.save(self.call / 'live-feed.json', {'run_id': newer, 'status': 'following', 'local_only': True})
        self.assertEqual(self.reply(event)['status'], 'disabled')
        fresh = bridge.dispatch(self.root, 'create_call', {'call_id': self.call.name, 'owner_pid': self.pid})
        self.assertNotEqual(fresh['run_id'], self.run)
        self.assertFalse(fresh['sharing'])
        self.assertEqual(bridge.read(self.root / fresh['run_id'] / 'state.json')['transcripts'][0]['sources'], [])

    def long_notes(self, size):
        # The app accepts 256 KiB of notes; the manifest is written by Rust, not bridge.save.
        notes = ('Fictional "quoted" note\n' * size)[:size]
        (self.call / 'session.json').write_text(json.dumps({'id': self.call.name, 'active': True, 'notes': notes}))

    def test_longest_allowed_notes_keep_sharing_and_history(self):
        self.consent(); event = self.ask(); self.reply(event)
        self.long_notes(256 * 1024)
        self.append('Spoken after long notes', sid='s2')
        snap = self.command('snapshot')
        self.assertTrue(snap['sharing'], snap.get('feed_error'))
        self.assertIn('Spoken after long notes', [s['text'] for s in bridge.read(self.folder / 'state.json')['feed']['segments']])
        bridge.dispatch(self.root, 'recover', {})
        self.assertEqual(bridge.dispatch(self.root, 'call_history', {'call_id': self.call.name, 'offset': 0})['questions'][0]['text'], 'What is the agreed launch?')

    def test_manifest_over_its_cap_still_fails_closed(self):
        self.consent()
        self.long_notes(bridge.MANIFEST_LIMIT)
        self.assertEqual(self.command('snapshot')['status'], 'disabled')

    def test_symlink_or_bad_identity_cannot_export_another_call(self):
        self.consent(); event = self.ask()
        path = self.call / 'session.json'
        other = self.data / 'other.json'; path.rename(other); path.symlink_to(other)
        self.assertEqual(self.reply(event)['status'], 'disabled')
        with self.assertRaises(ValueError): bridge.dispatch(self.root, 'create_call', {'call_id': '../other', 'owner_pid': self.pid})

    def test_source_retraction_keeps_answer_as_historical(self):
        self.consent(); event = self.ask(); self.reply(event)
        self.append(None, removals=['s1'])
        snap = self.command('snapshot')
        self.assertEqual(snap['replies'][0]['source_status'], 'outside_window')
        self.assertEqual(bridge.read(self.folder / 'state.json')['feed']['segments'], [])

    def test_malformed_oversized_source_stops_without_changing_local_feed(self):
        self.consent()
        for i in range(2, 25):
            self.append(f'Fictional revision {i}')
            self.assertTrue(self.command('snapshot')['sharing'])
        state = bridge.read(self.folder / 'state.json')
        self.assertEqual(state['feed']['sequence'], 24)
        # An invalid source must still fail closed; rolling producers never exceed 32.
        with bridge.locked(self.local / self.source, self.source) as source:
            source['feed']['segments'] = [{**source['feed']['segments'][0], 'id': f'bad-{i}'} for i in range(33)]
            bridge.save(self.local / self.source / 'state.json', source)
        original = (self.local / self.source / 'state.json').read_bytes()
        self.assertEqual(self.command('snapshot')['status'], 'disabled')
        self.assertEqual((self.local / self.source / 'state.json').read_bytes(), original)

    def test_live_sequences_continue_with_bounded_retry_history(self):
        self.consent()
        for i in range(2, 81):
            self.append(f'Fictional segment {i}', sid=f's{i}', removals=[f's{i-32}'] if i > 32 else [])
            self.assertTrue(self.command('snapshot')['sharing'])
        for root, run in [(self.local, self.source), (self.root, self.run)]:
            state = bridge.read(root / run / 'state.json')
            self.assertEqual(state['feed']['sequence'], 80)
            self.assertEqual(len(state['feed']['receipts']), 24)
            self.assertEqual(len(state['feed']['segments']),32)
            self.assertEqual({s['id'] for s in state['feed']['segments']},{f's{i}' for i in range(49,81)})
            self.assertLess((root / run / 'state.json').stat().st_size, bridge.LIMIT)
        event=self.ask()
        self.assertIn('Recent transcript only',event['context_scope'])
        self.assertNotIn('t-s1',{s['id'] for s in event['transcript']['sources']})

    def test_native_owner_exit_and_restart_recovery_end_sharing(self):
        self.consent(); event = self.ask()
        with patch.object(bridge.os, 'kill', side_effect=ProcessLookupError):
            self.assertEqual(self.reply(event)['status'], 'disabled')
        bridge.dispatch(self.root, 'recover', {})
        self.assertIsNone(bridge.read(self.root / 'registry.json')['active'])


class DemoArchiveTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.data = Path(self.temp.name)
        self.root = self.data / 'assistie'
        self.root.mkdir()

    def create(self):
        result = bridge.dispatch(self.root, 'create_demo', {})
        run = result['run_id']
        saved = bridge.read(self.root / run / 'state.json')['archive_call_id']
        return run, saved

    def test_new_answers_reopen_after_recovery_without_capture_or_sharing(self):
        run, call = self.create()
        manifest = bridge.read(self.data / 'calls' / call / 'session.json')
        self.assertFalse(manifest['active'])
        self.assertEqual(manifest['system']['samples'], 0)
        self.assertFalse(manifest['mic_segments'])
        self.assertEqual(len(list((self.data / 'calls' / call).iterdir())), 1)
        self.assertIsNone(bridge.dispatch(self.root, 'snapshot', {}, run)['call_id'])
        bridge.dispatch(self.root, 'controls', {'sharing':True, 'proactive':False}, run)
        bridge.dispatch(self.root, 'ask', {'question':'What is agreed?'}, run)
        event = bridge.wait(self.root / run, run, .05)
        bridge.mutate(self.root / run, 'reply', {'event_id':event['event_id'], 'text':'Friday, conditional on accessibility passing.', 'sources':['v1-1']}, run)
        before = bridge.read(self.root / run / 'state.json')['replies'][0]
        bridge.dispatch(self.root, 'recover', {})
        raw_before = (self.root / run / 'state.json').read_bytes()
        archive = bridge.dispatch(self.root, 'call_history', {'call_id':call, 'offset':0})
        self.assertEqual(archive['replies'][0]['text'], before['text'])
        self.assertEqual(archive['replies'][0]['quotes'], before['quotes'])
        self.assertEqual(archive['replies'][0]['snapshot_at_ms'], before['snapshot_at_ms'])
        self.assertTrue(archive['archive'])
        self.assertFalse(archive['sharing'] or archive['proactive'])
        self.assertEqual((self.root / run / 'state.json').read_bytes(), raw_before)
        self.assertIsNone(bridge.dispatch(self.root, 'identity', {})['run_id'])

    def test_demo_creation_never_overwrites_an_older_demo_or_notes(self):
        old, call = self.create()
        manifest = self.data / 'calls' / call / 'session.json'
        before = manifest.read_bytes()
        new, next_call = self.create()
        self.assertNotEqual(old, new)
        self.assertNotEqual(call, next_call)
        self.assertEqual(manifest.read_bytes(), before)
        self.assertTrue(bridge.read(self.root / old / 'state.json')['ended'])

    def test_demo_history_keeps_original_answers_after_a_source_revision(self):
        run, call = self.create()
        bridge.dispatch(self.root, 'controls', {'sharing':True, 'proactive':False}, run)
        for version, day in ((1, 'Friday'), (2, 'Monday')):
            if version == 2:
                bridge.mutate(self.root / run, 'update', {'sources':[{'id':'v2-1', 'text':'The fictional agreement is now Monday.'}]}, run)
            bridge.dispatch(self.root, 'ask', {'question':'What day is agreed?'}, run)
            event = bridge.wait(self.root / run, run, .05)
            bridge.mutate(self.root / run, 'reply', {'event_id':event['event_id'], 'text':day, 'sources':[f'v{version}-1']}, run)
        bridge.dispatch(self.root, 'recover', {})
        replies = bridge.dispatch(self.root, 'call_history', {'call_id':call, 'offset':0})['replies']
        self.assertEqual([r['text'] for r in replies], ['Friday', 'Monday'])
        self.assertIn('Friday', replies[0]['quotes'][0]['text'])
        self.assertEqual(replies[0]['source_status'], 'outside_window')
        self.assertTrue(all(r['snapshot_at_ms'] for r in replies))

    def test_linked_call_store_failure_preserves_existing_consent(self):
        old = bridge.dispatch(self.root, 'create', {})['run_id']
        bridge.dispatch(self.root, 'controls', {'sharing':True, 'proactive':False}, old)
        outside = self.data / 'outside'
        outside.mkdir()
        (self.data / 'calls').symlink_to(outside, target_is_directory=True)
        with self.assertRaises(ValueError): self.create()
        self.assertFalse(list(outside.iterdir()))
        self.assertTrue(bridge.dispatch(self.root, 'current', {})['sharing'])
        local = self.data / 'assistie-local'
        local.mkdir()
        with self.assertRaises(ValueError): bridge.dispatch(local, 'create_demo', {})

    def test_demo_archive_identity_survives_catalog_migration(self):
        run, call = self.create()
        with bridge.registry_locked(self.root) as registry:
            registry.catalog.execute('DELETE FROM sessions WHERE run_id=?', (run,))
            registry.catalog.commit()
        with bridge.registry_locked(self.root) as registry:
            self.assertEqual(list(registry.for_call(call)), [run])


if __name__ == "__main__":unittest.main()
