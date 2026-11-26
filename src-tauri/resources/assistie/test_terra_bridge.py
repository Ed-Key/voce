"""Bridge rows of the Terra route state table."""
import json
import subprocess
import sys
import unittest
from pathlib import Path
from unittest.mock import patch
import bridge
import test_bridge


class TerraRouteTest(unittest.TestCase):
    setUp = test_bridge.CallConsentTest.setUp
    manifest = test_bridge.CallConsentTest.manifest
    append = test_bridge.CallConsentTest.append
    command = test_bridge.CallConsentTest.command

    def connect(self, proactive=True):
        snapshot = self.command('connect_codex', {'proactive': proactive})
        self.token = snapshot['connection']['id']
        return snapshot

    def wait(self, seconds=.05):
        return bridge.wait(self.folder, self.run, seconds, connection_id=self.token)

    def scoped(self, command, value):
        return bridge.mutate(self.folder, command, value, self.run, connection_id=self.token, scoped_worker=True)

    def reply(self, event, sources=('t-s1',), **extra):
        return self.scoped('reply', {'event_id': event['event_id'], 'text': 'A fictional reply.', 'sources': list(sources), **extra})

    def test_a_rechecked_pointer_survives_new_speech_but_not_a_correction(self):
        self.connect()
        self.assertEqual(self.reply(self.wait())['status'], 'published')
        self.append('First new line', sid='s2')
        held = self.wait()
        self.append('Second new line', sid='s3')
        self.assertEqual(self.reply(held, ['t-s2'])['status'], 'overtaken')
        recheck = self.wait()
        self.append('Third new line', sid='s4')
        self.assertEqual(self.reply(recheck, ['t-s2'], rechecked=True)['status'], 'published')

    def test_a_corrected_line_still_stops_a_rechecked_pointer(self):
        self.connect()
        self.assertEqual(self.reply(self.wait())['status'], 'published')
        self.append('The launch is Friday', sid='s2')
        recheck = self.wait()
        self.append('The launch is Monday', sid='s2')
        self.assertEqual(self.reply(recheck, ['t-s2'], rechecked=True)['status'], 'outdated')

    def test_rechecked_must_be_true(self):
        self.connect()
        with self.assertRaises(ValueError):
            self.reply(self.wait(), rechecked=False)

    def test_connection_is_owned_by_terra(self):
        snapshot = self.connect()
        self.assertEqual((snapshot['transport'], snapshot['status']), ('codex', 'waiting'))
        self.assertEqual(bridge.wait(self.folder, self.run, .01, connection_id='wrong'), {'status': 'superseded'})
        self.assertEqual(self.wait()['kind'], 'pointer')
        self.assertEqual(self.command('snapshot')['transport'], 'codex')
        with self.assertRaises(ValueError): self.command('handoff')
        self.assertEqual(bridge.dispatch(self.root, 'plugin_read', {}, self.run), {'status': 'disabled'})
        with self.assertRaises(ValueError): self.command('connect', {'proactive': True})
        self.assertEqual(self.connect()['connection']['id'], self.token)

    def test_every_version_gets_one_event_and_pointers_off_still_records_lines(self):
        self.connect(proactive=False)
        event = self.wait()
        self.assertEqual((event['kind'], event['transcript']['sources'][0]['text']), ('transcript', 'Friday only after review'))
        self.assertEqual(self.scoped('pass', {'event_id': event['event_id'], 'reason': 'ack'})['status'], 'passed')
        self.assertEqual(self.scoped('pass', {'event_id': event['event_id'], 'reason': 'ack'})['duplicate'], True)
        self.assertEqual(self.wait(), {'status': 'timeout'})
        self.append('Monday instead', sid='s2')
        self.assertEqual(self.wait()['kind'], 'transcript')

    def test_pointer_released_or_overtaken(self):
        self.connect()
        event = self.wait()
        self.assertEqual(self.reply(event)['status'], 'published')
        self.append('Actually, scrap that', sid='s2')
        later = self.wait()
        self.append('One more line', sid='s3')
        self.assertEqual(self.reply(later, ['t-s2'])['status'], 'overtaken')
        revalidate = self.wait()
        self.assertEqual(revalidate['kind'], 'pointer')
        self.assertEqual([s['id'] for s in revalidate['transcript']['sources']], ['t-s1', 't-s2', 't-s3'])
        self.assertEqual(self.scoped('pass', {'event_id': revalidate['event_id'], 'reason': 'silent'})['status'], 'passed')
        self.assertEqual(len(self.command('snapshot')['replies']), 1)

    def test_pointer_requested_before_off_on_toggle_is_suppressed(self):
        self.connect()
        event = self.wait()
        self.command('controls', {'sharing': True, 'proactive': False})
        self.command('controls', {'sharing': True, 'proactive': True})
        self.assertEqual(self.reply(event)['status'], 'suppressed')

    def test_answer_gets_one_refresh_then_publishes_on_new_lines(self):
        self.connect(proactive=False)
        self.scoped('pass', {'event_id': self.wait()['event_id'], 'reason': 'ack'})
        self.command('ask', {'question': 'When is launch?'})
        first = self.wait()
        self.append('Kenji owns notes now', sid='s2')
        self.assertEqual(self.reply(first)['status'], 'overtaken')
        second = self.wait()
        self.assertEqual((second['kind'], second['question_id']), ('answer', first['question_id']))
        self.assertNotEqual(second['event_id'], first['event_id'])
        self.append('A third line', sid='s3')
        self.assertEqual(self.reply(second, ['t-s2'])['status'], 'published')
        answer = self.command('snapshot')['replies'][-1]
        self.assertEqual((answer['author'], answer['quotes'][0]['text']), ('terra_responder', 'Kenji owns notes now'))

    def test_answer_fails_when_its_cited_line_changes_after_the_refresh(self):
        self.connect(proactive=False)
        self.scoped('pass', {'event_id': self.wait()['event_id'], 'reason': 'ack'})
        self.command('ask', {'question': 'When is launch?'})
        first = self.wait()
        self.append('Friday, revised', sid='s1')
        self.assertEqual(self.reply(first)['status'], 'outdated')
        second = self.wait()
        self.append('Friday, revised again', sid='s1')
        self.assertEqual(self.reply(second)['status'], 'failed')
        snapshot = self.command('snapshot')
        self.assertEqual(snapshot['questions'][-1]['status'], 'failed')
        self.command('ask', {'question': 'Can I ask again after a failure?'})

    def test_growth_rule(self):
        self.assertTrue(bridge.grew('we should ship it on', 'We should ship it on Friday.'))
        self.assertFalse(bridge.grew('we should ship it on fri', 'we should ship it on Friday'))  # a half word is not trusted
        self.assertFalse(bridge.grew('we can', 'we cannot'))
        self.assertFalse(bridge.grew('the budget is 15', 'the budget is 150'))
        self.assertTrue(bridge.grew('we should', 'we should'))
        self.assertFalse(bridge.grew('we can go', 'we cannot go'))
        self.assertFalse(bridge.grew('ship it friday', 'ship it'))
        self.assertFalse(bridge.grew('', 'anything'))

    def test_a_line_still_being_spoken_grows_under_an_answer_without_spending_its_refresh(self):
        # Streaming rows 9: growth and finalizing keep an answer; a replaced word does not.
        self.connect(proactive=False)
        self.scoped('pass', {'event_id': self.wait()['event_id'], 'reason': 'ack'})
        self.append('we should ship it on', sid='s2', finalized=False)
        self.scoped('pass', {'event_id': self.wait()['event_id'], 'reason': 'ack'})
        self.command('ask', {'question': 'When is launch?'})
        first = self.wait()
        self.append('we should ship it on Friday after', sid='s2', finalized=False)
        self.assertEqual(self.reply(first, ['t-s2'])['status'], 'published')
        self.assertEqual(self.command('snapshot')['replies'][-1]['quotes'][0]['text'], 'we should ship it on')
        self.scoped('pass', {'event_id': self.wait()['event_id'], 'reason': 'ack'})
        self.command('ask', {'question': 'Is that final?'})
        second = self.wait()
        self.append('We should ship it on Friday after review.', sid='s2')
        self.assertEqual(self.reply(second, ['t-s2'])['status'], 'published')
        self.assertIsNone(self.command('snapshot')['replies'][0]['source_status'])  # the first answer's quote still holds
        self.scoped('pass', {'event_id': self.wait()['event_id'], 'reason': 'ack'})
        self.append('we might ship', sid='s3', finalized=False)
        self.scoped('pass', {'event_id': self.wait()['event_id'], 'reason': 'ack'})
        self.command('ask', {'question': 'Who ships?'})
        third = self.wait()
        self.append('we must ship', sid='s3', finalized=False)
        self.assertEqual(self.reply(third, ['t-s3'])['status'], 'outdated')

    def test_window_eviction_is_not_a_correction(self):
        self.connect(proactive=False)
        self.scoped('pass', {'event_id': self.wait()['event_id'], 'reason': 'ack'})
        self.command('ask', {'question': 'When is launch?'})
        first = self.wait()
        self.append('Newer line', sid='s2')
        self.assertEqual(self.reply(first)['status'], 'overtaken')
        second = self.wait()
        self.append(None, removals=['s1'])
        self.assertEqual(self.reply(second)['status'], 'published')
        reply = self.command('snapshot')['replies'][-1]
        self.assertEqual((reply['sources'], reply['quotes'], reply['source_status']), ([], [], 'outside_window'))

    def test_failed_turn_and_older_context(self):
        self.connect(proactive=False)
        self.scoped('pass', {'event_id': self.wait()['event_id'], 'reason': 'ack'})
        self.command('ask', {'question': 'What did we say at the start?'})
        event = self.wait()
        self.assertEqual(self.scoped('pass', {'event_id': event['event_id'], 'reason': 'failed'})['status'], 'passed')
        self.assertEqual(self.command('snapshot')['questions'][-1]['status'], 'failed')
        self.command('ask', {'question': 'And the very first decision?'})
        event = self.wait()
        with self.assertRaises(ValueError): self.reply(event, [])
        with self.assertRaises(ValueError): self.reply(event, ['t-never-sent'])
        with self.assertRaises(ValueError): self.reply(event, [], older_context=False)
        self.assertEqual(self.reply(event, [], older_context=True)['status'], 'published')
        reply = self.command('snapshot')['replies'][-1]
        self.assertEqual((reply['quotes'], reply['source_status']), ([], 'outside_window'))
        self.assertNotIn('older_context', reply)

    def test_other_routes_keep_their_envelope_and_limits(self):
        self.command('controls', {'sharing': True, 'proactive': False})
        self.command('ask', {'question': 'What is the agreed launch?'})
        event = bridge.wait(self.folder, self.run, .05)
        with self.assertRaises(ValueError):
            bridge.mutate(self.folder, 'reply', {'event_id': event['event_id'], 'text': 'x', 'sources': [], 'older_context': True}, self.run)
        with self.assertRaises(ValueError):
            bridge.mutate(self.folder, 'pass', {'event_id': event['event_id'], 'reason': 'silent'}, self.run)
        self.assertEqual(bridge.limits(bridge.read(self.folder / 'state.json'))['events'], 128)
        self.assertEqual(bridge.limits({'transport': 'codex'})['events'], 4000)

    def test_scoped_cli_accepts_pass_and_stop_ends_the_route(self):
        self.connect()
        event = self.wait()
        helper = Path(bridge.__file__)
        run = lambda *args, data='{}': json.loads(subprocess.run([sys.executable, '-I', '-B', str(helper), *args, str(self.folder), self.run, self.token], input=data, capture_output=True, text=True).stdout)
        self.assertEqual(run('pass', data=json.dumps({'event_id': event['event_id'], 'reason': 'silent'}))['status'], 'passed')
        self.assertEqual(run('stop')['status'], 'disabled')
        self.assertEqual(self.wait(), {'status': 'disabled'})


