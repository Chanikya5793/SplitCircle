# ManaSplit Security Monitoring — Resume Evidence

Date: 2026-08-13

Branch: `ui-revamp`

Primary implementation commit: `fb436f6902f86d5d2ee1368d5540c135e8328bbb`

## Status boundary

The end-to-end product path is implemented in code and validated with direct unit, service, DOM, Functions, and Firestore-emulator tests. It is **not production-enabled yet**: the Firebase project has billing disabled, the new secrets and Cloud KMS key are not configured, Flare and Google Web Risk credentials were unavailable, and no physical-device notification matrix was available. Do not describe commercial dark-web monitoring, scheduled scans, or device alerts as live production capabilities until the gates in “Remaining production gates” are closed.

## Exact source map

| Capability | Source of truth |
|---|---|
| AES-256-GCM envelope encryption, per-user wrapped DEKs, KMS adapter, blind indexes, UID/identity/type AAD | `functions/src/security/crypto.ts` |
| Authenticated enrollment, ownership verification, idempotent manual/scheduled scans, key rotation, timeline, privacy controls, provider cleanup, notification copy | `functions/src/securityMonitoring.ts` |
| HIBP breach/paste/stealer normalization and Flare identifier/feed/deletion adapter | `functions/src/security/providers.ts` |
| Deterministic severity, confidence, risk factors, likely attacks, and remediation | `functions/src/security/riskEngine.ts` |
| URL lexical checks, lookalikes, IDN/homoglyphs, DNS guard, RDAP, TLS, certificate transparency, Google Web Risk | `functions/src/securityUrlAnalysis.ts` |
| Security data contracts | `functions/src/security/types.ts`, `src/models/security.ts` |
| Server-owned storage boundary | `firestore.rules`, `firestore.indexes.json`, `firebase.json` |
| Account-deletion integration | `functions/src/accountDeletion.ts`, `functions/src/index.ts` |
| Password k-anonymity client | `src/services/pwnedPasswordService.ts` |
| Evidence-bounded on-device/PCC analyst | `src/services/securityAnalystService.ts` |
| Callable client boundary | `src/services/securityMonitoringService.ts` |
| Security Center, findings, actions, consent, deletion, provider health, timeline | `src/screens/security/SecurityCenterScreen.tsx`, `src/screens/security/SecurityFindingCard.tsx` |
| Settings, navigation, search, notification tap, and deep-link entry | `src/screens/settings/SettingsScreen.tsx`, `src/navigation/types.ts`, `src/navigation/RootNavigator.tsx`, `src/services/searchService.ts`, `src/services/deepLinkService.ts`, `src/context/NotificationContext.tsx` |

No monitored identity or password is cached locally, so there is no local security-monitoring key to place in Keychain/Keystore. Password input is held only in component memory, hashed locally, cleared after the request, and never sent in full. Server identity ciphertext uses a per-user DEK wrapped by Cloud KMS; provider credentials use Firebase Secret Manager bindings.

## Direct security tests

| Invariant | Direct test |
|---|---|
| Encryption round-trip, randomized ciphertext, AAD user isolation, per-user DEK reuse, rotation, blind-index scoping | `functions/src/security/crypto.test.ts` |
| HIBP k-anonymous account matching, partial stealer entitlement, Flare normalization, raw-secret dropping, provider deletion credential requirement, stable dedupe | `functions/src/security/providers.test.ts` |
| Infostealer/session exposure, security-state offsets, deterministic repeatability | `functions/src/security/riskEngine.test.ts` |
| Lookalikes, Web Risk, unsafe schemes, SSRF address rejection, RDAP/TLS/CT enrichment, fail-closed enrichment | `functions/src/securityUrlAnalysis.test.ts` |
| Multi-identity provider-health aggregation and generic notification privacy | `functions/src/securityMonitoring.test.ts` |
| Owner denial, cross-user denial, anonymous denial, provider-deletion tombstones, shared provider references | `functions/src/securityRules.test.ts` |
| Local five-character Pwned Passwords prefix and padded-range parsing | `src/services/__tests__/pwnedPasswordService.test.ts` |
| Prompt-injection containment, fabricated-citation rejection, grounded-citation acceptance | `src/services/__tests__/securityAnalystService.test.ts` |
| Finding evidence, acknowledgement, AI-source disclosure, explicit deletion | `src/screens/security/__tests__/securityFindingCard.test.tsx` |

