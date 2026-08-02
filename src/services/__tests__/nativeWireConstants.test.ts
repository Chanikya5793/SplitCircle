/**
 * Cross-platform wire-constant drift guard (ai_layer/docs/35, critical #3).
 *
 * Reads the actual Swift and Kotlin sources and asserts the constants that MUST
 * be byte-identical between them really are. This is unusual for a unit test
 * and it earns its place: the failure mode it guards is invisible everywhere
 * else in the toolchain.
 *
 * A service-type or UUID mismatch between the two native halves produces no
 * compile error, no lint error, no runtime exception, and no log line. Both
 * platforms come up reporting healthy and simply never discover each other —
 * indistinguishable from "no peers nearby yet". That is exactly what happened:
 * Android's LAN service type carried a trailing dot (Android's own documented
 * convention) while iOS's did not (Apple's own documented convention), so each
 * half looked correct in isolation and the pair could never have worked.
 *
 * These strings are a WIRE PROTOCOL shared by two codebases that cannot import
 * from each other, so the only place the agreement can be checked is here.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..', '..');
const read = (relativePath: string): string =>
  readFileSync(join(ROOT, relativePath), 'utf8');

const LAN_SWIFT = 'modules/splitcircle-lan/ios/SplitCircleLanModule.swift';
const LAN_KOTLIN =
  'modules/splitcircle-lan/android/src/main/java/expo/modules/splitcirclelan/SplitCircleLanModule.kt';
const BLE_SWIFT = 'modules/splitcircle-ble/ios/SplitCircleBleModule.swift';
const BLE_KOTLIN =
  'modules/splitcircle-ble/android/src/main/java/expo/modules/splitcircleble/SplitCircleBleModule.kt';
const INFO_PLIST = 'ios/SplitCircle/Info.plist';

/**
 * First double-quoted literal appearing after `name =`, in either language.
 *
 * Tolerates a wrapper call, because Swift writes
 * `let serviceUUID = CBUUID(string: "...")` and Kotlin writes
 * `val SERVICE_UUID = UUID.fromString("...")` — the literal is what matters,
 * not how each platform boxes it.
 */
const constant = (source: string, name: string): string | null => {
  const match = source.match(new RegExp(`${name}\\b[^"\\n]*"([^"]*)"`));
  return match ? match[1] : null;
};

describe('LAN service type', () => {
  it('is byte-identical between the Swift and Kotlin halves', () => {
    const swift = constant(read(LAN_SWIFT), 'serviceType');
    const kotlin = constant(read(LAN_KOTLIN), 'SERVICE_TYPE');

    expect(swift).toBeTruthy();
    expect(kotlin).toBeTruthy();
    // The original defect was a single trailing '.' on the Kotlin side.
    expect(kotlin).toBe(swift);
  });

  it('carries no trailing dot, because iOS rejects that form', () => {
    // Apple's Network.framework wants `_type._tcp`; Android tolerates it.
    // Android's own docs show `_type._tcp.`, which is what caused the drift.
    const swift = constant(read(LAN_SWIFT), 'serviceType');
    expect(swift?.endsWith('.')).toBe(false);
  });

  it('matches the NSBonjourServices entry iOS actually publishes under', () => {
    // Without a matching Info.plist entry iOS silently returns zero results —
    // another failure indistinguishable from an empty network.
    const swift = constant(read(LAN_SWIFT), 'serviceType');
    expect(read(INFO_PLIST)).toContain(`<string>${swift}</string>`);
  });
});

describe('BLE GATT identifiers', () => {
  it('uses identical service and characteristic UUIDs on both platforms', () => {
    const swiftSource = read(BLE_SWIFT);
    const kotlinSource = read(BLE_KOTLIN);

    for (const name of ['serviceUUID', 'chunkUUID', 'identityUUID']) {
      const swift = constant(swiftSource, name);
      expect(swift, `${name} missing from Swift`).toBeTruthy();
      // Kotlin names them SERVICE_UUID / CHUNK_UUID / IDENTITY_UUID via
      // UUID.fromString("..."), so compare on the literal itself.
      expect(
        kotlinSource.includes(swift as string),
        `${name} (${swift}) not found in the Kotlin half`,
      ).toBe(true);
    }
  });
});
