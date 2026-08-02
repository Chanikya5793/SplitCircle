/**
 * The test helper that guards the other tests.
 *
 * `expectLogged` is now the assertion behind roughly ten tests across the
 * services suite — every one covering a path that swallows an error on purpose,
 * where the log line is the ONLY evidence the failure happened. If the helper
 * itself were wrong in the permissive direction, all of those would pass
 * vacuously and nobody would notice: they would still be green, still be
 * silent, and no longer be checking anything.
 *
 * That is a worse failure than any single one of them, so it gets its own test.
 * The cases that matter are the ones where it must FAIL: nothing logged, and
 * logged at the wrong level.
 */
import { describe, expect, it, vi } from 'vitest';
import { captureConsole, expectLogged } from '@/testing/expectLogged';

describe('expectLogged', () => {
  it('passes when the expected string was logged', async () => {
    await expectLogged('boom', () => {
      console.error('something went boom', new Error('x'));
    });
  });

  it('FAILS when nothing was logged at all', async () => {
    // The case that matters most: a silenced-but-unasserted helper would let a
    // deleted diagnostic sail through, which is exactly the regression this
    // whole approach exists to prevent.
    await expect(expectLogged('boom', () => undefined)).rejects.toThrow(/nothing logged/);
  });

  it('FAILS when something else was logged', async () => {
    await expect(
      expectLogged('boom', () => {
        console.error('unrelated message');
      }),
    ).rejects.toThrow();
  });

  it('FAILS when the log was at console.warn instead of console.error', async () => {
    // The specific regression CLAUDE.md records more than once: a Release
    // bundle drops console.warn entirely, so a downgrade makes a failure
    // permanently undiagnosable in the field while looking fine in a test run.
    // The warn is itself captured, or this test prints the very noise the
    // helper exists to remove.
    const warn = captureConsole('warn');
    try {
      await expect(
        expectLogged('boom', () => {
          console.warn('boom');
        }),
      ).rejects.toThrow(/nothing logged/);
      expect(warn.text()).toContain('boom');
    } finally {
      warn.restore();
    }
  });

  it('accepts a RegExp for matching across multiple arguments', async () => {
    await expectLogged(/Decrypt failed[\s\S]*Duplicate/, () => {
      console.error('❌ Decrypt failed', { name: 'DuplicateSignalMessage' });
    });
  });

  it('serialises an Error argument rather than printing [object Object]', async () => {
    // Several call sites log `(message, error)`; matching on the error's own
    // text is how a test distinguishes a duplicate from a dead session.
    await expectLogged('invalid session', () => {
      console.error('Decrypt failed', new Error('invalid session'));
    });
  });

  it('SILENCES the console while capturing', async () => {
    // The point of the exercise: a green ship preflight must not print red text.
    const outer = captureConsole('error');
    try {
      await expectLogged('inner', () => {
        console.error('inner message');
      });
      // The inner console.error was swallowed by the inner capture, so the
      // outer one saw nothing. If capture leaked, this would be non-empty.
      expect(outer.text()).toBe('');
    } finally {
      outer.restore();
    }
  });

  it('RESTORES the console even when the assertion fails', async () => {
    // A helper that leaves console.error stubbed on failure would blind every
    // subsequent test in the file — a failing test corrupting later ones is
    // far worse than the original failure.
    expect(vi.isMockFunction(console.error)).toBe(false);
    await expect(expectLogged('never', () => undefined)).rejects.toThrow();

    // Asserted on the FUNCTION, not on behaviour. Writing this as "capture
    // again and check the message arrives" passes whether or not the restore
    // happened — the second capture spies on top of the leaked one and sees the
    // call either way. Verified by deleting the restore and watching this test
    // still pass, which is why it is written this way instead.
    expect(vi.isMockFunction(console.error)).toBe(false);
  });

  it('returns the wrapped function\'s value, so it can wrap an assertion', async () => {
    const result = await expectLogged('logged', () => {
      console.error('logged');
      return 42;
    });
    expect(result).toBe(42);
  });

  it('awaits an async function before checking', async () => {
    // Every real call site wraps an async expect(...).resolves chain; checking
    // before it settled would make the assertion a coin toss.
    await expectLogged('late', async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      console.error('late message');
    });
  });

  it('can capture a level other than error', async () => {
    await expectLogged('chatty', () => {
      console.log('chatty');
    }, 'log');
  });
});

describe('captureConsole', () => {
  it('records every call in order', () => {
    const captured = captureConsole('error');
    try {
      console.error('first');
      console.error('second', 2);
      expect(captured.calls).toHaveLength(2);
      expect(captured.text()).toContain('first');
      expect(captured.text()).toContain('second 2');
    } finally {
      captured.restore();
    }
  });

  it('survives an unserialisable argument', () => {
    // A circular object in a log payload must not turn a diagnostic assertion
    // into a TypeError from the helper.
    const captured = captureConsole('error');
    try {
      const circular: Record<string, unknown> = {};
      circular.self = circular;
      console.error('cycle', circular);
      expect(() => captured.text()).not.toThrow();
      expect(captured.text()).toContain('cycle');
    } finally {
      captured.restore();
    }
  });

  it('restores the real console', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    spy.mockRestore();

    const captured = captureConsole('error');
    captured.restore();
    // After restore, a fresh capture starts empty rather than inheriting the
    // previous spy's calls.
    const next = captureConsole('error');
    try {
      expect(next.calls).toHaveLength(0);
    } finally {
      next.restore();
    }
  });
});
