import json
import os
from pathlib import Path
import tempfile
import unittest

import observatory as o

ID = '20261030T100000.000000000'
SESSION = {'id': ID, 'title': 'Fictional sync', 'started_at': '2026-10-30T10:00:00+00:00'}
T0 = 1793354400000


def journal(rows):
    return ''.join(json.dumps({'seq': i + 1, 'pid': 1, **row}) + '\n' for i, row in enumerate(rows))


class ObservatoryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.data = Path(self.temp.name)
        self.worker = self.data / 'call-feed-replays' / 'meeting-w'; self.worker.mkdir(parents=True)
        self.terra = self.data / 'assistie' / 'meeting-t'; self.terra.mkdir(parents=True)
        (self.worker / 'request.json').write_text(json.dumps({'session': SESSION}))
        (self.terra / 'state.json').write_text(json.dumps({'call_binding': {'call_id': ID}}))

    def worker_journal(self, tail=''):
        rows = [{'kind': 'run', 'event': 'start', 'epoch_ms': T0 + 100},
                {'kind': 'engine', 'event': 'ready', 'engine_id': '1', 'epoch_ms': T0 + 200},
                {'kind': 'line', 'stage': 'guess', 'line': 'asr-a', 'source': 'you', 'text': 'we', 'audio_ms': [0, 500], 'file': 'mic-0.wav', 'engine_id': '1', 'epoch_ms': T0 + 600},
                {'kind': 'line', 'stage': 'final', 'line': 'asr-a', 'source': 'you', 'text': 'we ship', 'audio_ms': [0, 900], 'file': 'mic-0.wav', 'engine_id': '1', 'epoch_ms': T0 + 1200},
                {'kind': 'line', 'stage': 'dropped', 'line': 'asr-a', 'reason': 'echo', 'epoch_ms': T0 + 1300}]
        (self.worker / 'worker-journal.jsonl').write_text(journal(rows) + tail)

    def terra_journal(self):
        rows = [{'kind': 'session', 'model': 'gpt-6.1-terra', 'effort': 'low', 'brief': 'facts', 'epoch_ms': T0},
                {'kind': 'event', 'event_id': 'p1', 'event_kind': 'pointer', 'epoch_ms': T0 + 1300},
                {'kind': 'request', 'event_id': 'p1', 'turn_id': 'x', 'message': '{}', 'lines': [{'id': 't-asr-a', 'text': 'we ship'}], 'epoch_ms': T0 + 1300},
                {'kind': 'started', 'event_id': 'p1', 'turn_id': 'x', 'epoch_ms': T0 + 1310},
                {'kind': 'usage', 'turn_id': 'x', 'total': {'inputTokens': 10, 'cachedInputTokens': 4, 'outputTokens': 2, 'reasoningOutputTokens': 0, 'totalTokens': 12}, 'epoch_ms': T0 + 1400},
                {'kind': 'output', 'event_id': 'p1', 'turn_id': 'x', 'status': 'completed', 'raw': 'NO_POINTER', 'epoch_ms': T0 + 1500},
                {'kind': 'settle', 'event_id': 'p1', 'reason': 'silent', 'why': 'silent', 'epoch_ms': T0 + 1510}]
        (self.terra / 'terra-journal.jsonl').write_text(journal(rows))

    def load(self):
        return o.view(o.export(*o.discover(self.data, ID)))

    def test_joins_lines_turns_and_tokens(self):
        self.worker_journal(); self.terra_journal()
        doc = self.load()
        self.assertEqual(doc['call']['clock'], 'session start')
        line = doc['lines']['asr-a']
        self.assertEqual([r['text'] for r in line['revisions']], ['we', 'we ship'])
        self.assertEqual(line['dropped']['reason'], 'echo')
        turn = doc['turns'][0]
        self.assertTrue(turn['complete'])
        self.assertEqual(turn['tokens']['totalTokens'], 12)
        self.assertEqual(doc['sessions'][0]['model'], 'gpt-6.1-terra')
        self.assertEqual(doc['problems'], [])

    def test_view_leaves_out_what_the_page_never_shows(self):
        self.worker_journal(); self.terra_journal()
        doc = self.load()
        self.assertNotIn('feed', doc); self.assertNotIn('sources', doc); self.assertNotIn('transcript_final', doc)
        self.assertNotIn('prov', doc['turns'][0])
        self.assertNotIn('prov', doc['lines']['asr-a']['revisions'][0])

    def test_a_call_with_no_journals_is_empty_and_says_so(self):
        doc = self.load()
        self.assertEqual(doc['lines'], {}); self.assertEqual(doc['turns'], [])
        self.assertEqual(len(doc['problems']), 2)

    def test_two_runs_of_one_call_never_mix(self):
        self.worker_journal(); self.terra_journal()
        (self.terra / 'state.json').write_text(json.dumps({'call_binding': {'call_id': ID, 'local_run_id': 'meeting-w'}}))
        old = self.data / 'call-feed-replays' / 'meeting-old'; old.mkdir()
        (old / 'request.json').write_text(json.dumps({'session': SESSION}))
        (old / 'worker-journal.jsonl').write_text(journal([{'kind': 'line', 'stage': 'final', 'line': 'asr-old', 'source': 'you', 'text': 'old run', 'audio_ms': [0, 1], 'epoch_ms': T0}]))
        stale = self.data / 'assistie' / 'meeting-stale'; stale.mkdir()
        (stale / 'state.json').write_text(json.dumps({'call_binding': {'call_id': ID, 'local_run_id': 'meeting-old'}}))
        os.utime(old / 'request.json', (1, 1))
        doc = self.load()
        self.assertEqual(list(doc['lines']), ['asr-a'])
        self.assertEqual(o.discover(self.data, ID)[1], [self.terra])

    def test_an_unknown_call_is_empty(self):
        doc = o.view(o.export(*o.discover(self.data, 'other')))
        self.assertEqual((doc['lines'], doc['turns'], doc['problems']), ({}, [], []))

    def test_a_row_cut_short_is_reported_and_the_rest_survive(self):
        self.worker_journal('{"seq": 6, "kind": "li')
        doc = self.load()
        self.assertIn('asr-a', doc['lines'])
        self.assertTrue(any('cut short' in p for p in doc['problems']))

    def test_an_unreadable_file_does_not_stop_the_join(self):
        self.worker_journal(); self.terra_journal()
        (self.data / 'call-feed-replays' / 'meeting-bad').mkdir()
        (self.data / 'call-feed-replays' / 'meeting-bad' / 'request.json').write_text('{"session')
        (self.terra / 'reply-000001.json').write_text('{"reply')
        doc = self.load()
        self.assertIn('asr-a', doc['lines'])
        self.assertTrue(any('unreadable reply' in p for p in doc['problems']))


if __name__ == '__main__':
    unittest.main()
