import base64
import copy
import json
from pathlib import Path
import tempfile
import os
import subprocess
import sys
import time
import unittest
from unittest.mock import patch
import bridge
import plugin


class PluginTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / 'assistie'; self.root.mkdir()
        self.clock = [1000.0]; self.posts = []; self.codes = []
        def post(sub, payload, identity):
            self.posts.append((copy.deepcopy(payload), identity))
            if payload.get('type') == 'verification': return 200, {'challenge': payload['challenge']}
            return (self.codes.pop(0) if self.codes else 202), {}
        self.plugin = plugin.Plugin(self.root, post, lambda: self.clock[0])
        (self.plugin.store / 'tunnel-id').write_text('  tunnel_test\n')
        self.installation = self.plugin.status()['installation_id']
        self.sub = {'name': plugin.EVENT, 'arguments': {'installation_id': self.installation}, 'delivery': {'mode': 'webhook', 'url': 'https://api.openai.com/fictional-callback', 'secret': 'whsec_' + base64.b64encode(bytes(range(32))).decode()}, 'ttlMs': None}
        self.run = bridge.dispatch(self.root, 'create_demo', {})['run_id']

    def call(self, name, **args):
        return self.plugin.rpc('tools/call', {'name': name, 'arguments': args})['structuredContent']

    def allow(self, pointers=False):
        bridge.dispatch(self.root, 'controls', {'sharing': True, 'proactive': pointers, 'transport': 'plugin'}, self.run)

    def ask(self):
        bridge.dispatch(self.root, 'ask', {'question': 'What launch date is agreed?'}, self.run)

    def read(self):
        return self.call('read_handy_meeting_event', meeting_id=self.run)

    def reply(self, event, text='Friday if accessibility passes.'):
        return self.call('publish_handy_meeting_reply', meeting_id=self.run, event_id=event['event_id'], text=text, sources=[event['transcript']['sources'][0]['id']])

    def test_pair_without_data_then_two_meetings_and_restart(self):
        self.assertEqual(self.call('handy_connection_status')['phase'], 'unpaired')
        with self.assertRaises(ValueError): self.read()
        sub = self.plugin.rpc('events/subscribe', self.sub)
        self.assertIsNone(sub['refreshBefore'])
        for index in range(2):
            self.allow(); self.ask(); self.plugin.tick()
            self.assertEqual(self.plugin.status()['phase'], 'connecting')
            event = self.read(); self.reply(event)
            self.assertEqual(self.plugin.status()['phase'], 'connected')
            bridge.dispatch(self.root, 'stop', {}, self.run)
            if not index: self.run = bridge.dispatch(self.root, 'create_demo', {})['run_id']
        restored = plugin.Plugin(self.root, self.plugin.post, lambda: self.clock[0])
        self.assertEqual(restored.status()['subscriptions'], 1)
        self.assertEqual(len([x for x in self.posts if 'data' in x[0]]), 2)

    def test_delivery_retries_preserve_identity_and_ack_is_separate(self):
        self.plugin.rpc('events/subscribe', self.sub); self.allow(); self.ask()
        self.codes = [503, 429, 202]; self.plugin.tick()
        self.clock[0] += 10; self.plugin.tick()
        self.clock[0] += 20; self.plugin.tick()
        deliveries = [x for x in self.posts if 'data' in x[0]]
        self.assertEqual(len(deliveries), 3)
        self.assertEqual(len(set(x[1] for x in deliveries)), 1)
        self.assertEqual(set(deliveries[-1][0]['data']), {'installation_id', 'meeting_id'})
        self.assertEqual(self.plugin.status()['phase'], 'delayed')
        self.read(); self.assertEqual(self.plugin.status()['phase'], 'connected')

    def test_receipt_and_rpc_diagnostics_never_log_payloads_or_secrets(self):
        self.plugin.rpc('events/subscribe',self.sub);self.allow();self.ask()
        self.plugin.post=lambda *_: (200, {'status':'accepted','accepted':True,'message':'PRIVATE TRANSCRIPT','secret':'whsec_PRIVATE','request_id':'req_fictional123'})
        self.plugin.tick()
        self.assertEqual(self.plugin.status()['phase'],'connecting')
        self.call('handy_connection_status')
        with self.plugin.locked() as s:
            receipt=s['outbox'][-1]['receipt']
            self.assertEqual(receipt,{'body_keys':['status','accepted','message','request_id'],'status':'accepted','accepted':True,'request_id':'req_fictional123'})
            self.assertEqual(s['audit'][-1]['tool'],'handy_connection_status')
            self.assertNotIn('PRIVATE',json.dumps([s['audit'],s['outbox']]))
        self.assertEqual(plugin.receipt_metadata({'status':'PRIVATE TRANSCRIPT','request_id':'sk-private','queued':'PRIVATE'}),{'body_keys':['status','queued','request_id']})

    def test_stop_during_network_is_not_blocked_and_late_read_denied(self):
        self.plugin.rpc('events/subscribe', self.sub); self.allow(); self.ask()
        def stop_during_post(*_):
            bridge.dispatch(self.root, 'stop', {}, self.run)
            return 202, {}
        self.plugin.post = stop_during_post
        self.plugin.tick()
        self.assertEqual(self.read(), {'status':'disabled'})
        self.plugin.tick()
        with self.plugin.locked() as s: self.assertTrue(s['outbox'][0]['cancelled'])

    def test_late_event_is_disabled_without_reading_old_files_or_acknowledging(self):
        self.plugin.rpc('events/subscribe',self.sub);self.allow();self.ask();self.plugin.tick()
        old=self.run
        bridge.dispatch(self.root,'stop',{},old)
        self.assertEqual(self.read(),{'status':'disabled'})
        self.run=bridge.dispatch(self.root,'create_demo',{})['run_id']
        with patch.object(bridge,'checked_folder',side_effect=AssertionError('Opened stale meeting')):
            self.assertEqual(self.call('read_handy_meeting_event',meeting_id=old),{'status':'disabled'})
            self.assertEqual(self.call('read_handy_meeting_event',meeting_id='meeting-'+'f'*32),{'status':'disabled'})
        with self.plugin.locked() as state:
            self.assertNotIn('ack_at',state['outbox'][0])
        with self.assertRaises(ValueError): self.read()  # Fresh meeting still needs Allow.
        self.allow();self.ask();self.reply(self.read())
        self.assertEqual(len(bridge.dispatch(self.root,'snapshot',{},self.run)['replies']),1)

    def test_reply_retry_idempotent_cannot_overwrite_or_cross_meetings(self):
        self.allow(); self.ask(); event = self.read()
        self.assertEqual(self.read(), event)
        self.reply(event); self.assertTrue(self.reply(event)['duplicate'])
        with self.assertRaises(ValueError): self.reply(event, 'Changed')
        self.run = bridge.dispatch(self.root, 'create_demo', {})['run_id']; self.allow()
        with self.assertRaises(ValueError): self.reply(event)

    def test_pointers_off_mid_reply_and_stop_after_answer(self):
        self.allow(True); event = self.read()
        self.assertEqual(event['kind'], 'pointer')
        bridge.dispatch(self.root, 'controls', {'sharing':True, 'proactive':False}, self.run)
        self.assertEqual(self.reply(event)['status'], 'suppressed')
        self.ask(); answer = self.read(); self.reply(answer)
        bridge.dispatch(self.root, 'stop', {}, self.run)
        with self.assertRaises(ValueError): self.reply(answer)
        self.assertEqual(len(bridge.dispatch(self.root, 'snapshot', {}, self.run)['replies']), 1)

    def test_terminal_http_and_bounded_attempts(self):
        self.plugin.rpc('events/subscribe', self.sub); self.allow(); self.ask(); self.codes=[413]
        self.plugin.tick(); self.clock[0] += 20; self.plugin.tick()
        self.assertEqual(len([x for x in self.posts if 'data' in x[0]]), 1)
        self.assertEqual(self.plugin.status()['phase'], 'delivery_failed')

    def test_real_or_local_only_states_rejected_and_expiry(self):
        self.allow()
        folder = self.root/self.run
        with bridge.locked(folder,self.run) as s:
            s['local_only']=True; bridge.save(folder/'state.json',s)
        self.assertIsNone(self.plugin.current())
        with self.assertRaises(ValueError): self.read()
        with bridge.locked(folder,self.run) as s:
            s['local_only']=False; s['archive_call_id']=None; bridge.save(folder/'state.json',s)
        with self.assertRaises(ValueError): self.read()

    def test_idle_status_and_tick_do_not_rewrite_private_store(self):
        path = self.root/'plugin/state.json'
        before = path.stat().st_mtime_ns
        for _ in range(4): self.plugin.status(); self.plugin.tick()
        self.assertEqual(path.stat().st_mtime_ns, before)

    def test_bad_subscription_and_tool_arguments(self):
        for url in ['http://api.openai.com/x','https://api.openai.com.evil.example/x','https://127.0.0.1/x','https://api.openai.com:444/x']:
            bad=copy.deepcopy(self.sub);bad['delivery']['url']=url
            with self.assertRaises(ValueError):self.plugin.rpc('events/subscribe',bad)
        with self.assertRaises(ValueError): self.call('handy_connection_status', path='/etc/passwd')
        with self.assertRaises(ValueError): self.call('read_handy_meeting_event',meeting_id='../x')


    def test_expired_subscription_and_meeting_do_not_deliver(self):
        sub = copy.deepcopy(self.sub); sub['ttlMs'] = 1
        self.plugin.rpc('events/subscribe', sub); self.allow(); self.ask()
        self.clock[0] += 1; self.plugin.tick()
        self.assertEqual(len([x for x in self.posts if 'data' in x[0]]), 0)
        with patch.object(bridge, 'now', return_value=bridge.now()+1800001):
            self.assertIsNone(self.plugin.current())
            self.assertEqual(self.read(), {'status':'disabled'})

    def test_finite_lease_refresh_across_restart_keeps_one_pairing_and_consent(self):
        params = copy.deepcopy(self.sub); params['ttlMs'] = 600000
        first = self.plugin.rpc('events/subscribe', params)
        self.clock[0] += 301
        restored = plugin.Plugin(self.root, self.plugin.post, lambda: self.clock[0])
        renewed = restored.rpc('events/subscribe', params)
        self.assertEqual(first['id'], renewed['id'])
        self.assertGreater(renewed['refreshBefore'], first['refreshBefore'])
        self.clock[0] += 300  # Past the original expiration.
        self.assertEqual(restored.status()['subscriptions'], 1)
        restored.tick()
        self.assertIsNone(restored.current())
        self.assertFalse(bridge.dispatch(self.root, 'snapshot', {}, self.run)['sharing'])
        self.assertFalse(any('data' in p for p, _ in self.posts))
        with self.assertRaises(ValueError): self.read()
        self.plugin = restored
        self.allow(True); self.ask(); self.plugin.tick()
        answer = self.read(); self.reply(answer)
        pointer = self.read(); self.assertEqual(pointer['kind'], 'pointer')
        bridge.dispatch(self.root, 'controls', {'sharing':True, 'proactive':False}, self.run)
        self.assertEqual(self.reply(pointer)['status'], 'suppressed')
        bridge.dispatch(self.root, 'stop', {}, self.run)
        self.assertEqual(self.read(), {'status':'disabled'})
        self.run = bridge.dispatch(self.root, 'create_demo', {})['run_id']
        with self.assertRaises(ValueError): self.read()
        self.allow(); self.ask(); self.plugin.tick(); self.reply(self.read())
        self.assertEqual(self.plugin.status()['subscriptions'], 1)

    def test_expired_lease_never_extends_itself_and_failed_refresh_keeps_expiry(self):
        params = copy.deepcopy(self.sub); params['ttlMs'] = 1000
        first = self.plugin.rpc('events/subscribe', params)
        self.clock[0] += 2
        restored = plugin.Plugin(self.root, self.plugin.post, lambda: self.clock[0])
        restored.tick(); self.assertEqual(restored.status()['subscriptions'], 0)
        self.assertEqual(restored.status()['phase'], 'renewing')
        restored.post = lambda *_: (503, {})
        with self.assertRaises(ValueError): restored.rpc('events/subscribe', params)
        self.assertEqual(restored.status()['subscriptions'], 0)
        restored.post = self.plugin.post
        self.assertEqual(restored.rpc('events/subscribe', params)['id'], first['id'])
        self.assertEqual(restored.status()['subscriptions'], 1)
        self.assertIsNone(restored.current())

    def test_callback_cache_bounded_and_secret_rotation_is_verified(self):
        first = self.plugin.rpc('events/subscribe', self.sub)
        self.clock[0] += 1
        self.plugin.rpc('events/subscribe', self.sub)
        self.assertEqual(len(self.posts), 1)
        rotated = copy.deepcopy(self.sub)
        rotated['delivery']['secret'] = 'whsec_' + base64.b64encode(bytes(range(32,64))).decode()
        self.assertEqual(self.plugin.rpc('events/subscribe', rotated)['id'], first['id'])
        self.assertEqual(len(self.posts), 2)
        with self.plugin.locked() as s:
            saved = copy.deepcopy(s['subscriptions'][first['id']])
        self.assertEqual(saved['secret'], rotated['delivery']['secret'])
        self.assertEqual(saved['previous_secret'], self.sub['delivery']['secret'])
        self.clock[0] += 301
        self.plugin.rpc('events/subscribe', rotated)
        self.assertEqual(len(self.posts), 3)
        with self.plugin.locked() as s:
            self.assertNotIn('previous_secret', s['subscriptions'][first['id']])

    def test_unsubscribe_during_refresh_does_not_resurrect_pairing(self):
        self.plugin.rpc('events/subscribe', self.sub); self.clock[0] += 301
        def unsubscribe(sub, payload, identity):
            self.plugin.rpc('events/unsubscribe', self.sub)
            return 200, {'challenge': payload['challenge']}
        self.plugin.post = unsubscribe
        with self.assertRaises(ValueError): self.plugin.rpc('events/subscribe', self.sub)
        self.assertEqual(self.plugin.status()['subscriptions'], 0)

    def test_replacement_callback_is_verified_and_atomic_without_meeting_consent(self):
        first = self.plugin.rpc('events/subscribe', self.sub)
        replacement = copy.deepcopy(self.sub)
        replacement['delivery']['url'] = 'https://api.openai.com/fictional-replacement'
        post = self.plugin.post; self.plugin.post = lambda *_: (503, {})
        with self.assertRaises(ValueError): self.plugin.rpc('events/subscribe',replacement)
        with self.plugin.locked() as s:self.assertEqual(list(s['subscriptions']),[first['id']])
        self.plugin.post = post
        renewed = self.plugin.rpc('events/subscribe',replacement)
        self.assertNotEqual(first['id'],renewed['id'])
        self.plugin.rpc('events/unsubscribe',self.sub)
        with self.plugin.locked() as s:self.assertEqual(list(s['subscriptions']),[renewed['id']])
        self.assertIsNone(self.plugin.current())
        self.allow();self.ask();self.plugin.tick();self.reply(self.read())
        with self.assertRaises(ValueError):self.plugin.rpc('events/subscribe',self.sub)
        self.assertEqual(self.plugin.status()['subscriptions'],1)

    def test_callback_replacement_rechecks_consent_after_verification(self):
        first=self.plugin.rpc('events/subscribe',self.sub)
        replacement=copy.deepcopy(self.sub)
        replacement['delivery']['url']='https://api.openai.com/fictional-replacement'
        def allow_during_verification(sub,payload,identity):
            self.allow()
            return 200,{'challenge':payload['challenge']}
        self.plugin.post=allow_during_verification
        with self.assertRaises(ValueError):self.plugin.rpc('events/subscribe',replacement)
        with self.plugin.locked() as s:self.assertEqual(list(s['subscriptions']),[first['id']])

    def test_rotation_signatures_expire_after_grace_window(self):
        import hashlib, hmac, socket
        from unittest.mock import MagicMock
        sub = {'id':'fictional-sub', 'url':'https://api.openai.com/fictional-callback',
               'secret':self.sub['delivery']['secret'],
               'previous_secret':'whsec_' + base64.b64encode(bytes(range(32,64))).decode(),
               'previous_secret_until':1300}
        for at, count in ((1000,2),(1301,1)):
            connection = MagicMock(); connection.getresponse.return_value.read.return_value = b'{}'
            connection.getresponse.return_value.status = 200
            with patch.object(plugin.time,'time',return_value=at), patch.object(plugin.socket,'getaddrinfo',return_value=[(socket.AF_INET,socket.SOCK_STREAM,6,'',('8.8.8.8',443))]), patch.object(plugin.socket,'socket'), patch.object(plugin.ssl,'create_default_context'), patch.object(plugin.http.client,'HTTPSConnection',return_value=connection):
                plugin.signed_post(sub, {'fictional':True}, 'event-rotation')
            args = connection.request.call_args.args
            signatures = args[3]['webhook-signature'].split()
            self.assertEqual(len(signatures),count)
            for secret, signature in zip((sub['secret'],sub['previous_secret']),signatures):
                signed = b'event-rotation.' + str(at).encode() + b'.' + args[2]
                expected = 'v1,' + base64.b64encode(hmac.digest(plugin.signing_key(secret),signed,'sha256')).decode()
                self.assertTrue(hmac.compare_digest(signature,expected))

    def test_missing_or_empty_tunnel_id_reports_configuration_error(self):
        path = self.plugin.store / 'tunnel-id'
        for value in (None, '', '  \n'):
            with self.subTest(value=value):
                if value is None:
                    path.unlink()
                else:
                    path.write_text(value)
                message = f'Assistie route not configured: put your OpenAI tunnel id in {path}'
                with patch.object(plugin, 'ThreadingHTTPServer') as server, patch.object(plugin.subprocess, 'Popen') as child:
                    with self.assertRaises(ValueError) as error:
                        plugin.serve(self.root, Path('unused-tunnel'), 'unused-key', None)
                self.assertEqual(str(error.exception), message)
                status = json.loads((self.plugin.store / 'status.json').read_text())
                self.assertEqual((status['phase'], status['error']), ('offline', message))
                server.assert_not_called()
                child.assert_not_called()

    def test_tunnel_exit_recovers_and_eof_during_backoff_stops_retries(self):
        fake = self.root/'fake-restarting-tunnel'
        fake.write_text('''#!/usr/bin/python3
import pathlib,sys,time,json,os
assert sys.argv[sys.argv.index('--control-plane.tunnel-id')+1] == 'tunnel_test'
store=pathlib.Path(sys.argv[sys.argv.index('--health.url-file')+1]).parent
path=store/'attempts.json'
attempt=json.loads(path.read_text())['attempt']+1 if path.exists() else 1
path.write_text(json.dumps({'attempt':attempt,'pid':os.getpid()}))
if attempt==1:sys.exit(1)
while True:time.sleep(1)
''')
        fake.chmod(0o700)
        process=subprocess.Popen([sys.executable,'-I','-B',str(Path(plugin.__file__)),str(self.root),str(fake)],stdin=subprocess.PIPE,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE)
        self.addCleanup(lambda: process.kill() if process.poll() is None else None)
        process.stdin.write(b'{"key":"fictional-placeholder-not-a-real-key"}\n');process.stdin.flush()
        path=self.root/'plugin/attempts.json'; deadline=time.monotonic()+8
        while time.monotonic()<deadline:
            if path.exists() and json.loads(path.read_text())['attempt']>=2:break
            time.sleep(.02)
        self.assertEqual(json.loads(path.read_text())['attempt'],2)
        pid=json.loads(path.read_text())['pid']
        os.kill(pid,15)
        time.sleep(.6)  # Supervisor is now waiting for its delayed retry.
        process.stdin.close(); process.wait(timeout=5);process.stderr.close()
        time.sleep(2.2)
        self.assertEqual(json.loads(path.read_text())['attempt'],2)
        with self.assertRaises(ProcessLookupError):os.kill(pid,0)
        self.assertEqual(json.loads((self.root/'plugin/status.json').read_text())['phase'],'offline')

    def test_supervisor_auth_boundary_and_parent_eof_cleanup(self):
        fake = self.root / 'fake-tunnel'
        fake.write_text("""#!/usr/bin/python3
import http.client,json,os,pathlib,sys,time
from urllib.parse import urlsplit
url=urlsplit(sys.argv[sys.argv.index('--mcp.server-url')+1])
path=pathlib.Path(sys.argv[sys.argv.index('--health.url-file')+1]).parent/'probe.json'
statuses=[]
for headers in ({}, {'Authorization':os.environ['HANDY_PLUGIN_AUTH'],'Origin':'https://evil.example'}, {'Authorization':os.environ['HANDY_PLUGIN_AUTH']}):
 c=http.client.HTTPConnection(url.hostname,url.port,timeout=2)
 c.request('POST','/mcp',json.dumps({'jsonrpc':'2.0','id':1,'method':'server/discover'}),headers)
 r=c.getresponse();statuses.append(r.status);r.read();c.close()
path.write_text(json.dumps({'statuses':statuses,'port':url.port,'pid':os.getpid()}))
while True:time.sleep(1)
""")
        fake.chmod(0o700)
        process = subprocess.Popen([sys.executable, '-I', '-B', str(Path(plugin.__file__)), str(self.root), str(fake)], stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        self.addCleanup(lambda: process.kill() if process.poll() is None else None)
        process.stdin.write(b'{"key":"fictional-placeholder-not-a-real-key"}\n');process.stdin.flush()
        probe = self.root/'plugin/probe.json'; deadline=time.monotonic()+5
        while not probe.exists() and process.poll() is None and time.monotonic()<deadline:time.sleep(.02)
        self.assertTrue(probe.exists())
        result=json.loads(probe.read_text());self.assertEqual(result['statuses'],[403,403,200])
        process.stdin.close();process.wait(timeout=5);process.stderr.close()
        with self.assertRaises(ProcessLookupError):os.kill(result['pid'],0)
        import socket
        with socket.socket() as sock:self.assertNotEqual(sock.connect_ex(('127.0.0.1',result['port'])),0)


class LiveConsentPluginTest(unittest.TestCase):
    def setUp(self):
        import test_bridge
        self.fixture = test_bridge.CallConsentTest()
        self.fixture.setUp(); self.addCleanup(self.fixture.doCleanups)
        self.root, self.run = self.fixture.root, self.fixture.run
        self.plugin = plugin.Plugin(self.root, post=lambda *_: (_ for _ in ()).throw(AssertionError('Network forbidden')))

    def call(self, name, **args):
        return self.plugin.rpc('tools/call', {'name':name, 'arguments':args})['structuredContent']

    def consent(self, pointers=False):
        self.fixture.command('controls', {'sharing':True,'proactive':pointers,'transport':'plugin'})

    def question(self):
        self.fixture.command('ask', {'question':'Local consent test'})
        return self.call('read_handy_meeting_event', meeting_id=self.run)

    def reply(self, e):
        return self.call('publish_handy_meeting_reply', meeting_id=self.run, event_id=e['event_id'],text='A local-only test answer.',sources=[e['transcript']['sources'][0]['id']])

    def test_pairing_and_old_worker_consent_never_grant_plugin_access(self):
        self.assertIsNone(self.plugin.current())
        with self.assertRaises(ValueError):self.call('read_handy_meeting_event',meeting_id=self.run)
        self.fixture.consent()
        self.assertIsNone(self.plugin.current())
        with self.assertRaises(ValueError):self.call('read_handy_meeting_event',meeting_id=self.run)
        # A pointer setting cannot silently switch an already-consented worker.
        self.consent()
        self.assertEqual(self.fixture.command('snapshot')['transport'],'worker')
        self.assertIsNone(self.plugin.current())

    def test_current_call_only_and_original_asr_stays_local(self):
        self.consent();event=self.question()
        self.assertNotIn('PRIVATE NOTES',json.dumps(event))
        self.assertEqual(self.reply(event)['status'],'published')
        self.assertEqual(self.plugin.current()['transport'],'plugin')
        source=bridge.read(self.fixture.local/self.fixture.source/'state.json')
        self.assertTrue(source['local_only']);self.assertFalse(source['sharing'])
        with self.assertRaises(ValueError):self.fixture.command('handoff')

    def test_stop_and_heartbeat_loss_block_reads_and_late_replies(self):
        self.consent();event=self.question();self.fixture.manifest(False)
        self.assertIsNone(self.plugin.current())
        with self.assertRaises(ValueError):self.reply(event)
        self.assertFalse(self.fixture.command('snapshot')['sharing'])
        self.assertEqual(self.call('read_handy_meeting_event',meeting_id=self.run),{'status':'disabled'})

    def test_correction_and_pointer_off_are_checked_at_publication(self):
        self.consent();event=self.question();self.fixture.append('Corrected local transcript')
        self.assertEqual(self.reply(event)['status'],'outdated')
        event=self.call('read_handy_meeting_event',meeting_id=self.run)
        self.assertEqual(self.reply(event)['status'],'published')
        self.fixture.command('controls',{'sharing':True,'proactive':True})
        pointer=self.call('read_handy_meeting_event',meeting_id=self.run)
        self.fixture.command('controls',{'sharing':True,'proactive':False})
        self.assertEqual(self.reply(pointer)['status'],'suppressed')

    def test_replaced_local_feed_and_owner_loss_never_fall_back(self):
        self.consent();event=self.question()
        bridge.save(self.fixture.call/'live-feed.json',{'run_id':'meeting-'+'a'*32,'status':'following','local_only':True})
        with self.assertRaises(ValueError):self.reply(event)
        self.assertIsNone(self.plugin.current())

    def test_pointers_off_does_not_read_new_local_text(self):
        self.consent(True)
        original=bridge.read
        def guarded(path):
            if path==self.fixture.local/self.fixture.source/'state.json':self.fail('Revocation read new transcript text')
            return original(path)
        with patch.object(bridge,'read',side_effect=guarded):
            self.fixture.command('controls',{'sharing':False,'proactive':False})
        self.assertIsNone(self.plugin.current())


if __name__ == '__main__': unittest.main()