class TerraFeedTest(unittest.TestCase):
    manifest = TerraRouteTest.manifest
    append = TerraRouteTest.append
    command = TerraRouteTest.command
    connect = TerraRouteTest.connect
    wait = TerraRouteTest.wait
    scoped = TerraRouteTest.scoped
    reply = TerraRouteTest.reply

    def setUp(self):
        TerraRouteTest.setUp(self)
        self.connect()

    def feed(self, before=None, after=None, limit=50):
        return self.command('feed', {'before': before, 'after': after, 'limit': limit})

    def publish(self, kind):
        n = bridge.read(self.folder / 'state.json').get('reply_count', 0) + 1
        if kind == 'answer':
            self.command('ask', {'question': f'Fictional question {n}?'})
        else:
            self.append(f'Fictional line {n}', sid=f'feed-{n}')
        event = self.wait()
        self.assertEqual(event['kind'], kind)
        self.assertEqual(self.reply(event)['status'], 'published')
        return event

    def test_feed_shrinks_a_page_that_would_exceed_the_reply_limit(self):
        for kind in ('answer', 'pointer', 'answer', 'pointer'):
            self.publish(kind)
        full = self.feed(limit=4)
        # Measured as printed: json.dumps escapes non-ASCII, so that is the size Handy receives.
        one_item = len(bridge.json.dumps({**full, 'items': full['items'][-1:]}))
        with patch.object(bridge, 'FEED_BYTES', one_item + 10):
            newest = self.feed(limit=4)
            oldest = self.feed(after=0, limit=4)
        self.assertEqual([item['n'] for item in newest['items']], [4], 'paging back keeps the newest reply')
        self.assertTrue(newest['more_before'])
        self.assertEqual([item['n'] for item in oldest['items']], [1], 'reading forward keeps the oldest reply')

    def test_feed_pages_long_run_with_questions(self):
        events = [self.publish(kind) for kind in ('answer', 'pointer', 'answer', 'pointer', 'answer')]
        self.assertEqual(len(bridge.read(self.folder / 'state.json')['replies']), 3)
        for request, expected in (({'limit': 2}, [4, 5]),
                                  ({'before': 4, 'limit': 2}, [2, 3]),
                                  ({'after': 3, 'limit': 10}, [4, 5])):
            with self.subTest(request=request):
                page = self.feed(**request)
                self.assertEqual((page['run_id'], page['reply_count']), (self.run, 5))
                self.assertEqual([item['n'] for item in page['items']], expected)
                self.assertTrue(page['more_before'])
                for item in page['items']:
                    event = events[item['n'] - 1]
                    self.assertEqual(item['reply']['event_id'], event['event_id'])
                    if event['kind'] == 'pointer':
                        self.assertIsNone(item['question'])
                    else:
                        self.assertEqual(item['question']['id'], event['question_id'])
                        self.assertEqual(item['question']['text'], event['question'])
        self.assertFalse(self.feed()['more_before'])
        for request in ({'before': 0}, {'before': 1}, {'after': 5}, {'after': 100}):
            with self.subTest(request=request):
                page = self.feed(**request)
                self.assertEqual((page['items'], page['more_before']), ([], False))

    def test_feed_after_reads_include_new_reply_once_without_gaps(self):
        self.publish('answer')
        self.publish('pointer')
        first = self.feed(after=0, limit=1)
        self.publish('answer')
        second = self.feed(after=first['items'][-1]['n'])
        self.assertEqual([item['n'] for page in (first, second) for item in page['items']], [1, 2, 3])
        self.assertEqual(self.feed(after=second['items'][-1]['n'])['items'], [])

    def test_feed_hides_replies_when_off_disabled_or_expired(self):
        self.publish('answer')
        path = self.folder / 'state.json'
        original = bridge.read(path)
        for changes in ({'sharing': False}, {'deadline_ms': 0}):
            with self.subTest(changes=changes):
                bridge.save(path, {**original, **changes})
                page = self.feed()
                self.assertEqual((page['reply_count'], page['items'], page['more_before']), (1, [], False))
        bridge.save(path, original)
        self.command('stop')
        self.assertEqual(self.command('snapshot')['status'], 'disabled')
        self.assertEqual(self.feed(), {'run_id': self.run, 'reply_count': 1, 'items': [], 'more_before': False})

    def test_feed_keeps_pointers_after_controls_turn_them_off(self):
        event = self.publish('pointer')
        self.command('controls', {'sharing': True, 'proactive': False})
        page = self.feed()
        self.assertEqual([item['reply']['event_id'] for item in page['items']], [event['event_id']])
        self.assertIsNone(page['items'][0]['question'])

    def test_feed_rechecks_answer_and_pointer_citations(self):
        self.publish('answer')
        self.publish('pointer')
        self.assertTrue(all(not item['reply'].get('source_status') for item in self.feed()['items']))
        self.append('Monday instead', sid='s1')
        self.command('snapshot')  # Feed only reads the already-synced transcript window.
        self.assertEqual([item['reply']['source_status'] for item in self.feed()['items']], ['revised', 'revised'])
        self.append(None, removals=['s1'])
        self.command('snapshot')
        self.assertEqual([item['reply']['source_status'] for item in self.feed()['items']], ['revised', 'revised'], 'a known revision stays')

    def test_feed_is_read_only_and_does_not_sync_call(self):
        self.publish('answer')
        self.append('An unsynced correction', sid='s1')
        path = self.folder / 'state.json'
        original = path.read_bytes()
        with patch.object(bridge, 'sync_call', side_effect=AssertionError('Feed must not sync')), \
                patch.object(bridge, 'save', side_effect=AssertionError('Feed must not save')):
            self.assertEqual([item['n'] for item in self.feed()['items']], [1])
        self.assertEqual(path.read_bytes(), original)

    def test_feed_allows_inactive_and_local_only_runs(self):
        self.publish('answer')
        bridge.dispatch(self.root, 'create', {})
        self.assertEqual(self.feed()['items'], [])
        self.assertFalse(self.feed()['more_before'])
        local = bridge.dispatch(self.local, 'feed', {'before': None, 'after': None, 'limit': 2}, self.source)
        self.assertEqual(local, {'run_id': self.source, 'reply_count': 0, 'items': [], 'more_before': False})

    def test_feed_short_run_uses_reply_indexes_and_questions(self):
        snapshot = bridge.dispatch(self.root, 'create', {})
        run = snapshot['run_id']
        folder = self.root / run
        bridge.dispatch(self.root, 'controls', {'sharing': True, 'proactive': True}, run)
        for kind in ('pointer', 'answer'):
            if kind == 'answer':
                bridge.dispatch(self.root, 'ask', {'question': 'When is the fictional launch?'}, run)
            event = bridge.wait(folder, run, .05)
            self.assertEqual(event['kind'], kind)
            result = bridge.mutate(folder, 'reply', {'event_id': event['event_id'], 'text': 'A fictional reply.', 'sources': ['v1-1']}, run)
            self.assertEqual(result['status'], 'published')
        page = bridge.dispatch(self.root, 'feed', {'before': None, 'after': 0, 'limit': 50}, run)
        self.assertEqual([item['n'] for item in page['items']], [1, 2])
        self.assertEqual(page['reply_count'], 2)
        self.assertFalse(page['more_before'])
        self.assertIsNone(page['items'][0]['question'])
        self.assertEqual(page['items'][1]['question']['text'], 'When is the fictional launch?')
        self.assertEqual(bridge.dispatch(self.root, 'snapshot', {}, run)['reply_count'], 2)
        self.assertEqual(list(folder.glob('reply-*.json')), [])

    def test_projection_reports_latest_you_segment_and_reply_count(self):
        for kind in ('answer', 'pointer', 'answer', 'answer', 'pointer'):
            self.publish(kind)
        snapshot = self.command('snapshot')
        self.assertEqual(snapshot['reply_count'], 5)
        self.assertFalse(snapshot['you_speaking'])
        state = bridge.read(self.folder / 'state.json')
        sources = [
            {'id': 'newest-you', 'source': 'you', 'start_ms': 20, 'finalized': False},
            {'id': 'old-you', 'source': 'you', 'start_ms': 10, 'finalized': False},
            {'id': 'other', 'source': 'other_audio', 'start_ms': 30, 'finalized': False},
            {'id': 'no-source', 'start_ms': 40, 'finalized': False},
        ]
        state['transcripts'][-1]['sources'] = sources
        self.assertTrue(bridge.projection(state)['you_speaking'])
        for changes in ({'ended': True}, {'deadline_ms': 0}, {'local_only': True}):
            with self.subTest(changes=changes):
                self.assertFalse(bridge.projection({**state, **changes})['you_speaking'])
        sources[0]['finalized'] = True
        self.assertFalse(bridge.projection(state)['you_speaking'])
        sources[1]['finalized'] = True
        self.assertFalse(bridge.projection(state)['you_speaking'])
        state['transcripts'][-1]['sources'] = sources[2:]
        self.assertFalse(bridge.projection(state)['you_speaking'])

    def test_projection_reports_terra_working_only_while_an_event_is_in_flight(self):
        self.assertFalse(self.command('snapshot')['terra_working'])
        event = self.wait()
        self.assertEqual(event['kind'], 'pointer')
        snapshot = self.command('snapshot')
        self.assertTrue(snapshot['terra_working'])
        self.assertLessEqual(snapshot['terra_working_since_ms'], bridge.now())
        self.scoped('pass', {'event_id': event['event_id'], 'reason': 'silent'})
        self.assertFalse(self.command('snapshot')['terra_working'])
        self.command('controls', {'sharing': True, 'proactive': False})
        self.append('Fictional quiet line', sid='quiet-1')
        self.assertEqual(self.wait()['kind'], 'transcript')
        self.assertFalse(self.command('snapshot')['terra_working'], 'silent bookkeeping is not thinking')

    def status_of(self, n):
        self.command('snapshot')  # Feed only reads the already-synced transcript window.
        return next(i['reply'].get('source_status') for i in self.feed()['items'] if i['n'] == n)

    def test_a_known_revision_outlives_its_source_leaving_the_window(self):
        self.reply(self.wait())
        self.assertIsNone(self.status_of(1))
        self.append('Monday, not Friday', sid='s1')
        self.assertEqual(self.status_of(1), 'revised')
        self.assertEqual(bridge.read(self.folder / 'state.json')['revised_replies'], [1])
        self.append(None, removals=['s1'])
        self.assertEqual(self.status_of(1), 'revised', 'evicted, and still known to be outdated')
        self.assertEqual(bridge.read(self.folder / 'state.json')['watching'], [])

    def test_a_source_that_only_left_the_window_is_not_a_revision(self):
        self.reply(self.wait())
        self.append(None, removals=['s1'])
        self.assertEqual(self.status_of(1), 'outside_window')
        self.assertEqual(bridge.read(self.folder / 'state.json').get('revised_replies', []), [])

    def test_feed_rejects_invalid_requests(self):
        valid = {'before': None, 'after': None, 'limit': 2}
        invalid = [
            {**valid, 'before': 1, 'after': 2},
            {**valid, 'limit': 0}, {**valid, 'limit': 51}, {**valid, 'extra': True},
            {**valid, 'before': -1}, {**valid, 'after': -1},
            {**valid, 'before': True}, {**valid, 'after': 1.5},
            {**valid, 'after': '1'}, {**valid, 'limit': True}, {**valid, 'limit': 2.0},
            {**valid, 'limit': None}, {'limit': 2}, None, [], 'feed', 1,
        ]
        for value in invalid:
            with self.subTest(value=value), self.assertRaisesRegex(ValueError, '^Invalid feed request$'):
                bridge.dispatch(self.root, 'feed', value, self.run)


if __name__ == '__main__':
    unittest.main()