Deletion and revocation are wired through callable handlers and the existing account-deletion cascade. Provider identifier deletion is reference-counted across users before the commercial provider is called; failures become server-only retry tombstones. Production provider deletion still requires a configured Flare credential and a deployed function.

## Measured validation

Commands were run from `/Users/chanakya/SplitCircle`.

| Validation | Result |
|---|---|
| `npx tsc --noEmit` | Passed |
| `npm --prefix functions run build` | Passed |
| `npm run test:unit` | 654 passed |
| `npm run test:services` | 471 passed |
| `npm run test:dom` | 30 passed after the finding-deletion test was added |
| `npm --prefix functions test` | 65 passed after the provider-ownership regression was added; 4 emulator-only tests skipped in the ordinary run |
| Firestore emulator security suite | 4 passed; 10 attempted client reads/writes were denied; 0 unauthorized operations succeeded |
| Total automated assertions across the distinct suites | 1,224 passed, including the 4 emulator-only assertions |
| TypeScript/functions diff check | Passed |

Warnings emitted by unrelated existing DOM and nearby-transport tests were non-fatal. No native Release build was run, consistent with repository policy.

## Coverage measured on the security-specific surfaces

Coverage was measured with Vitest V8 coverage after adding `@vitest/coverage-v8` 3.2.6 to both workspaces.

| Scope | Lines | Branches | Functions |
|---|---:|---:|---:|
| Server crypto, provider adapters, risk engine, and URL analyzer | 78.93% | 69.07% | 81.81% |
| `functions/src/security/crypto.ts` | 84.70% | 86.66% | 62.50% |
| `functions/src/security/providers.ts` | 74.78% | 39.70% | 92.30% |
| `functions/src/security/riskEngine.ts` | 95.41% | 92.53% | 100% |
| `functions/src/securityUrlAnalysis.ts` | 76.12% | 70.12% | 77.77% |
| Client password checker plus AI analyst | 72.81% | 76.92% | 71.42% |
| `src/services/pwnedPasswordService.ts` | 100% | 66.66% | 100% |
| Finding-card interaction surface | 94.05% | 58.53% | 70% |

These are deliberately scoped security-surface measurements, not repository-wide coverage claims. The callable orchestration layer is primarily covered through compilation, pure invariant tests, and Firestore security-rule tests; live KMS/provider execution remains a production gate.

## Provider proof matrix

| Provider/signal | Implemented | Fixture tested | Sandbox tested | Live validated in this work | Honest status |
|---|---:|---:|---:|---:|---|
| HIBP breach account/range + breach catalog | Yes | Yes | Integration-test account endpoint returned HTTP 200 in 147 ms; exact range test key returned HTTP 401 | No user identity used | Adapter and normalization verified; production entitlement not configured |
| HIBP paste/stealer metadata | Yes | Yes, including infostealer normalization and 403 partial behavior | Stealer integration key returned HTTP 401 | No | Requires eligible HIBP plan/domain before production claims |
| HIBP Pwned Passwords | Yes | Yes | Public range API returned HTTP 200 in 167 ms | Yes, with a known public test password only | Live protocol verified; no user password used |
| Flare commercial dark-web intelligence | Yes, real v3/v4 API paths and deletion lifecycle | Yes | No | No | Credentials/tenant entitlement unavailable; do not market as live |
| Google Web Risk | Yes | Yes | No | No | API key unavailable |
| DNS + RDAP + TLS + CT enrichment | Yes | Yes | N/A | `example.com` produced DNS, RDAP, and authorized TLS evidence; CT timed out, so aggregate status was `partial` in 10.5 s | Live partial proof; analyzer fails closed on incomplete enrichment |

