"""R1: Terra rating capture, real bridge and scripted app-server."""
import json
import os
from pathlib import Path
import stat
import unittest
import bridge
import responder
import test_responder

P = test_responder.P


class RatingTest(unittest.TestCase):
    for name in ('setUp', 'start', 'finish', 'until', 'inputs', 'results', 'replies', 'command', 'append', 'manifest', 'setUp_call'):
        locals()[name] = getattr(test_responder.ResponderTest, name)

    def raw_inputs(self):
        return [json.loads(l)['raw'] for l in self.log.read_text().splitlines() if '"raw"' in l]

    def mark(self, rating, event_id=None, note=''):
        return self.command('rate', {'event_id': event_id, 'rating': rating, 'note': note})

    def settled(self, mark_id):
        def done():
            mark = next(m for m in self.command('snapshot')['marks'] if m['id'] == mark_id)
            return mark if mark['status'] in ('saved', 'failed') else None
        return self.until(done)

    def case(self, mark_id):
        return self.data / 'terra-cases' / self.run / f'{mark_id}.json'

    def test_good_mark_saves_exact_turns_privately(self):
        self.start([{'text': 'NO_POINTER'}, {'text': P}])
        self.until(lambda: self.results())
        self.append('Second line', sid='s2')
        self.until(lambda: self.replies())
        event_id = self.replies()[0]['event_id']
        self.assertFalse((self.data / 'terra-cases').exists(), 'no case before a mark')
        mark_id = self.mark('good', event_id, 'useful heads-up')['marks'][-1]['id']
        self.assertEqual(self.settled(mark_id)['status'], 'saved')
        case = json.loads(self.case(mark_id).read_text())
        self.assertEqual([t['message'] for t in case['turns']], self.raw_inputs()[:2])
        self.assertEqual(case['turns'][-1]['event_id'], event_id)
        self.assertEqual(case['turns'][-1]['shown'], 'Heads up: this conflicts with the brief.')
        self.assertEqual(case['turns'][-1]['reply'], P)
        self.assertEqual((case['mark']['rating'], case['mark']['note']), ('good', 'useful heads-up'))
        self.assertEqual(case['prompt']['sha256'], responder.PROMPT_SHA)
        self.assertEqual(case['prompt']['codex'], 'codex-cli fake')
        self.assertEqual((case['prompt']['brief'], case['prompt']['today']), ('Alex is out Nov 12.', 'Tuesday, November 3, 2026'))
        self.assertEqual(case['prompt']['system'], responder.SYSTEM.format(today=case['prompt']['today'], brief=case['prompt']['brief']))
        self.assertEqual(stat.S_IMODE(self.case(mark_id).stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(self.case(mark_id).parent.stat().st_mode), 0o700)
        self.assertNotIn('Second line', (self.data / 'terra.jsonl').read_text(), 'the log still holds no meeting text')
        self.assertNotIn('Second line', json.dumps(self.command('snapshot')['marks']))

    def test_missed_mark_pins_unsent_lines_before_any_turn(self):
        self.start([], proactive=False)
        self.until(lambda: self.results())
        self.append('Something Terra should flag', sid='s2')
        mark_id = self.mark('missed', note='should have warned me')['marks'][-1]['id']
        self.assertEqual(self.settled(mark_id)['status'], 'saved')
        case = json.loads(self.case(mark_id).read_text())
        self.assertEqual(case['turns'], [])
        self.assertEqual([l['id'] for l in case['unsent_lines']], ['t-s1', 't-s2'])
        self.assertEqual(self.inputs(), [], 'a mark never triggers a model turn')

    def test_missed_marks_claimed_together_share_one_moment(self):
        from unittest.mock import patch
        self.start([], proactive=False)
        self.until(lambda: self.results())
        writes = []
        original = responder.write_private

        def write_then_speak(path, value):
            original(path, value)
            writes.append(path)
            if len(writes) == 1:
                self.append('Spoken between the two writes', sid='s9')
        bridge.dispatch(self.root, 'rate', {'event_id': None, 'rating': 'missed', 'note': 'a'}, self.run)
        bridge.dispatch(self.root, 'rate', {'event_id': None, 'rating': 'missed', 'note': 'b'}, self.run)
        with patch.object(responder, 'write_private', side_effect=write_then_speak):
            self.until(lambda: len(writes) == 2)
        a, b = (json.loads(p.read_text())['unsent_lines'] for p in writes)
        self.assertEqual(a, b)
        self.assertNotIn('t-s9', [l['id'] for l in a])

    def test_unknown_reply_fails_the_mark_but_not_sharing(self):
        self.start([{'text': 'NO_POINTER'}])
        self.until(lambda: self.results())
        mark_id = self.mark('bad', 'p999')['marks'][-1]['id']
        mark = self.settled(mark_id)
        self.assertEqual(mark['status'], 'failed')
        self.assertIn('did not publish', mark['error'])
        self.assertTrue(self.command('snapshot')['sharing'])
        self.assertFalse(self.case(mark_id).exists())

    def test_stop_settles_unclaimed_marks(self):
        self.start([{'text': P, 'delay': 3}])
        self.until(lambda: self.inputs())
        mark_id = self.mark('missed')['marks'][-1]['id']
        self.command('stop')
        self.thread.join(5)
        mark = next(m for m in self.command('snapshot')['marks'] if m['id'] == mark_id)
        self.assertEqual(mark['status'], 'failed')

    def test_marks_of_a_dead_responder_read_as_failed(self):
        self.command('connect_codex', {'proactive': False})
        self.mark('missed')
        state = bridge.read(self.folder / 'state.json')
        state['marks'][0]['status'] = 'claimed'
        state['deadline_ms'] = 1  # the run expired: no heartbeat from a dead responder
        bridge.save(self.folder / 'state.json', state)
        mark = self.command('snapshot')['marks'][0]
        self.assertEqual((mark['status'], mark['error']), ('failed', 'Terra stopped before saving this mark'))

    def test_mark_validation(self):
        # No responder runs here, so marks stay pending and the cap is reachable.
        self.command('connect_codex', {'proactive': False})
        for bad in ({'event_id': None, 'rating': 'good', 'note': ''}, {'event_id': 'p1', 'rating': 'missed', 'note': ''},
                    {'event_id': 'p1', 'rating': 'meh', 'note': ''}, {'event_id': 'p1', 'rating': 'bad', 'note': 'x' * 281}):
            with self.assertRaises(ValueError): self.command('rate', bad)
        for _ in range(8):
            bridge.dispatch(self.root, 'rate', {'event_id': None, 'rating': 'missed', 'note': ''}, self.run)
        with self.assertRaises(ValueError): self.mark('missed')

    def test_fingerprint_tracks_template_not_brief(self):
        a = responder.Responder(bridge, self.folder, self.run, 'x', [], self.data, brief='one', today='d1')
        b = responder.Responder(bridge, self.folder, self.run, 'x', [], self.data, brief='two', today='d2')
        self.assertNotEqual(a.system, b.system)
        self.assertEqual(len(responder.PROMPT_SHA), 64)
        import hashlib
        self.assertEqual(responder.PROMPT_SHA, hashlib.sha256(responder.SYSTEM.encode()).hexdigest())


class OtherRoutesTest(unittest.TestCase):
    setUp = test_responder.ResponderTest.setUp_call
    command = test_responder.ResponderTest.command
    manifest = test_responder.ResponderTest.manifest
    append = test_responder.ResponderTest.append

    def test_marks_need_the_terra_route(self):
        self.command('controls', {'sharing': True, 'proactive': False})
        with self.assertRaises(ValueError):
            self.command('rate', {'event_id': None, 'rating': 'missed', 'note': ''})


if __name__ == '__main__':
    unittest.main()
