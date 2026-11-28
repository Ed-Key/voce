# Terra behind the Experimental switch

Terra (the meeting companion) is experimental. With Settings > Advanced > Experimental features off (the default),
no Terra page, tab, control, saved reply or notch shows, and no Terra responder, tunnel or share can start. The
call itself (recording, live transcript, notes, retention) never depends on the switch.

The backend gate sits in four places:

- the bridge lock (`assistie.rs` `locked_bridge`), read after the lock is taken, so a command that was waiting
  cannot start Terra after the switch-off cleanup;
- the tunnel launch (`plugin.rs` `launch_with`), checked before the Keychain read, after it, and after the spawn;
  the key is written to the supervisor only after the last check, under the runtime lock;
- the responder launch (`responder.rs` `launch`), checked under the runtime lock before and after the spawn; the
  responder waits for a "go" line on stdin, written only after the last check;
- the notch show (`notch.rs` `native::visible`), on the main thread where shows and hides run in order.

Commands that pass the bridge gate and then await a helper (`mutate` after its `identity` read,
`connect_terra_meeting` after its memory check and again before the responder launch) check the switch once more
before the step that can sync meeting text.

Ending a run, sharing off, stopping for a call, startup recovery, the notch feed and reads of saved runs are never
gated, so revoking is never blocked. The snapshot poll and the notch check do sync meeting text, so they are
refused while the switch is off (the notch check answers "no notch").

| # | Event | State | Expected | Test |
|---|---|---|---|---|
| T1 | App starts | switch off, plugin key saved | no Keychain read, no supervisor; bridge recovery still runs | `plugin.rs` `terra_gate_row1_switch_off_launches_nothing` |
| T2 | App starts | switch on, key saved | supervisor starts as before and gets its key | `plugin.rs` `terra_gate_row2_switch_on_launches_as_before` |
| T3 | Any Terra command | switch off | refused with the "experimental feature" message | `assistie.rs` `terra_gate_rows3_4_only_use_needs_the_switch`, `terra_gate_row3_every_bridge_caller_has_the_intended_gate` |
| T4 | Stop, sharing off, stop for call | switch off | allowed | `assistie.rs` `terra_gate_rows3_4_only_use_needs_the_switch` |
| T5 | Switch turned off | Terra sharing in a live call | run stopped (read with `identity`), responder shut down under the bridge lock, notch hidden, supervisor stopped; each step tried even if one fails | `assistie.rs` `terra_gate_rows5_6_switch_off_tries_every_step` |
| T6 | Switch turned off | nothing live | same steps, no errors | same test |
| T7 | Switch turned off | a launch waiting on the Keychain prompt | no supervisor spawned when the read returns | `plugin.rs` `terra_gate_switch_off_during_a_blocked_keychain_read_spawns_nothing` |
| T7b | Switch turned off | a launch past both checks, spawning | the supervisor never gets its key and is stopped, never published | `plugin.rs` `terra_gate_switch_off_during_the_spawn_never_publishes` |
| T7c | Switch turned off | a connect holding the bridge lock, notch shown | no responder launched; run stopped, notch hidden | recheck in `connect_terra_meeting` before `responder::launch`, and the checks in `responder::launch` |
| T7d | Switch turned off | a responder spawned but not yet given "go" | it reads nothing, starts no codex, and exits when its input closes | `test_responder.py` `GoBarrierTest` |
| T7e | Switch turned off | an ask, connect or sharing-on waiting on its `identity` read | refused before the command runs | `assistie.rs` `terra_gate_mutate_rechecks_after_identity` |
| T7f | Switch turned off, then on at once | the old supervisor still alive when the on resumes | the off's cleanup stops it, then resumes the saved connection; no resume if the switch stays off | `assistie.rs` `terra_gate_quick_off_then_on_resumes_after_the_cleanup` |
| T8 | Fictional invitation Start | switch off | invitation closes, no Terra fixture | skipped in `invitation.rs`; `create_assistie_fixture` is gated as T3 |
| T9 | Call page | switch off / on | Terra and System tabs (System is Terra's pipeline diagram), menu, pairing, fixture, popover, saved pointers absent / present; keyboard tabs use the same list | `terraGate.test.ts`; `call-observatory.spec.ts` "with Experimental features off, call pages show no Terra" |
| T10 | Switch turned off | page on the Terra tab, fixture or popover open | Notes shows, panels close | `terraGate.test.ts` (`tabAfterSwitch`); `call-observatory.spec.ts` "turning Experimental features off on the Terra tab shows Notes" |
| T11 | Sidebar | switch off / on | Memory absent / present | `terraGate.test.ts` (`terraOn`); `main-window.spec.ts` nav tests |

Turning the switch on resumes a saved plugin connection, as startup does; nothing shares until Terra is turned on
for a meeting. Every off runs its cleanup, even if the switch is back on by then (the meeting's share ends and needs
fresh consent). A quick off then on can find the old supervisor still alive, so the on's resume does nothing,
and then the off's cleanup stops it; the cleanup therefore resumes the saved connection once more at its end if
the switch is on by then.

The tunnel launch holds the plugin runtime lock while it reads the Keychain. If the switch goes off while a
Keychain prompt is up, the cleanup's last step (stopping the supervisor) waits until the prompt is answered; the
launch then sees the switch off and spawns nothing. The earlier steps (stopping the run, the responder and the
notch) do not wait on it.

Accepted window: saving the switch does not take the runtime locks. If the switch goes off right after a launch's
last check, that child gets its key or its go and runs until the cleanup's shutdown, which takes the same lock next
and stops it the ordinary way (input closed, codex and the tunnel reaped). This includes the saved-key resume at
startup.

The Rust tests have no app handle, so the cleanup and the resume after it are tested through small functions
(`end_terra`, `off_then_resume`), and the recheck in `mutate` by its place in the source. A check in the built app
covers the remaining wiring.