The integrations use documented vendor APIs. No criminal forum scraping, stolen-data purchase, raw dumps, passwords, cookies, or session tokens are part of the design.

## Security and privacy measurements

- Cross-user leakage in the emulator test matrix: **0 successful unauthorized operations out of 10 attempts**.
- Raw passwords, cookies, tokens, or credential dumps retained by the normalization fixtures: **0**; tests inject sentinel secrets and assert they are absent from serialized results.
- Password request disclosure: **5 SHA-1 prefix characters**; full password and full hash sent: **0**.
- AI citation validation: **2 of 2 invalid/uncited samples rejected** and **1 of 1 grounded sample accepted**. This is exact regression behavior, not a broad model-accuracy estimate.
- Finding dedupe: identical identity/source references produce the same key; different identities produce different keys. Repeated scans increment `scanMatchCount` but no longer inflate distinct-exposure scoring.
- Notifications: both default and opt-in variants exclude identity, provider, breach, password, cookie, token, and infostealer terms. Detailed mode currently reveals only that a high-risk finding exists.
- URL analysis never performs HTTP navigation to the submitted host. DNS results are checked for private/reserved addresses before a bounded TLS handshake; RDAP, CT, and Web Risk requests go only to fixed provider endpoints.

## Deployment and device proof

- `firebase deploy --only functions,firestore:rules,firestore:indexes --dry-run` built Functions, read the new index file, and compiled Firestore rules successfully.
- The dry run stopped when Secret Manager returned HTTP 403 for the pre-existing `APNS_AUTH_KEY` because billing is disabled on Firebase project `splitcircle-c9e46`.
- No security Functions, rules, indexes, KMS configuration, or secrets were deployed by this work.
- A JS bundle was embedded into the booted iOS 27 simulator and the app launched. The existing app screen rendered, but the deep-link confirmation sheet could not be accepted in the headless simulator environment, so the native Security Center screen does not have completed visual proof.
- No physical-device matrix was available. Foreground, background, killed-state, locked-device, linked-device, and actual push-delivery behavior remain unverified.

## Remaining production gates

1. Enable Firebase billing and create/grant the Cloud KMS key referenced by `SECURITY_MONITORING_KMS_KEY`.
2. Configure `SECURITY_BLIND_INDEX_KEY`, `HIBP_API_KEY`, `FLARE_API_KEY`, and `GOOGLE_WEB_RISK_API_KEY` in Secret Manager; provision the required HIBP and Flare entitlements.
3. Deploy Functions, Firestore rules, and the `enabled + nextScanAt` composite index; confirm the exported security functions appear in the target project.
4. Exercise Flare enrollment/feed/deletion in its approved tenant and Google Web Risk with its real API key; record sanitized request IDs, status, and latency.
5. Implement approved proof flows for usernames and non-auth phone/email identities. They currently remain encrypted and pending; only matching verified Firebase Auth email/phone and DNS TXT domains become scannable.
6. Run live KMS enrollment, rotation, scheduled scan, partial-provider retry, deletion tombstone, account deletion, and consent-revocation acceptance tests.
7. Run the full physical-device alert matrix, including generic lock-screen copy and notification taps, plus linked-device/account-switch behavior.
8. Complete native visual/accessibility QA for the Security Center and allowlisted external-security-page confirmation.

## Resume bullets — use only with the status qualifiers above

- Engineered ManaSplit’s evidence-first consumer protection center with AES-256-GCM envelope encryption, per-user Cloud-KMS-wrapped keys, scoped blind indexes, authenticated scan jobs, HIBP and fixture-verified Flare adapters, normalized dark-web/infostealer evidence, k-anonymous password checks, and privacy-safe deletion and alert controls.
- Built deterministic phishing, impersonation, credential-stuffing, account-takeover, and scam-risk scoring from breach, DNS/RDAP, TLS/CT, reputation, and account-security signals, then added citation-validated on-device/PCC explanations and validated the system with 1,224 automated assertions and zero successful cross-user accesses in the emulator matrix.
