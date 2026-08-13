import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { checkPwnedPassword, parsePwnedPasswordRange } from '../pwnedPasswordService';

describe('Pwned Passwords k-anonymity', () => {
  it('matches only the requested suffix and ignores padded zero rows', () => {
    expect(parsePwnedPasswordRange('AAAA:0\r\nBBBB:42\r\nCCCC:9', 'BBBB')).toBe(42);
    expect(parsePwnedPasswordRange('AAAA:0\r\nBBBB:42', 'AAAA')).toBe(0);
    expect(parsePwnedPasswordRange('AAAA:1', 'MISSING')).toBe(0);
  });

  it('sends only five hash characters with response padding enabled', async () => {
    const password = 'correct horse battery staple';
    const sha1 = createHash('sha1').update(password, 'utf8').digest('hex').toUpperCase();
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      expect(url).toBe(`https://api.pwnedpasswords.com/range/${sha1.slice(0, 5)}`);
      expect(url).not.toContain(sha1);
      expect(JSON.stringify(init)).not.toContain(password);
      expect((init?.headers as Record<string, string>)['Add-Padding']).toBe('true');
      return new Response(`${sha1.slice(5)}:73\r\nPADDED:0`, { status: 200 });
    }) as unknown as typeof fetch;

    await expect(checkPwnedPassword(password, { fetchImpl })).resolves.toMatchObject({
      exposed: true,
      occurrenceCount: 73,
    });
  });
});

