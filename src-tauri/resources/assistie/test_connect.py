import json
import hashlib
import subprocess
import sys
import unittest
from pathlib import Path
from unittest.mock import patch
import bridge
import plugin
import test_plugin


class ConnectTest(unittest.TestCase):
    def setUp(self):
        self.f = test_plugin.PluginTest()
        self.f.setUp()
        self.addCleanup(self.f.doCleanups)
        self.root, self.run, self.server = self.f.root, self.f.run, self.f.plugin
        self.folder = self.root / self.run

    def connect(self, proactive=False):
        return bridge.dispatch(self.root, 'connect', {'proactive': proactive}, self.run)

    def test_consent_is_explicit_scoped_and_idempotent(self):
        self.assertFalse(bridge.dispatch(self.root, 'current', {})['sharing'])
        with self.assertRaises(ValueError): self.f.read()
        for payload in ({}, {'proactive': 'yes'}, {'proactive': True, 'path': '/private'}):
            with self.assertRaises(ValueError): bridge.dispatch(self.root, 'connect', payload, self.run)
        first = self.connect()
        again = self.connect(True)
        self.assertEqual(first['connection'], again['connection'])
        self.assertFalse(again['proactive'])
        self.assertEqual(first['status'], 'waiting')
        self.assertEqual(first['connection']['phase'], 'requested')
        bridge.dispatch(self.root, 'stop', {}, self.run)
        with self.assertRaises(ValueError): self.connect()

    def test_one_bootstrap_event_then_local_worker_owns_questions(self):
        self.server.rpc('events/subscribe', self.f.sub)
        connected = self.connect(True)
        token = connected['connection']['id']
        self.f.ask()
        self.server.tick(); self.server.tick()
        self.assertEqual(len([p for p, _ in self.f.posts if 'data' in p]), 1)
        claimed = self.f.read()
        self.assertEqual(claimed['status'], 'connect')
        self.assertIn(token, claimed['prompt'])
        self.assertIn('Do not create or delegate another task.', claimed['prompt'])
        self.assertNotIn('v1-1', claimed['prompt'])
        self.assertEqual(self.f.read(), {'status': 'starting'})
        self.assertEqual(self.server.status()['phase'], 'starting_worker')
        self.assertEqual(bridge.wait(self.folder, self.run, seconds=.001), {'status': 'superseded'})
        event = bridge.wait(self.folder, self.run, seconds=.001, connection_id=token)
        self.assertEqual(event['status'], 'event')
        snapshot = bridge.dispatch(self.root, 'current', {})
        self.assertEqual(snapshot['connection']['phase'], 'connected')
        self.assertEqual(snapshot['transport'], 'worker')
        self.assertIsNone(self.server.current())
        self.assertEqual(self.f.read(), {'status': 'disabled'})
        self.server.tick()
        self.assertEqual(len([p for p, _ in self.f.posts if 'data' in p]), 1)

    def test_stale_worker_cannot_publish_or_stop_current_connection(self):
        token = self.connect()['connection']['id']; self.f.read(); self.f.ask()
        event = bridge.wait(self.folder, self.run, seconds=.001, connection_id=token)
        value = {'event_id': event['event_id'], 'text': 'Friday if accessibility passes.', 'sources': ['v1-1']}
        for command, payload in [('reply', value), ('stop', {})]:
            self.assertEqual(bridge.mutate(self.folder, command, payload, self.run, 'wrong', True), {'status': 'superseded'})
        self.assertTrue(bridge.dispatch(self.root, 'current', {})['sharing'])
        self.assertEqual(bridge.mutate(self.folder, 'reply', value, self.run, token, True)['status'], 'published')
        self.assertEqual(bridge.mutate(self.folder, 'stop', {}, self.run, token, True)['status'], 'disabled')
        self.assertEqual(self.f.read(), {'status': 'disabled'})

    def test_stop_during_startup_and_replaced_meeting_revoke_handoff(self):
        token = self.connect()['connection']['id']; self.f.read()
        bridge.dispatch(self.root, 'stop', {}, self.run)
        self.assertEqual(bridge.wait(self.folder, self.run, seconds=.001, connection_id=token), {'status': 'disabled'})
        self.assertEqual(self.f.read(), {'status': 'disabled'})
        bridge.dispatch(self.root, 'create_demo', {})
        self.assertEqual(self.f.read(), {'status': 'disabled'})

    def test_no_ready_status_before_worker_and_startup_is_bounded(self):
        connected = self.connect(); self.f.read()
        before = bridge.dispatch(self.root, 'current', {})
        self.assertEqual(before['connection']['phase'], 'starting')
        self.assertIsNone(before['connection']['ready_at_ms'])
        with patch.object(bridge, 'now', return_value=connected['startup_deadline_ms'] + 1):
            self.assertEqual(self.f.read(), {'status': 'disabled'})
            state = bridge.dispatch(self.root, 'current', {})
            self.assertFalse(state['sharing'])
            self.assertEqual(state['connection']['phase'], 'stopped')

    def test_cli_stop_requires_connection_identity(self):
        token = self.connect()['connection']['id']; self.f.read()
        result = subprocess.run([sys.executable, '-I', '-B', str(Path(bridge.__file__)), 'stop', str(self.folder), self.run, 'stale'], capture_output=True, check=True)
        self.assertEqual(json.loads(result.stdout), {'status':'superseded'})
        self.assertTrue(bridge.dispatch(self.root, 'current', {})['sharing'])
        result = subprocess.run([sys.executable, '-I', '-B', str(Path(bridge.__file__)), 'stop', str(self.folder), self.run, token], capture_output=True, check=True)
        self.assertEqual(json.loads(result.stdout)['status'], 'disabled')

    def test_retry_rotates_identity_without_extending_consent_or_spawning_duplicates(self):
        first = self.connect(); old_token = first['connection']['id']; self.f.read()
        self.assertEqual(bridge.dispatch(self.root, 'retry_connect', {}, self.run)['connection']['id'], old_token)
        at = first['connection']['last_attempt_ms'] + 31000
        with patch.object(bridge, 'now', return_value=at):
            retried = bridge.dispatch(self.root, 'retry_connect', {}, self.run)
            self.assertNotEqual(retried['connection']['id'], old_token)
            self.assertEqual(retried['startup_deadline_ms'], first['startup_deadline_ms'])
            self.assertEqual(retried['connection']['attempts'], 2)
            self.assertEqual(bridge.wait(self.folder, self.run, seconds=.001, connection_id=old_token), {'status':'superseded'})
            self.assertEqual(bridge.mutate(self.folder, 'stop', {}, self.run, old_token, True), {'status':'superseded'})
            self.assertEqual(self.f.read()['status'], 'connect')
            self.assertEqual(bridge.dispatch(self.root, 'retry_connect', {}, self.run)['connection']['attempts'], 2)
        self.assertTrue(bridge.dispatch(self.root, 'current', {})['sharing'])

    def test_review_cache_requires_exact_installed_source_and_preserves_scope(self):
        helper = self.root / 'bridge.py'
        helper.write_bytes(Path(bridge.__file__).read_bytes())
        token = self.connect()['connection']['id']
        first = self.f.read()['prompt']
        digest = hashlib.sha256(helper.read_bytes()).hexdigest()
        self.assertIn('Expected helper SHA-256: ' + digest, first)
        self.assertIn('this SAME task already recorded a review of this exact path with this exact hash', first)
        self.assertIn('do not execute a hash mismatch', first)
        self.assertIn('Normal approval checks still apply', first)
        self.assertIn(token, first)
        self.assertIsNone(bridge.dispatch(self.root, 'current', {})['connection']['ready_at_ms'])
        helper.write_bytes(helper.read_bytes() + b'\n# changed fictional helper\n')
        state = bridge.read(self.folder / 'state.json')
        changed = bridge.worker_prompt(self.root, self.folder, self.run, state)['prompt']
        self.assertNotIn('Expected helper SHA-256: ' + digest, changed)
        self.assertIn(hashlib.sha256(helper.read_bytes()).hexdigest(), changed)
        self.assertIn('Do not create or delegate another task.', changed)

if __name__ == '__main__': unittest.main()
