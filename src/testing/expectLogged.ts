/**
 * Capture a diagnostic log inside a test, and ASSERT it happened.
 *
 * Not in `__tests__/` on purpose — both vitest configs collect only
 * `**\/*.test.ts`, so a helper living beside the tests would be fine, but this
 * one is shared by `src/services/__tests__` and `src/utils/__tests__`, which are
 * collected by two different configs.
 *
 * WHY THIS EXISTS, AND WHY IT IS NOT JUST A MUTE.
 *
 * Several suites deliberately drive a failure path — a rejected write, a dead
 * Signal session, a full disk — to prove the code survives it. The production
 * code correctly logs `console.error` on those paths, so a fully GREEN run
 * printed "❌ Decrypt failed", "⚠️ Failed to mirror message to own devices" and
 * a stack trace to the terminal. During `npm run ship:ios`, whose preflight is a
 * hard gate, that reads as a broken build. The real cost is not the confusion
 * once: it is that red text during a ship stops meaning anything, which is
 * exactly when it needs to.
 *
 * Silencing them with a blanket `vi.spyOn(console, 'error')` would fix the noise
 * and throw away something valuable. CLAUDE.md records, repeatedly, that this
 * project's worst bugs were the ones that failed with NO signal — and that a
 * Release bundle drops `console.warn` entirely, so `console.error` is the only
 * diagnostic that survives to a device log. These log lines are therefore a
 * contract, not decoration: several of them are the sole evidence a user could
 * ever produce that a given failure occurred.
 *
 * So the helper captures AND asserts. A test using it fails if the diagnostic
 * stops firing, or if someone downgrades it to `console.warn` — the specific
 * regression this codebase has shipped more than once.
 */
import { expect, vi } from 'vitest';

type ConsoleMethod = 'error' | 'warn' | 'log';

export interface CapturedConsole {
  /** Every argument list passed to the captured method, in order. */
  calls: unknown[][];
  /** All captured calls flattened to a single searchable string. */
  text(): string;
  /** Stop capturing and restore the real method. */
  restore(): void;
}

/**
 * Silences `console[method]` for the rest of the test and records what it got.
 *
 * `vi.spyOn` with a no-op implementation rather than a global config-level
 * silence: scoping it to the test that expects the failure means an UNEXPECTED
 * log anywhere else still reaches the terminal, which is the whole point.
 */
export const captureConsole = (method: ConsoleMethod = 'error'): CapturedConsole => {
  const spy = vi.spyOn(console, method).mockImplementation(() => undefined);
  return {
    get calls() {
      return spy.mock.calls as unknown[][];
    },
    text() {
      return (spy.mock.calls as unknown[][])
        .map((args) => args.map((arg) => {
          if (arg instanceof Error) return `${arg.name}: ${arg.message}`;
          if (typeof arg === 'string') return arg;
          try {
            return JSON.stringify(arg);
          } catch {
            return String(arg);
          }
        }).join(' '))
        .join('\n');
    },
    restore() {
      spy.mockRestore();
    },
  };
};

/**
 * Runs `fn` with `console[method]` captured, asserts it logged something
 * matching `expected`, and restores the console afterwards.
 *
 * The assertion is the point. A test that merely silenced the log would keep
 * passing if the diagnostic were deleted, leaving a failure path that is silent
 * in production and invisible in CI — the exact combination CLAUDE.md's
 * gotchas are a list of.
 */
export const expectLogged = async <T>(
  expected: string | RegExp,
  fn: () => T | Promise<T>,
  method: ConsoleMethod = 'error',
): Promise<T> => {
  const captured = captureConsole(method);
  try {
    const result = await fn();
    const text = captured.text();
    if (typeof expected === 'string') {
      expect(
        text,
        `expected console.${method} to mention ${JSON.stringify(expected)}; got:\n${text || '(nothing logged)'}`,
      ).toContain(expected);
    } else {
      expect(
        text,
        `expected console.${method} to match ${expected}; got:\n${text || '(nothing logged)'}`,
      ).toMatch(expected);
    }
    return result;
  } finally {
    captured.restore();
  }
};
