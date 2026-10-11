// Attempt limits for sign-in and re-checks: in memory, per key. Good enough for a single web instance.
const MAX_ATTEMPTS = 5;
const WINDOW_MS = 15 * 60 * 1000;

export function createThrottle(max = MAX_ATTEMPTS, windowMs = WINDOW_MS) {
  const attempts = new Map<string, { count: number; resetAt: number }>();
  return {
    /**
     * Counts an attempt now, before the caller awaits anything, so guesses sent at once can't all pass on the
     * same count. False once the limit is reached.
     */
    take(key: string, now = Date.now()): boolean {
      const e = attempts.get(key);
      if (!e || e.resetAt <= now) {
        attempts.set(key, { count: 1, resetAt: now + windowMs });
        return true;
      }
      if (e.count >= max) return false;
      e.count++;
      return true;
    },
    /** Gives back an attempt that wasn't a guess (the password was right; the code is still to come). */
    refund(key: string) {
      const e = attempts.get(key);
      if (e && e.count > 0) e.count--;
    },
    /** It worked: start again from zero. */
    clear(key: string) {
      attempts.delete(key);
    },
  };
}
