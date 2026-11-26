export const HOVER_DWELL_MS = 450;
export const LEAVE_GRACE_MS = 150;

/** Counts visible reading time, preserving the unused budget while paused. */
export class PeekClock {
  private remaining = 0;
  private started: number | null = null;

  /** Longer text stays up longer: 6 seconds, plus 1.5 for each line past the first. */
  restart(lines = 1) {
    this.remaining = 6000 + (Math.max(1, lines) - 1) * 1500;
    this.started = null;
  }

  /** A longer pointer joined the peek: add reading time, keeping what has passed. */
  extend(lines: number) {
    this.remaining += Math.max(0, lines) * 1500;
  }

  left(now: number) {
    return Math.max(
      0,
      this.remaining -
        (this.started === null ? 0 : Math.max(0, now - this.started)),
    );
  }

  pause(now: number) {
    this.remaining = this.left(now);
    this.started = null;
  }

  resume(now: number) {
    if (this.started === null && this.remaining > 0) this.started = now;
  }

  clear() {
    this.remaining = 0;
    this.started = null;
  }
}
