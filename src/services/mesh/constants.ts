/**
 * Mesh constants shared by modules that must stay free of native imports.
 *
 * These lived in `meshMessageProtocol.ts`, which transitively pulls in native
 * crypto. Any pure module importing them for real (not `import type`) fails at
 * test collection with "Cannot read properties of undefined (reading
 * 'EventEmitter')" — the hazard CLAUDE.md documents. The alternative was
 * duplicating the values, which drifts silently; a shared leaf module is the
 * fix that keeps one source of truth AND keeps pure modules pure.
 */

/**
 * How long a queued mesh message stays eligible. Bounds the durable queue, and
 * bounds origin re-seal (doc 33 §2.5) so a device joining a group does not
 * trigger a re-seal of every message ever queued.
 */
export const MAX_MESH_MESSAGE_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Largest signed mesh envelope accepted on the wire.
 *
 * Lives here rather than in `meshMessageProtocol.ts` for the same reason as
 * the age constant above: `bleTransport.ts` needs it to declare its total
 * payload budget, and a REAL import of the protocol module would drag native
 * crypto into a file whose unit tests must run without a device.
 */
export const MAX_MESH_ENVELOPE_BYTES = 256 * 1024;
