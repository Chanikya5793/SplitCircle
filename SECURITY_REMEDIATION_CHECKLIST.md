# Security and Infrastructure Remediation Checklist

This file tracks audit findings and remediation progress.

## Critical

- [x] C1: Remove hardcoded LiveKit credentials from source and compiled artifacts.
- [x] C2: Secure token issuance endpoint (require Firebase auth, authorize by chat membership, and prevent identity spoofing).
- [x] C3: Harden Firestore access controls for chats/messages/calls and enforce least privilege.
- [x] C4: Harden Realtime Database rules to prevent message/receipt spoofing and unauthorized call signaling writes.
- [x] C5: Align security rules with actual data model usage (`calls`, top-level `expenses`, `recurringBills`) and deploy config.

## High

- [x] H1: Prevent partial/inconsistent group join state between `groups` and `chats` updates.
- [x] H2: Reduce call listener architecture cost (avoid per-thread full `/calls` scans).
- [x] H3: Fix group-call teardown so a single participant leaving does not destroy call for all.
- [x] H4: Fix call join race condition (use transaction/atomic participant join).
- [x] H5: Ensure failed call startup cleans up stale ringing sessions.
- [x] H6: Resolve TypeScript build failures blocking production builds.
- [x] H7: Remove sensitive production logging from auth/call/token paths.
- [x] H8: Fix premature call teardown race (stale call listeners and development unmount simulation causing self-disconnect).
- [x] H9: Ensure remote hangup ends local call reliably (RTDB session removal + LiveKit participant-left fallback).
- [x] H10: Stabilize LiveKit call screen rendering to avoid repeated reconnect attempts and lost remote-leave state.
- [x] H11: Fix chat receipt permission denials by aligning receipt write shape with RTDB rules.
- [x] H12: Implement real-time WhatsApp-style sent/delivered/read tick updates in chat UI.

## Medium

- [ ] M1: Move OCR provider key usage off client and proxy OCR via trusted backend.
- [ ] M2: Reduce over-privileged app permissions to minimum required set.
- [x] M3: Fix direct-chat identity resolution logic (do not infer "other user" from `participantIds[0]`).
- [ ] M4: Replace mock push permissions/token flow with real notifications integration.
- [x] M5: Ensure Firebase deploy config includes Firestore/RTDB rules deployment.
- [ ] M6: Resolve reported dependency vulnerabilities in root and functions packages.

## Notes

- Progress policy: check off items only after code changes are implemented and validated.
- Order of execution: Critical -> High -> Medium.
- Key management policy:
  - Public client config (`EXPO_PUBLIC_*`) is sourced from `.env`/EAS env and documented in `.env.example`.
  - Server secrets (e.g., LiveKit API secret) must live in Firebase Functions Secret Manager, not in app source/env committed to git.
