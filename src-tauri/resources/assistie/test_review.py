"""The one-meeting review switch, one test per lifecycle row."""
import json
import os
import stat
import threading
import unittest
import bridge
import responder
import test_responder

P = test_responder.P


class ReviewTest(unittest.TestCase):
    for name in ('setUp', 'start', 'finish', 'until', 'inputs', 'results', 'replies', 'command', 'append', 'manifest', 'setUp_call'):
        locals()[name] = getattr(test_responder.ResponderTest, name)

    def switch(self):
        return self.root / responder.REVIEW_SWITCH

    def review(self):
        return self.data / 'terra-cases' / self.run / 'review.json'

    def arm(self):
        self.switch().write_text('')

    def stop(self):
        self.command('stop')
        self.thread.join(10)

    def test_armed_meeting_is_kept_whole_and_switch_is_used_up(self):
        self.arm()
        self.start([{'text': 'NO_POINTER'}, {'text': P}])
        self.until(lambda: self.results())
        self.append('Second line', sid='s2')
        self.until(lambda: self.replies())
        self.assertFalse(self.switch().exists(), 'claimed when the meeting starts, so the next one is not kept')
        self.stop()
        review = json.loads(self.review().read_text())
        self.assertEqual([json.loads(t['message']) for t in review['turns']], self.inputs()[:2])
        self.assertEqual(review['turns'][-1]['shown'], 'Heads up: this conflicts with the brief.')
        self.assertEqual((review['prompt']['brief'], review['prompt']['sha256']), ('Alex is out Nov 12.', responder.PROMPT_SHA))
        self.assertEqual(stat.S_IMODE(self.review().stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(self.review().parent.stat().st_mode), 0o700)
        self.assertNotIn('Second line', (self.data / 'terra.jsonl').read_text(), 'the log still holds no meeting text')
        self.assertIn('saved', [r.get('review') for r in self.results()])

    def test_lines_spoken_during_the_last_turn_are_kept(self):
        self.arm()
        self.start([{'text': P, 'delay': 3}])
        self.until(lambda: self.inputs())  # the turn is in flight
        self.append('Spoken right before the end', sid='s2')
        self.command('snapshot')  # the app's status poll copies the line into the shared window while sharing
        self.stop()
        review = json.loads(self.review().read_text())
        self.assertIn('Spoken right before the end', [l['text'] for l in review['unsent_lines']])
        self.assertEqual(len(review['turns']), 1)

    def test_dead_turn_is_marked_in_the_review(self):
        self.arm()
        self.start([{'text': P, 'die': True}])
        self.thread.join(10)
        review = json.loads(self.review().read_text())
        self.assertEqual(review['turns'][-1]['status'], 'dead')
        self.assertEqual(self.outcome['error'], 'terra_unavailable')

    def test_busy_run_lock_delays_terra_instead_of_ending_it(self):
        # call-rig run 20261028-054514: under load the meeting's lock stayed busy past 1 s and Terra stopped.
        import time
        self.start([{'text': 'NO_POINTER'}, {'text': P}])
        self.until(lambda: self.results())
        held = threading.Event()

        def hold():
            with bridge.locked(self.folder, self.run):
                held.set()
                time.sleep(1.4)
        holder = threading.Thread(target=hold)
        holder.start()
        held.wait(2)
        self.append('Second line', sid='s2')  # written as soon as the lock frees
        holder.join()
        self.until(lambda: self.replies())
        self.assertTrue(self.thread.is_alive(), 'Terra outlives a busy moment')
        self.assertIsNone(self.outcome.get('error'))

    def busy_responder(self):
        from unittest.mock import patch
        r = responder.Responder(bridge, self.folder, self.run, 'x', [], self.data)
        busy = TimeoutError('Fictional exchange is busy; retry')
        return r, patch.object(bridge, 'wait', side_effect=busy), patch.object(bridge, 'mutate', side_effect=busy)

    def test_retry_ends_at_once_when_sharing_is_revoked(self):
        import time
        from unittest.mock import patch
        r, wait, mutate = self.busy_responder()
        with wait, mutate, patch.object(responder.Responder, 'revoked', return_value=True):
            began = time.monotonic()
            self.assertEqual(r.wait()['status'], 'revoked')
            self.assertEqual(r.scoped('reply', {})['status'], 'disabled')
            self.assertLess(time.monotonic() - began, 1, 'no 30 s of retries after consent ended')

    def test_final_stop_gets_a_short_budget(self):
        import time
        from unittest.mock import patch
        r, wait, mutate = self.busy_responder()
        with wait, mutate, patch.object(responder.Responder, 'revoked', return_value=False):
            began = time.monotonic()
            with self.assertRaises(TimeoutError):
                r.scoped('stop', {}, budget=responder.STOP_BUDGET_S)
            self.assertLess(time.monotonic() - began, responder.STOP_BUDGET_S + 1)

    def test_unarmed_meeting_keeps_nothing(self):
        self.start([{'text': P}])
        self.until(lambda: self.replies())
        self.stop()
        self.assertFalse(self.review().exists())
        self.assertFalse((self.data / 'terra-cases').exists())

    def test_meeting_without_turns_rearms_the_switch(self):
        self.arm()
        self.start([], proactive=False)
        self.until(lambda: self.results())  # transcript acks only: no model turn
        self.stop()
        self.assertFalse(self.review().exists())
        self.assertTrue(self.switch().is_file(), 'nothing was kept, so the next meeting is still armed')
        self.assertEqual(stat.S_IMODE(self.switch().stat().st_mode), 0o600)

    def test_linked_switch_is_ignored(self):
        target = self.data / 'elsewhere'
        target.write_text('')
        os.symlink(target, self.switch())
        self.start([{'text': P}])
        self.until(lambda: self.replies())
        self.stop()
        self.assertFalse(self.review().exists())
        self.assertTrue(self.switch().is_symlink(), 'a link is not the switch and is left alone')

    def test_failed_write_still_stops_cleanly(self):
        self.arm()
        (self.data / 'terra-cases').symlink_to(self.data / 'elsewhere-dir', target_is_directory=True)
        self.start([{'text': P}])
        self.until(lambda: self.replies())
        self.stop()
        self.assertFalse(self.thread.is_alive())
        self.assertIn('failed', [r.get('review') for r in self.results()])
        self.assertFalse((self.data / 'elsewhere-dir').exists(), 'never writes through a link')

    def test_review_is_written_once(self):
        self.arm()
        self.start([{'text': P}])
        self.until(lambda: self.replies())
        self.stop()
        first = self.review().read_text()
        self.responder.save_review()  # the parent-closed path calling it again must be a no-op
        self.assertEqual(self.review().read_text(), first)
        self.assertEqual([r.get('review') for r in self.results()].count('saved'), 1)


if __name__ == '__main__':
    unittest.main()
