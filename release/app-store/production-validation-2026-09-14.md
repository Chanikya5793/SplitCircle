# Replacement release validation, September 14, 2026

## Current update: September 22

App Store Connect finished processing build 0.0.246 and marked it Ready to Submit. The existing version was updated from 0.0.245 to 0.0.246; reviewer notes were updated and the selection was verified after reload. Update Review restored the existing 16-item package to Ready for Review. The September 22 12:55 AM App Review reply explains the corrected photo-library purpose string, its dinner-receipt example, and the wider permission audit. Live ASC then showed the existing submission `afc7e32a-1b9e-4e32-91d8-c357504139f7` resubmitted by Chanakya Chowdary at 12:55 AM, with version 1.0.0 build 0.0.246 and all 16 items Waiting for Review. Automatic release after approval was selected on the version page before resubmission. This is a pending review, not Apple approval or physical purchase/restore acceptance.

## Historical update: September 21

Build 245 is now Rejected, verified live in ASC. Apple's September 21 2:32 PM message cites Guideline 5.1.1(ii) and specifically requests a photo-library purpose string that explains its use with an example. The other 15 submission items remain Ready for Review. The old China/CallKit issue was not repeated.

The photo, camera and microphone strings have been corrected in app.config.ts and the native Info.plist, with actual feature examples. Three native/config parity regression tests were added. Current validation: TypeScript passes; 686 unit and 501 service tests pass; plist syntax and resolved Expo permission strings pass. No new binary or on-device permission dialog has been verified yet. Downloading Apple's screenshot attachment failed, so no claim is made about its visual contents.

The user cleared storage. Build 0.0.246 was archived locally under Xcode 27.0, signed, and exported to `build-output/SplitCircle-production-20260921-223442.ipa` (SHA-256 `83460e76e0a14d32a93e6f413fc4a7e083f1be181f6b37a7e429ef4952bca37b`). The final IPA contains the corrected photo, camera, microphone, location, Face ID, local-network, and Bluetooth explanations; obsolete Always-location and photo-add declarations are absent. Main app and notification extension are both 1.0.0 (0.0.246). Archive code signature verifies, production APNs is present, and `get-task-allow` is false. Local preflight passed 686 unit and 501 service tests. Transporter shows Delivered on September 22 at 12:48 AM; Apple processing is ongoing. No ASC version change, reviewer reply, or resubmission has occurred yet. Next: wait for processing, attach the new build, update notes, reply and resubmit. Purchase/restore acceptance remains unverified and the expired tester grant must not be automatically renewed.

## Historical update: September 17

Live Chrome App Store Connect confirms version 1.0.0 with build 0.0.245 is Waiting for Review. The review details show September 17 at 5:29 PM as the submission time, Chanakya Chowdary as submitter, and all 16 items Waiting for Review under submission `afc7e32a-1b9e-4e32-91d8-c357504139f7`. Automatic release after approval remains selected. The assistant only checked status and did not initiate, cancel, or modify this pending submission.

Apple's September 17 3:58 AM message asks for resubmission after adjustments. The earlier September 14 reply explaining China mainland removal is visible. The pending submission page exposes no reply control; no new message was sent. Earlier statements below that final resubmission had not occurred are historical and superseded by this live state. Recorded purchase/restore acceptance is still unverified; do not infer successful testing or approval from the queue status.

## Scope

Version 1.0.0, replacement build 0.0.245, from the existing dirty `ui-revamp` checkout. Preserve unrelated changes. No PR, DNS change, product recreation, or new simulator Release build.

## Fixed

- Apple rejected build 0.0.244 for CallKit with mainland China availability. China mainland is now Not Available, verified after reload; the other 174 territories remain selected. The correction was sent to App Review and the posted reply was verified.
- Removed the unfinished live-location button, its Coming Soon alert, and its unnecessary background-location permission request. Sending a location pin remains supported. Added two release-regression tests.
- Cleared rebuildable Xcode derived output, CocoaPods and React Native caches, and npm download cache with user approval. Approximately 4.5 GB was reclaimed. Saved archives, IPAs, and source files were retained. Protected portions of the dotslash DevTools cache could not be removed and were left alone.

## Verified

