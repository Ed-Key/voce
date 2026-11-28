"""E1: responder rows of the Terra state table, against the real bridge and a scripted app-server."""
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import bridge
import responder
import test_bridge

HERE = Path(__file__).resolve().parent
P = "Heads up: this conflicts with the brief.\nSOURCES: t-s1"


class ExitTests(unittest.TestCase):
    def test_a_normal_exit_does_not_abort_while_waiting_on_the_parent(self):
        script = (
            "import sys, threading, time\n"
            f"sys.path.insert(0, {str(Path(__file__).parent)!r})\n"
            "import responder\n"
            "threading.Thread(target=responder.wait_for_parent, daemon=True).start()\n"
            "time.sleep(.2)\n"
        )
        child = subprocess.Popen(["/usr/bin/python3", "-I", "-c", script], stdin=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            error = child.stderr.read()
            child.wait(timeout=20)
        finally:
            child.stdin.close()
        self.assertEqual(child.returncode, 0, error.decode()[:300])


class ResponderTest(unittest.TestCase):
    setUp_call = test_bridge.CallConsentTest.setUp
    manifest = test_bridge.CallConsentTest.manifest
    append = test_bridge.CallConsentTest.append
    command = test_bridge.CallConsentTest.command

    def setUp(self):
        self.setUp_call()
        self.log = self.data / 'fake.jsonl'
        os.environ['FAKE_CODEX_LOG'] = str(self.log)

    def start(self, script, proactive=True):
        path = self.data / 'script.json'
        path.write_text(json.dumps(script))
        os.environ['FAKE_CODEX_SCRIPT'] = str(path)
        self.token = self.command('connect_codex', {'proactive': proactive})['connection']['id']
        self.responder = responder.Responder(bridge, self.folder, self.run, self.token,
                                             [sys.executable, '-I', '-B', str(HERE / 'fake_codex.py')], self.data,
                                             brief='Alex is out Nov 12.', today='Tuesday, November 3, 2026',
                                             log=self.data / 'terra.jsonl')
        self.outcome = {}
        self.thread = threading.Thread(target=lambda: self.outcome.update(error=self.responder.run()), daemon=True)
        self.thread.start()
        self.addCleanup(self.finish)

    def finish(self):
        if self.thread.is_alive():
            self.command('stop')
            self.thread.join(10)
        self.assertFalse(self.thread.is_alive(), 'responder must exit when sharing stops')
        self.assertIsNotNone(self.responder.server.proc.poll(), 'codex must be reaped')

    def until(self, check, seconds=8):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            value = check()
            if value:
                return value
            time.sleep(.02)
        self.fail('condition not reached')

    def inputs(self):
        if not self.log.exists():
            return []
        return [json.loads(l)['input'] for l in self.log.read_text().splitlines() if '"input"' in l]

    def results(self):
        path = self.data / 'terra.jsonl'
        return [json.loads(l) for l in path.read_text().splitlines()] if path.exists() else []

    def replies(self):
        return self.command('snapshot')['replies']

    def test_flags_brief_and_released_pointer(self):
        self.start([{'text': P}])
        self.until(lambda: self.replies())
        head = json.loads(self.log.read_text().splitlines()[0])
        self.assertIn('Alex is out Nov 12.', head['system'])
        self.assertIn('Tuesday, November 3, 2026', head['system'])
        first = self.inputs()[0]
        self.assertEqual((first['event'], first['lines'][0]['id'], first['lines'][0]['speaker']), ({'kind': 'pointer'}, 't-s1', 'other'))
        self.assertEqual(self.replies()[0]['author'], 'terra_responder')
        self.until(lambda: self.results() and self.results()[0]['result'] == 'published')
        self.assertNotIn('Heads up', (self.data / 'terra.jsonl').read_text(), 'the log holds no meeting text')

    def test_step_journal_records_each_turn_from_event_to_settle(self):
        # Observatory contract: every step, in order, with matching ids.
        self.start([{'text': P}])
        self.until(lambda: self.results() and self.results()[0]['result'] == 'published')
        rows = [json.loads(l) for l in (self.folder / 'terra-journal.jsonl').read_text().splitlines()]
        self.assertEqual([r['seq'] for r in rows], list(range(1, len(rows) + 1)))
        session = rows[0]
        self.assertEqual((session['kind'], session['brief'], session['model']), ('session', 'Alex is out Nov 12.', responder.MODEL))
        self.assertIn('Alex is out Nov 12.', session['system'])
        event_id = self.results()[0]['event_id']
        steps = [r['kind'] for r in rows if r.get('event_id') == event_id]
        self.assertEqual(steps, ['event', 'request', 'started', 'output', 'settle'])
        request = next(r for r in rows if r['kind'] == 'request')
        self.assertEqual(json.loads(request['message'])['lines'][0]['id'], 't-s1')
        output = next(r for r in rows if r['kind'] == 'output')
        self.assertEqual((output['status'], output['raw']), ('completed', P))
        settle = next(r for r in rows if r['kind'] == 'settle')
        self.assertEqual((settle['reason'], settle['why'], settle['cited_raw'], settle['payload']['sources']), ('published', 'bridge', ['t-s1'], ['t-s1']))
        usage = [r for r in rows if r['kind'] == 'usage']
        self.assertTrue(usage and usage[0]['turn_id'] == output['turn_id'])
        started = next(r for r in rows if r['kind'] == 'started')
        self.assertEqual(started['turn_id'], output['turn_id'])

    def test_codex_command_disables_every_tool_and_mcp_server(self):
        from unittest.mock import patch

        def listing(*rounds):
            calls = iter(rounds)
            return lambda argv, stop, children: next(calls)
        with patch.object(responder, 'list_servers', listing([], [])):
            command = responder.codex_command()
        for name in responder.DISABLED:
            self.assertIn(name, command)
        # Named independently of DISABLED, so dropping one from the list fails here.
        for name in ('shell_tool', 'unified_exec', 'code_mode_host', 'multi_agent', 'computer_use', 'browser_use',
                     'browser_use_external', 'browser_use_full_cdp_access', 'in_app_browser', 'in_app_local_automation',
                     'view_image', 'apps', 'plugins', 'hooks', 'shell_snapshot', 'skill_mcp_dependency_install', 'memories'):
            self.assertIn(name, responder.DISABLED)
        self.assertIn('web_search="disabled"', command)
        self.assertFalse(any(a.startswith('mcp_servers.') for a in command), 'no servers, no overrides')
        servers = [{'name': 'computer-use', 'enabled': True}]
        with patch.object(responder, 'list_servers', listing(servers, [{'name': 'computer-use', 'enabled': False}])):
            self.assertIn('mcp_servers.computer-use.enabled=false', responder.codex_command())
        with patch.object(responder, 'list_servers', listing(servers, servers)):
            with self.assertRaises(responder.Dead): responder.codex_command()

    def test_mcp_listing_is_owned_and_stoppable(self):
        children = []
        with self.assertRaises(responder.Dead):
            responder.list_servers([sys.executable, '-c', 'import time; time.sleep(30)'], lambda: True, children)
        self.assertEqual(children, [])
        with self.assertRaises(responder.Dead):
            responder.list_servers([sys.executable, '-c', 'print("not json")'], lambda: False, children)
        self.assertEqual(responder.list_servers([sys.executable, '-c', 'print("[]")'], lambda: False, children), [])

    def test_no_pointer_is_silent(self):
        self.start([{'text': 'NO_POINTER'}])
        self.until(lambda: any(r.get('result') == 'passed' for r in self.results()))
        self.assertEqual(self.replies(), [])

    def test_overtaken_pointer_is_revalidated_with_new_lines(self):
        self.start([{'text': P, 'delay': .6}, {'text': 'Still true.\nSOURCES: t-s1, t-s2'}])
        self.until(lambda: self.inputs())
        self.append('And another thing', sid='s2')
        self.until(lambda: self.replies())
        second = self.inputs()[1]
        self.assertEqual(second['event']['pending_pointer'], 'Heads up: this conflicts with the brief.')
        self.assertEqual([l['id'] for l in second['lines']], ['t-s2'])
        self.assertEqual([r['result'] for r in self.results()][:2], ['overtaken', 'published'])
        self.assertEqual(self.responder.shown, ['Still true.'])

    def test_a_rechecked_pointer_survives_new_speech(self):
        self.start([{'text': P, 'delay': .6}, {'text': 'Still true.\nSOURCES: t-s1', 'delay': .6}])
        self.until(lambda: self.inputs())
        self.append('line s2', sid='s2')
        self.until(lambda: len(self.inputs()) == 2)
        self.append('line s3', sid='s3')
        self.until(lambda: self.replies())
        self.assertEqual([r['result'] for r in self.results()][:2], ['overtaken', 'published'])
        self.assertEqual(self.responder.shown, ['Still true.'])

    def test_a_recheck_that_finds_it_stale_stays_silent(self):
        self.start([{'text': P, 'delay': .6}, {'text': 'NO_POINTER'}])
        self.until(lambda: self.inputs())
        self.append('Actually that is settled now', sid='s2')
        self.until(lambda: len(self.results()) == 2)
        self.assertEqual(self.replies(), [])
        self.assertIsNone(self.responder.held)

    def test_question_overtaken_once_then_reasked(self):
        self.start([{'text': 'NO_POINTER'}, {'text': 'Friday.\nSOURCES: t-s1', 'delay': .6},
                    {'text': 'Monday now.\nSOURCES: t-s2'}])
        self.until(lambda: self.results())
        self.command('ask', {'question': 'When is launch?'})
        self.until(lambda: len(self.inputs()) == 2)
        self.append('Launch moved to Monday', sid='s2')
        self.until(lambda: self.replies())
        third = self.inputs()[2]
        self.assertEqual(third['event'], {'kind': 'question', 'question': 'When is launch?'})
        self.assertEqual([l['id'] for l in third['lines']], ['t-s2'])
        self.assertEqual(self.replies()[0]['text'], 'Monday now.')

    def test_lines_said_with_pointers_off_reach_the_next_turn(self):
        self.start([{'text': 'Friday.\nSOURCES: t-s1'}], proactive=False)
        self.until(lambda: any(r.get('result') == 'passed' for r in self.results()))
        self.append('A line while pointers are off', sid='s2')
        self.until(lambda: len(self.results()) == 2)
        self.assertEqual(self.inputs(), [])
        self.command('ask', {'question': 'What did they say?'})
        self.until(lambda: self.replies())
        self.assertEqual([l['id'] for l in self.inputs()[0]['lines']], ['t-s1', 't-s2'])

    def test_bad_answers_fail_visibly(self):
        self.start([{'text': 'NO_POINTER'}, {'text': 'Made up.\nSOURCES: t-invented'}, {'text': 'NO_POINTER'},
                    {'text': ''}], proactive=True)
        self.until(lambda: self.results())
        for question in ('Who?', 'What?', 'Why?'):
            self.command('ask', {'question': question})
            self.until(lambda: self.command('snapshot')['questions'][-1]['status'] == 'failed')
        self.assertEqual(self.replies(), [])

    def test_seven_citations_trimmed_and_older_context(self):
        self.append('second', sid='s2')
        cites = ', '.join(['t-s1', 't-s2'] * 4)
        self.start([{'text': f'Recap.\nSOURCES: {cites}'}])
        self.until(lambda: self.replies())
        self.assertEqual(self.replies()[0]['sources'], ['t-s1', 't-s2'])
        self.assertEqual(responder.parse('x\nSOURCES: ' + ', '.join(f'a{i}' for i in range(9)))[2][:6], [f'a{i}' for i in range(6)])

    def test_timeout_interrupts_and_fails(self):
        responder.TURN_SECONDS = .3
        self.addCleanup(setattr, responder, 'TURN_SECONDS', 20)
        self.start([{'text': 'NO_POINTER'}, {'text': 'too slow', 'delay': 5, 'late': True}, {'text': 'Fine.\nSOURCES: t-s1'}])
        self.until(lambda: self.results())
        self.command('ask', {'question': 'Slow one?'})
        self.until(lambda: self.command('snapshot')['questions'][-1]['status'] == 'failed')
        self.command('ask', {'question': 'Fast one?'})
        self.until(lambda: self.replies())
        self.assertEqual(self.replies()[0]['text'], 'Fine.')

    def test_stop_mid_turn_interrupts_and_exits(self):
        self.start([{'text': P, 'delay': 5}])
        self.until(lambda: self.inputs())
        self.command('stop')
        self.thread.join(5)
        self.assertFalse(self.thread.is_alive())
        self.assertEqual(self.replies(), [])

    def test_codex_death_ends_sharing_with_reason(self):
        self.start([{'die': True}])
        self.thread.join(8)
        snapshot = self.command('snapshot')
        self.assertEqual((self.outcome['error'], snapshot['sharing']), ('terra_unavailable', False))
        self.assertEqual(snapshot['feed_error'], bridge.TERRA_ERRORS['terra_unavailable'])

    def test_tool_item_trips_and_ends_sharing(self):
        self.start([{'text': P, 'items': ['commandExecution']}])
        self.thread.join(8)
        self.assertEqual(self.outcome['error'], 'terra_tool')
        self.assertEqual(self.replies(), [])
        self.assertIn('tool', self.command('snapshot')['feed_error'])

    def test_tool_attempt_discards_the_turn_but_keeps_sharing(self):
        self.start([{'text': P, 'inferences': 2}, {'text': P}])
        self.until(lambda: self.results())
        self.assertEqual(self.results()[0]['result'], 'passed')
        self.assertEqual(self.replies(), [])
        self.assertTrue(self.command('snapshot')['sharing'])

    def test_stale_turn_output_never_reaches_the_next_answer(self):
        responder.TURN_SECONDS = .3
        self.addCleanup(setattr, responder, 'TURN_SECONDS', 20)
        self.start([{'text': 'NO_POINTER'}, {'text': 'slow', 'delay': 5}, {'text': 'Fresh.\nSOURCES: t-s1', 'stale': True}])
        self.until(lambda: self.results())
        self.command('ask', {'question': 'Slow one?'})
        self.until(lambda: self.command('snapshot')['questions'][-1]['status'] == 'failed')
        self.command('ask', {'question': 'Next one?'})
        self.until(lambda: self.replies())
        self.assertEqual(self.replies()[0]['text'], 'Fresh.')

    def test_unexpected_notification_trips(self):
        self.start([{'text': P, 'notify': 'command/exec/outputDelta'}])
        self.thread.join(8)
        self.assertEqual(self.outcome['error'], 'terra_tool')
        self.assertEqual(self.replies(), [])

    def test_stop_during_stalled_startup_reaps_codex(self):
        os.environ['FAKE_CODEX_INIT_DELAY'] = '20'
        self.addCleanup(os.environ.pop, 'FAKE_CODEX_INIT_DELAY')
        self.start([{'text': P}])
        self.until(lambda: self.responder.server)
        self.command('stop')
        self.thread.join(5)
        self.assertFalse(self.thread.is_alive())
        self.assertIsNotNone(self.responder.server.proc.poll())

    def test_codex_death_while_idle_ends_sharing(self):
        self.start([{'text': 'NO_POINTER', 'exit_after': True}], proactive=True)
        self.thread.join(12)
        self.assertFalse(self.thread.is_alive())
        self.assertEqual(self.outcome['error'], 'terra_unavailable')
        self.assertFalse(self.command('snapshot')['sharing'])

    def test_large_listing_and_launcher_children_are_handled(self):
        big = [{'name': f'server{i}', 'enabled': True, 'pad': 'x' * 900} for i in range(300)]
        script = f'import json; print(json.dumps({big!r}))'
        self.assertEqual(len(responder.list_servers([sys.executable, '-c', script], lambda: False, [])), 300)
        # A launcher whose child keeps running: Stop must leave no survivor.
        marker = self.data / 'child.pid'
        launcher = (f'import subprocess, time; p = subprocess.Popen([{sys.executable!r}, "-c", "import time; time.sleep(60)"]);'
                    f' open({str(marker)!r}, "w").write(str(p.pid)); time.sleep(60)')
        stops = iter([False] * 40 + [True] * 1000)
        with self.assertRaises(responder.Dead):
            responder.list_servers([sys.executable, '-c', launcher], lambda: next(stops), [])
        time.sleep(.2)
        child = int(marker.read_text())
        with self.assertRaises(ProcessLookupError):
            os.kill(child, 0)

    def test_version_probe_is_owned_and_stoppable(self):
        children = []
        slow = [sys.executable, '-c', 'import time; time.sleep(30)']
        started = time.monotonic()
        self.assertIsNone(responder.codex_version(slow, lambda: True, children))
        self.assertLess(time.monotonic() - started, 3)
        self.assertEqual(children, [])

    def test_exited_launcher_child_is_still_stopped(self):
        marker = self.data / 'orphan.pid'
        launcher = (f'import subprocess; p = subprocess.Popen([{sys.executable!r}, "-c", "import time; time.sleep(60)"]);'
                    f' open({str(marker)!r}, "w").write(str(p.pid))')
        proc = subprocess.Popen([sys.executable, '-c', launcher], start_new_session=True)
        proc.wait(5)
        responder.stop_process(proc)
        time.sleep(.2)
        with self.assertRaises(ProcessLookupError):
            os.kill(int(marker.read_text()), 0)

    def test_notification_during_preparation_trips_before_lines_are_sent(self):
        (self.data / 'script.json').write_text('[]')
        os.environ['FAKE_CODEX_SCRIPT'] = str(self.data / 'script.json')
        server = responder.AppServer([sys.executable, '-I', '-B', str(HERE / 'fake_codex.py')], self.data)
        self.addCleanup(server.close)
        server.start('system', lambda: False)
        server.messages.put({'method': 'command/exec/outputDelta', 'params': {}})
        server.last_turn = 'previous-turn'
        with self.assertRaises(responder.Tripped):
            server.turn('{"lines": ["private"]}', lambda: False)
        self.assertEqual(self.inputs(), [], 'no meeting lines may be sent after an unscreened notification')
        self.assertIsNone(server.last_turn, 'a turn that never started must not take the previous turn id')

    def test_startup_notification_trips_before_the_brief_is_sent(self):
        server = responder.AppServer([sys.executable, '-I', '-B', str(HERE / 'fake_codex.py')], self.data)
        self.addCleanup(server.close)
        server.messages.put({'method': 'command/exec/outputDelta', 'params': {}})
        with self.assertRaises(responder.Tripped):
            server.start('system', lambda: False)
        sent = self.log.read_text() if self.log.exists() else ''
        self.assertNotIn('"system"', sent, 'the brief must not be sent after a tripped notification')

    def test_sources_line_must_be_last(self):
        self.assertIsNone(responder.parse('Launch Friday.\nSOURCES: t-s1\nCorrection: Monday.')[1])
        self.assertEqual(responder.parse('Launch Friday.\nSOURCES: t-s1\n')[1:], ('Launch Friday.', ['t-s1']))

    def test_reply_without_sources_line_fails(self):
        self.start([{'text': 'NO_POINTER'}, {'text': 'Friday, probably.'}])
        self.until(lambda: self.results())
        self.command('ask', {'question': 'When?'})
        self.until(lambda: self.command('snapshot')['questions'][-1]['status'] == 'failed')
        self.assertEqual(self.replies(), [])

    def test_gap_note_when_lines_rolled_out_unseen(self):
        r = responder.Responder(bridge, self.folder, self.run, 'x', [], self.data)
        r.take_lines([{'id': 't-a', 'text': 'a'}])
        r.take_lines([{'id': 't-c', 'text': 'c'}])
        self.assertEqual(r.backlog[1], {'note': 'Some lines are missing here; they left the shared window before you saw them.'})
        r.take_lines([{'id': 't-c', 'text': 'c2'}, {'id': 't-d', 'text': 'd', 'source': 'you'}])
        self.assertEqual(r.backlog[-2:], [{'id': 't-c', 'speaker': 'other', 'text': 'c2', 'revised': True},
                                          {'id': 't-d', 'speaker': 'you', 'text': 'd'}])


    def test_lines_still_being_spoken_continue_rather_than_revise(self):
        r = responder.Responder(bridge, self.folder, self.run, 'x', [], self.data)
        r.take_lines([{'id': 't-a', 'text': 'we ship on', 'finalized': False}])
        r.take_lines([{'id': 't-a', 'text': 'we ship on Friday', 'finalized': False}])
        r.take_lines([{'id': 't-a', 'text': 'we ship on Friday.', 'finalized': True}])
        r.take_lines([{'id': 't-a', 'text': 'we ship on Monday.', 'finalized': True}])
        self.assertEqual(r.backlog, [
            {'id': 't-a', 'speaker': 'other', 'text': 'we ship on', 'speaking': True},
            {'id': 't-a', 'speaker': 'other', 'text': 'we ship on Friday', 'continued': True, 'speaking': True},
            {'id': 't-a', 'speaker': 'other', 'text': 'we ship on Friday.', 'continued': True},
            {'id': 't-a', 'speaker': 'other', 'text': 'we ship on Monday.', 'revised': True}])
        self.assertEqual(r.unsent_lines([{'id': 't-a', 'text': 'we ship on Monday.', 'finalized': True}]), r.backlog)

class ParentExitTest(unittest.TestCase):
    """Handy force-killed: the stdin pipe closes and the responder reaps codex itself."""

    def test_a_memory_failure_stops_sharing_at_once(self):
        call = ResponderTest('test_no_pointer_is_silent')
        call.setUp_call()
        self.addCleanup(call.temp.cleanup)
        (call.root / 'bridge.py').write_bytes((HERE / 'bridge.py').read_bytes())
        (call.root / 'memory.py').write_text('def compile(root):\n    raise ValueError("broken")\n')
        token = call.command('connect_codex', {'proactive': True})['connection']['id']
        proc = subprocess.Popen([sys.executable, '-I', '-B', str(HERE / 'responder.py'), str(call.root), call.run, token],
                                stdin=subprocess.PIPE)
        proc.stdin.write(b'go\n'); proc.stdin.flush()
        self.assertEqual(proc.wait(10), 0)
        proc.stdin.close()
        self.assertIn(call.command('snapshot', {})['status'], ('disabled', 'expired'))

    def test_stdin_eof_reaps_codex(self):
        call = ResponderTest('test_no_pointer_is_silent')
        call.setUp_call()
        self.addCleanup(call.temp.cleanup)
        for helper in ('bridge.py', 'memory.py'):
            (call.root / helper).write_bytes((HERE / helper).read_bytes())
        bin_dir = call.data / 'bin'; bin_dir.mkdir()
        fake = bin_dir / 'codex'
        fake.write_text(f'#!/bin/sh\nexec {sys.executable} -I -B {HERE / "fake_codex.py"} "$@"\n')
        fake.chmod(0o700)
        script = call.data / 'script.json'; script.write_text(json.dumps([{'text': P, 'delay': 30}]))
        env = dict(os.environ, PATH=f'{bin_dir}:{os.environ["PATH"]}', FAKE_CODEX_SCRIPT=str(script),
                   FAKE_CODEX_LOG=str(call.data / 'fake.jsonl'), HOME=str(call.data))
        token = call.command('connect_codex', {'proactive': True})['connection']['id']
        proc = subprocess.Popen([sys.executable, '-I', '-B', str(HERE / 'responder.py'), str(call.root), call.run, token],
                                stdin=subprocess.PIPE, env=env, start_new_session=True)
        proc.stdin.write(b'go\n'); proc.stdin.flush()
        deadline = time.monotonic() + 8
        while not (call.data / 'fake.jsonl').exists() or '"input"' not in (call.data / 'fake.jsonl').read_text():
            self.assertLess(time.monotonic(), deadline)
            time.sleep(.05)
        fake_pid = json.loads((call.data / 'fake.jsonl').read_text().splitlines()[0])['pid']
        proc.stdin.close()
        self.assertEqual(proc.wait(5), 0)
        time.sleep(.2)
        with self.assertRaises(ProcessLookupError):
            os.kill(fake_pid, 0)
        time.sleep(.2)
        alive = subprocess.run(['pgrep', '-g', str(proc.pid)], capture_output=True, text=True).stdout.split()
        if alive:
            os.killpg(proc.pid, signal.SIGKILL)
        self.assertEqual(alive, [], 'no process of the responder group may survive')


class GoBarrierTest(unittest.TestCase):
    """Terra gate: a responder refused after its spawn starts no work and no codex."""

    def test_closed_pipe_before_go_exits_without_touching_anything(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)  # empty: any bridge or memory read would fail loudly
            proc = subprocess.Popen([sys.executable, '-I', '-B', str(HERE / 'responder.py'), str(root), 'meeting-x', 'c'],
                                    stdin=subprocess.PIPE, stderr=subprocess.PIPE)
            proc.stdin.close()
            self.assertEqual(proc.wait(5), 0)
            self.assertEqual(proc.stderr.read(), b'')
            proc.stderr.close()
            self.assertEqual(list(root.iterdir()), [], 'a refused responder created files')

    def test_go_must_be_exact(self):
        for data, expected in ((b'go\n', True), (b'', False), (b'no\n', False), (b'gogo\n', False)):
            r, w = os.pipe()
            os.write(w, data); os.close(w)
            self.assertEqual(responder.wait_for_go(r), expected, data)
            os.close(r)


if __name__ == '__main__':
    unittest.main()
