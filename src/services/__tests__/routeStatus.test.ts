/**
 * What the nearby sheet tells the user about each route.
 *
 * The screen this replaces was a static "Wi-Fi on / Bluetooth on / Apps open"
 * checklist, user-verified, that only turned green once something connected. It
 * could not express one route working and another off — so when nothing
 * connected, BOTH phones showed an identical, unactionable screen, with no way
 * to tell a switched-off radio from an absent peer. That is the "both devices
 * are saying the same thing" report.
 *
 * These pin the precedence between the four states, because getting that order
 * wrong is how a screen ends up lying while every individual string is correct.
 */
import { describe, expect, it } from 'vitest';
import { describeRoutes } from '../mesh/routeStatus';

const diagnostics = (over: Partial<{
  ble: boolean;
  lan: boolean;
  available: Record<string, boolean>;
  needsPermission: Record<string, boolean>;
}> = {}) => ({
  bleEnabled: over.ble ?? true,
  lanEnabled: over.lan ?? true,
  transports: (['mpc', 'lan', 'ble'] as const).map((id) => ({
    id,
    available: over.available?.[id] ?? true,
    needsPermission: over.needsPermission?.[id] ?? false,
    neighbourCount: 0,
  })),
});

describe('route status', () => {
  it('hides Apple Direct on Android, where it can never work', () => {
    // Listing it as "unavailable" reads as a fault the user might try to fix,
    // when it is a permanent property of the platform.
    const rows = describeRoutes({}, diagnostics(), false);
    expect(rows.map((row) => row.id)).toEqual(['lan', 'ble']);
  });

  it('lists all three on iOS', () => {
    expect(describeRoutes({}, diagnostics(), true).map((row) => row.id))
      .toEqual(['mpc', 'lan', 'ble']);
  });

  it('reports a connected route even when the radio reads unavailable', () => {
    // Connected must outrank every other signal: a route carrying messages is
    // carrying messages, whatever a stale availability poll says. Getting this
    // precedence backwards would show "Off" on a working link.
    const rows = describeRoutes(
      { ble: ['pixel-7'] },
      diagnostics({ available: { ble: false } }),
      false,
    );
    const ble = rows.find((row) => row.id === 'ble');
    expect(ble?.connected).toBe(true);
    expect(ble?.tone).toBe('success');
    expect(ble?.detail).toBe('1 phone connected');
  });

  it('pluralises a peer count', () => {
    const rows = describeRoutes({ lan: ['a', 'b'] }, diagnostics(), false);
    expect(rows.find((row) => row.id === 'lan')?.detail).toBe('2 phones connected');
  });

  it('distinguishes "off" from "on but nobody found" — the whole point', () => {
    const rows = describeRoutes(
      {},
      diagnostics({ available: { ble: false, lan: true } }),
      false,
    );
    expect(rows.find((row) => row.id === 'ble')?.tone).toBe('warning');
    expect(rows.find((row) => row.id === 'ble')?.detail).toMatch(/turn the radio on/);
    expect(rows.find((row) => row.id === 'lan')?.tone).toBe('neutral');
    expect(rows.find((row) => row.id === 'lan')?.detail).toMatch(/no phones found yet/);
  });

  it('says "needs permission" rather than "turn the radio on" when consent is missing', () => {
    // Different actions. Telling someone to turn on a radio that is already on
    // sends them hunting through Settings for something already correct — and
    // this is precisely the iOS case that had NO signal at all until
    // CBManager.authorization was exposed.
    const rows = describeRoutes({}, diagnostics({ needsPermission: { ble: true } }), true);
    const ble = rows.find((row) => row.id === 'ble');
    expect(ble?.detail).toMatch(/[Nn]eeds permission/);
    expect(ble?.detail).not.toMatch(/turn the radio on/);
    expect(ble?.tone).toBe('warning');
  });

  it('reports permission BEFORE availability, since a denial can also read as unavailable', () => {
    // On some platforms a refused permission makes the adapter query fail, so
    // checking availability first would swallow the more useful message.
    const rows = describeRoutes(
      {},
      diagnostics({ available: { ble: false }, needsPermission: { ble: true } }),
      true,
    );
    expect(rows.find((row) => row.id === 'ble')?.detail).toMatch(/[Nn]eeds permission/);
  });

  it('still prefers CONNECTED over a stale permission flag', () => {
    // A route carrying messages is carrying messages.
    const rows = describeRoutes(
      { ble: ['pixel-7'] },
      diagnostics({ needsPermission: { ble: true } }),
      true,
    );
    expect(rows.find((row) => row.id === 'ble')?.connected).toBe(true);
  });

  it('tells Wi-Fi users to join a network, not to turn on a radio', () => {
    const rows = describeRoutes({}, diagnostics({ available: { lan: false } }), false);
    expect(rows.find((row) => row.id === 'lan')?.detail).toMatch(/join a Wi-Fi network/);
  });

  it('calls a transport missing from the build neutral, not an error', () => {
    // Nothing is wrong and there is nothing the user can do, so a red row would
    // send them hunting for a setting that does not exist.
    const rows = describeRoutes({}, diagnostics({ ble: false }), false);
    const ble = rows.find((row) => row.id === 'ble');
    expect(ble?.tone).toBe('neutral');
    expect(ble?.detail).toBe('Not included in this build');
  });

  it('does not crash before the first diagnostics poll returns', () => {
    // The sheet renders immediately; diagnostics arrive up to 3s later.
    const rows = describeRoutes(undefined, null, true);
    expect(rows).toHaveLength(3);
    expect(rows.every((row) => typeof row.detail === 'string')).toBe(true);
  });
});