- TypeScript: `npx tsc --noEmit` passes.
- App unit tests: 674 passed.
- App service tests: 501 passed.
- UI/context tests: 31 passed.
- Backend compilation: passes.
- Backend tests with Firestore and Realtime Database emulators: 165 passed, none skipped. Used the installed Java 21 runtime and an isolated demo project, not production data.
- Total automated tests: 1,371 passed.
- Production privacy, support, terms, deletion, and security URLs return HTTP 200.
- `manasplit.com` has iCloud MX records. This does not prove delivery to each support mailbox.
- Primary reviewer password sign-in succeeds; the live monetization snapshot returns HTTP 200 with sandbox commerce enabled and the free plan.
- Production purchase verification, monetization snapshot, and Apple server-notification functions are ACTIVE.
- No Coming Soon, lorem ipsum, or unimplemented feature controls remain in the scanned app source. Form hints, loading skeletons, contact fallbacks, and example input formats are intentional and were not removed. An internal unwired name-capture notification comment is not a customer-facing promised feature.
- EAS build preflight passes. Build 0.0.245 uses the selected Xcode 27 RC 27A266a. Fresh dependency installation applied all seven patch-package patches.
- Archive and export succeeded. Saved IPA: `build-output/SplitCircle-production-20260914-171357.ipa`. Saved archive: `/Users/chanakya/Library/Developer/Xcode/Archives/2026-09-14/SplitCircle 2026-09-14 17.17.20.xcarchive`.
- Archive signature verification passes. App and notification extension are both 1.0.0 (0.0.245). The app uses `iphoneos27.0`, minimum iOS 17, production APNs, `get-task-allow: false`, the ManaSplitAppIcon catalog, scene lifecycle manifest, and `NSAllowsArbitraryLoads: false`.
- IPA SHA-256: `5d2877e3059e9437f254944dfc11c59867935bdfc547879640c78d65fce39643`.
- EAS upload job: `277e7ef8-3bcb-4ec9-8629-4520d9d0d9bd`, created September 14 at 5:27 PM, was canceled to switch to the user's requested Transporter delivery. The signed-in Expo console was reloaded and verified Canceled, with no delivery logs; the local waiting command also exited with submission canceled. The build itself was local and remains saved. Transporter's file picker is open at the exact build 245 IPA, but automated import has not succeeded. No Transporter delivery has been started or verified. Do not restart the old EAS job, rebuild, or create duplicate uploads; check Transporter and Apple first.
- The generated production JavaScript bundle contains the real product IDs and no removed live-location promise or PEM private-key marker in the targeted scan. This is not a comprehensive secrets audit.

## Open findings and release gates

- At 6:38 PM, Transporter showed build 0.0.245 delivered at 6:31 PM and processing finished. App Store Connect independently showed Ready to Submit in TestFlight with Team (Expo). Build UUID: `5c7f7e0b-65eb-4015-b918-6b36dc807779`. The saved local IPA was used; no rebuild or duplicate upload occurred. This supersedes the earlier pending-Transporter status above.
- At approximately 6:44 PM, build 0.0.245 and corrected reviewer notes were saved and reload-verified on version 1.0.0. Notes preserve credentials, replace the old build reference, and describe the China mainland exclusion and removed unfinished live-location control. Automatic release after approval is unchanged. Update Review succeeded; all 16 items are Ready for Review and Resubmit to App Review is enabled. Final resubmission was not clicked. The build-row Delete control initially timed out because it had zero width until the row was hovered; clicking the noninteractive part of the row revealed it, after which the exact scoped control worked. Screenshots were not deleted.
- A bounded verifier-log check after the sandbox grant found no new rejection records between 23:11:47 UTC and this check. Absence of rejection logs is not evidence of successful purchase or restore. User-assisted physical acceptance remains required, now on the processed replacement build.

- At 5:42-5:45 PM, the user opened Plans & Credits on physical iPhonePro build 0.0.244 and completed the Apple TestFlight Plus Annual confirmation. Apple's sheet explicitly said the purchase was for testing and would not be charged. ManaSplit then displayed `Apple could not verify this purchase.` Production verifier logs at 22:44:18Z and 22:44:26Z confirm `invalid_environment`. The failing account does not match either configured App Review account. Do not repeat purchases, finish transactions manually, weaken environment verification, or submit until the exact app login and its sandbox test configuration are resolved and purchase/restore passes. The paywall showed USD while Apple's confirmation showed INR; source uses StoreKit `displayPrice`, not a hardcoded fallback. Storefront refresh remains to be checked.
- At 5:43 PM, App Store Connect still listed 0.0.244 as the newest TestFlight build. The review package retains all 16 items: the app remains Rejected and the other 15 items are Ready for Review. Automatic release after approval remains selected. Build 0.0.245 delivery is still queued; final resubmission has not occurred.
- At 5:52 PM, the user clarified separate Apple and ManaSplit identities. The supplied Gmail login exists and already has an unexpired sandbox internal-test claim through October 8. However, its hashed Firebase account ID does not match the account digest in either failed verification request. No grant or billing configuration was changed. Confirm the actual app profile before altering access or retrying checkout; the Apple ID and app login are allowed to differ.
- At 6:10 PM, iPhone Mirroring showed the actual Settings profile. A lookup of that exact displayed email matched both failed verifier account digests. This is a Google-provider login with an iCloud email address, not the separate Gmail owner account. The authorized local test-access command successfully applied a 48-hour sandbox-commerce grant, expiring September 16 at 23:11:47 UTC. A subsequent Auth read verified `sandbox_commerce_tester`, `sandbox`, and no internal-test quota-bypass claim. The user must refresh the Firebase session by signing back into the same ManaSplit account before retrying. No production entitlements or Apple transaction bindings were modified. Existing unverified transactions must still satisfy account-token binding; do not manually finish them or claim they were restored.
- Device Hub still times out after targeted process restart and the user resetting its app approval. Both macOS control and screen-recording permissions are enabled. iPhone Mirroring now connects and supports screenshots and keyboard navigation, but pointer and scroll actions return `noWindowsAvailable`. User assistance remains necessary for taps and checkout authentication.

- Genuine Apple sandbox purchase, restore, and lifecycle acceptance is not yet demonstrated. Read-only backend checks still show zero sandbox transaction and notification records. At 5:40 PM, iPhonePro was confirmed unlocked, the installed build 0.0.244 launched successfully through devicectl, and a device screenshot showed the Expenses screen. Device Hub computer-control requests still time out, including when targeting its current Xcode application path. This is an automation failure, not evidence that the phone is locked. Real purchase and restore interaction is still required; mocks and paywall screenshots do not satisfy this gate.
- npm's app dependency audit reports 31 findings: 9 high, 21 moderate, 1 low. The high findings trace to image-size/Metro/Expo build tooling and brace-expansion via minimatch. No application-source imports of image-size or brace-expansion were found. Do not claim the dependency audit is clean or apply npm's proposed breaking Expo downgrade blindly. Building trusted local assets is distinct from exposing these parsers as a production service.
- Backend dependency audit: 10 findings, 9 moderate and 1 low, none high or critical. Review compatible upgrades separately before claiming zero known dependency issues.
- Full cross-platform brand validation fails on existing Android WEBP/PNG resource mismatches. This is not an iOS icon failure; no unrelated Android resource rewrite was made for this iOS submission.
- App Store processing and replacement attachment are verified. Physical purchase/restore, smoke checks, and final resubmission remain open. Build 0.0.244 must not be resubmitted.

Apple approval, complete physical-device coverage, and zero vulnerabilities are not established by these checks.

## September 15 daily follow-up

- At approximately 6:08 PM Chicago time, read-only Firestore aggregate queries still returned zero sandbox Apple transaction records and zero sandbox Apple notification records. A bounded verifier warning/error query since the September 14 sandbox grant returned no records. This does not establish purchase or restore acceptance.
- Refreshing the same Chrome App Store Connect tab showed the Apple sign-in screen. The review package could not be reverified live in this run; the last confirmed state remains September 14, build 0.0.245 attached with all 16 items Ready for Review. No review submission, re-upload, rebuild, entitlement edit, or renewed test-access grant was performed. User sign-in is required to resume live ASC checks.

## September 16 daily follow-up

- Read-only Firestore aggregate queries still show zero sandbox Apple transaction records and zero sandbox Apple notification records. The existing Chrome tab remains at Apple sign-in; no current review-state claim can be made beyond the September 14 verified state.
- The previously verified 48-hour sandbox-commerce grant reached its recorded expiry at September 16, 23:11:47 UTC (6:11:47 PM Chicago). It was not extended or reissued. Before a future purchase retry, verify valid sandbox test access and refresh the app session with the user. Do not reuse an expired grant, bypass transaction environment/account-token checks, or initiate another purchase automatically.
- No build, upload, ASC mutation, or final review resubmission was performed.
