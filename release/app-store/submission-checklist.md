# ManaSplit public-release checklist

## 22 September 2026 current review status

- [x] App Store Connect confirms that the existing submission `afc7e32a-1b9e-4e32-91d8-c357504139f7` was resubmitted September 22 at 12:55 AM by Chanakya Chowdary. Version 1.0.0 now uses build 0.0.246, and all 16 items show Waiting for Review. Automatic release after approval was selected on the version page before resubmission.
- [x] App Review reply posted at 12:55 AM, explaining the corrected photo-library purpose string with the dinner-receipt example and the broader permission-copy audit. The message count increased to five and the reply text was visible.
- [ ] Await Apple review. Genuine sandbox purchase/restore acceptance remains unverified, and submission is not approval.

## 21 September 2026 rejection correction (completed)

- Live App Store Connect: version 1.0.0 (0.0.245) is Rejected under Guideline 5.1.1(ii). Apple's September 21, 2:32 PM message requests a specific photo-library purpose string with an example. Review devices: iPad Air 11-inch (M3) and iPhone 17 Pro Max. The existing submission retains 16 items; the other 15 are Ready for Review. This supersedes the September 17 queue status.
- [x] Replaced the generic photo-library explanation in both `app.config.ts` and the hand-maintained `ios/SplitCircle/Info.plist`. It describes selected chat media, receipt attachments, profile/group images and wallpapers, with a dinner-receipt example. Camera and microphone messages also now describe actual features and examples. No permission scope or backend behavior was changed.
- [x] Checked real photo-selection call sites; added three regression tests for native/config parity and concrete examples. TypeScript, 686 unit tests, 501 service tests, plist validation, and resolved Expo permission configuration pass.
- [x] Built 1.0.0 (0.0.246) locally with Xcode 27.0 after the user cleared space. `build-output/SplitCircle-production-20260921-223442.ipa`, SHA-256 `83460e76e0a14d32a93e6f413fc4a7e083f1be181f6b37a7e429ef4952bca37b`. Verified the embedded photo and other purpose strings, absence of unused Always-location/photo-add strings, app and extension version parity, archive signature, production APNs and `get-task-allow=false`. Transporter shows Delivered September 22 at 12:48 AM; Apple processing is ongoing.
- [x] Apple processed 0.0.246 and marked it Ready to Submit. Replaced 0.0.245 on version 1.0.0, updated reviewer notes, saved, and verified after reload. Update Review restored all 16 items to Ready for Review. Replied to Apple and resubmitted as recorded above.
- Screenshot attachment `Screenshot-0921-113156.png` was requested through ASC but asset download failed; its contents were not inspected. The rejection message itself was read live.
- Preserve China mainland exclusion, other territories, automatic release setting, IAP items, unrelated macOS draft and reviewer credentials. Genuine sandbox purchase/restore acceptance remains unverified. Do not renew the expired temporary tester grant automatically.

## 17 September 2026 historical review status

- [x] Live App Store Connect confirms version 1.0.0, build 0.0.245, was submitted September 17 at 5:29 PM by Chanakya Chowdary. Submission `afc7e32a-1b9e-4e32-91d8-c357504139f7` and all 16 items now show Waiting for Review. This supersedes the earlier pending-resubmission notes below. The assistant did not initiate this resubmission during the status-check turn.
- [x] Automatic release after approval remains selected. The submitted build was not changed, canceled, or re-uploaded.
- Apple replied September 17 at 3:58 AM asking for resubmission after the adjustments. The September 14 China-mainland correction reply remains visible. The pending submission page has no reply control, so no additional message was sent and the submission was not disturbed to enable one.
- Physical purchase/restore acceptance remains unverified in the recorded evidence. Submission status is not proof of successful purchase testing or Apple approval.

## 14 September 2026 rejection correction (historical preparation)

- Live App Store Connect confirms submission `afc7e32a-1b9e-4e32-91d8-c357504139f7` was submitted September 10 at 12:55 AM. Apple reviewed version 1.0.0 (0.0.244) on September 14 using an iPhone 17 Pro Max and rejected the app under Guideline 5: CallKit was active while China mainland was an available territory. Earlier local statements that submission had not occurred were stale.
- [x] Removed only China mainland from app availability and verified after reload: 174 countries or regions remain available; China mainland is Not Available. Hong Kong, Macau, and Taiwan remain Available on App Release. No CallKit code or other country settings were changed.
- [x] Sent a reply to App Review explaining the saved territory correction and that a replacement build will be validated before resubmission. Verified the posted message at 4:50 PM September 14. Updated the submission automation so it will not resubmit build 0.0.244.
- [x] Removed the unfinished live-location control and unnecessary background-location permission request; location-pin sending remains supported. Added two regression tests. Current checkout passes TypeScript plus 674 unit, 501 service, 31 UI/context, and 165 backend emulator tests (1,371 total).
- [x] With September 14 cleanup approval, reclaimed about 4.5 GB from rebuildable developer caches without deleting saved archives, IPAs, or source files. Build 0.0.245 completed, signed, and exported using Xcode 27 RC. App and extension versions and production entitlements were verified.
- [x] Complete Apple delivery and processing of replacement build 0.0.245. Transporter shows Delivered September 14 at 6:31 PM and processing finished. Live TestFlight confirms Ready to Submit and the Team (Expo) internal group. IPA: `build-output/SplitCircle-production-20260914-171357.ipa`; SHA-256: `5d2877e3059e9437f254944dfc11c59867935bdfc547879640c78d65fce39643`. EAS delivery job `277e7ef8-3bcb-4ec9-8629-4520d9d0d9bd` remains canceled. Do not rebuild, restart delivery, or upload again.
- [x] Attached build 0.0.245 to version 1.0.0, updated reviewer notes with the replacement build and China mainland correction while preserving credentials, saved, and reload-verified. Automatic release after approval remains selected. Update Review succeeded: the existing submission retains all 16 items, all Ready for Review, and Resubmit to App Review is enabled. Final resubmission has not been clicked because physical purchase/restore acceptance remains unresolved.
- [ ] Complete genuine sandbox purchase/restore acceptance and resubmit the replacement. Availability correction is not a claim of purchase-test completion or Apple approval.

The September 9/10 checklist below is historical preparation evidence, not the current review status.

Detailed evidence and remaining dependency findings: [September 14 validation](production-validation-2026-09-14.md). Automated checks are not physical purchase/restore or public-release proof.

## 9 September 2026 RC submission pass

- [x] Selected Xcode 27 RC at `/Applications/Xcode.app`, build `27A266a`, and completed first-launch component installation.
- [x] Passed 672 unit tests and 501 service tests.
- [x] Built and signed version 1.0.0, build 0.0.244. Main app and notification extension match and use `iphoneos27.0`, minimum iOS 17.
- [x] Verified the archive signature and saved `build-output/SplitCircle-production-20260909-201401.ipa`.
- [x] Uploaded the RC IPA through EAS Submit; processing completed and build 0.0.244 was selected, saved, and reload-verified on version 1.0.0 on September 10.
- [x] Saved draft version 1.0.0, simplified description, promotional text, subtitle, and reviewer instructions in App Store Connect.
- [x] Published Purchase History and Product Interaction disclosures: App Functionality, linked to the user, no tracking.
- [x] Saved and reload-verified Production and Sandbox notification URLs: `https://appstoreservernotificationsv2-ivcxzr5f5a-uc.a.run.app`.
- [x] Added ManaSplit Memberships to one draft review submission. This is not a submitted review.
- [x] Finished Review Information screenshots for all ten subscriptions and all four credit packs. All use genuine physical-iPhone build 0.0.244 captures, saved locally and individually reload-verified in App Store Connect on September 10. This is screenshot completion, not purchase-test or submission completion.
- [x] Verified both reviewer passwords by real sign-in. The primary reviewer receives an enabled sandbox commerce snapshot with standard (non-bypass) access and an active grant through October 8. The secondary messaging/calling account uses production commerce and should not be used for sandbox purchase testing.
- [ ] Complete real StoreKit sandbox purchase and lifecycle checks. September 10 read-only backend checks found zero sandbox Apple transaction records and zero sandbox Apple notification records.
- [ ] Expand the public screenshots beyond the existing iPhone and iPad home screenshots. App Preview video is optional.
- [x] Attached processed build 0.0.244 and included the app, subscription group, ten subscriptions, and four credit packs in draft `afc7e32a-1b9e-4e32-91d8-c357504139f7`. Live App Review shows 16 items Ready for Review and an enabled Submit for Review button.
- [x] Fixed the 25-credit pack's missing availability setting to match worldwide app availability. Its validation now passes.
- [x] Submission occurred September 10 at 12:55 AM, as confirmed in live App Store Connect on September 14. Purchase/restore acceptance remains unverified; see current rejection correction above.

The screenshot simulators do not have the latest build. The connected physical iPhonePro was verified to have 1.0.0 (0.0.244). Device Hub (`com.apple.dt.Devices`) accessibility reads still time out, but `devicectl device capture screenshot` works on the physical phone. All fourteen product review screenshots are complete, individually saved and reload-verified, with six original captures retained under `screenshots/`. Do not treat these paywall captures as purchase-test evidence. Apple returned an unexpected error on the first app-version Add for Review attempt; one reload and retry succeeded. Failed product-page loads also recovered on retry without recreating products.

IPA SHA-256: `b22da15d358fb2668139aab2e504adb2d11279e7d6d23efea7e6a32352ab61d9`.

With user approval, removed three superseded ManaSplit archives and seven old IPAs (about 2.6 GB). Kept the RC and September 7 IPA/archive, all Android bundles, and unrelated project archives. Also cleared rebuildable temporary build and dependency caches. Do not delete the current RC artifact.

## Completed in this release-preparation pass

- [x] Confirmed working branch is `ui-revamp` and no `UoEvamp` branch exists locally or on origin.
- [x] Audited Firebase rules, callable cost surfaces, dependencies, tracked secrets, privacy manifest, and App Store safety requirements.
- [x] Replaced the live public Firebase Storage policy with authenticated, membership-scoped, size-bounded rules.
- [x] Removed the legacy direct Firestore group-join authorization bypass.
- [x] Built and deployed the public marketing, privacy, support, terms, account-deletion, security, community, and press pages.
- [x] Prepared English App Store copy, privacy-label mapping, review notes, categories, and screenshot direction.
- [x] Built, signed, inspected, and uploaded version 0.0.5, build 0.0.239, SDK iPhoneOS 27.0, minimum iOS 17.0.
- [x] Verified the main app and notification extension signatures, production entitlements, export-compliance flag, and matching build numbers.
- [x] Added in-app sensitive-content filtering, message reporting, and user block or unblock controls.
- [x] Moved message queues, calls, chat authorization, safety reports, block state, and group-member administration behind server-authorized callable functions.
- [x] Added server-side payload limits, membership checks, role checks, durable per-user rate limits, and a 20-instance ceiling to the new public mutation surfaces.
- [x] Launched an existing app installation on an iOS 27 simulator without creating a new build.
- [x] Confirmed build 0.0.239 finished Apple processing and is Ready to Submit in TestFlight.
- [x] Deployed the hardened Firestore, Realtime Database, and Storage rules after build processing completed.
- [x] Created and verified two durable App Review accounts with a populated fictional `Austin Weekend` group and an expected `You are owed $19.20` balance.
- [x] Captured, permanently saved, uploaded, and reload-verified iPhone 6.5-inch and iPad 13-inch screenshots.
- [x] Published the App Privacy disclosure and saved the required privacy and account-deletion URLs.
- [x] Saved the 13+ age rating, Finance and Social Networking categories, worldwide free availability, and iPhone/iPad platform availability.
- [x] Saved Content Rights as having the necessary rights to third-party content.
- [x] Saved version 1.0 metadata, reviewer instructions, review contact details, and build 0.0.239 in App Store Connect.

## Completed in the commerce and TestFlight pass

- [x] Implemented five subscription tiers with monthly and annual StoreKit products, plus four consumable Mana Credit packs.
- [x] Added localized product loading, purchase, server verification, restore, and Manage Subscription flows to Plans & Mana Credits.
- [x] Enforced only Advanced Split completion, with a free preview, tier allowances, Max unlimited local use, and optional credits after allowance exhaustion.
- [x] Kept ordinary financial records, messaging, calls, safety, export, and account deletion outside the paywall.
- [x] Deployed the scoped commerce, quota, Apple notification, credit-ledger, support, financial-mutation, recurring-bill, cleanup, and reservation-reaper backend.
- [x] Deployed direct-write-denying Firestore rules and the reservation expiry collection-group index.
- [x] Provisioned audited, expiring sandbox owner access and a separate sandbox-commerce reviewer account by exact Firebase UID.
- [x] Built and signed version 1.0.0, build 0.0.241 locally through Expo/EAS with native ExpoIap and OpenIAP linkage.
- [x] Verified the IPA bundle identifiers, main and notification-extension versions, distribution signature, production APNs entitlement, embedded product identifiers, and SHA-256 digest.
- [x] Uploaded build 0.0.241 through EAS Submit and confirmed Apple processing completed.
- [x] Confirmed build 0.0.241 is Ready to Submit in TestFlight and assigned to the internal Team (Expo) group with three testers.
- [x] Confirmed all ten subscriptions and all four consumable products show Prepare for Submission in App Store Connect.

## Must be completed before commerce acceptance testing

- [x] Change the App Store Connect draft version from 1.0 to 1.0.0 so it matches the processed binary.
- [x] Set both Production and Sandbox App Store Server Notification URLs to the deployed V2 endpoint. The current URL dialog did not expose a protocol-version selector.
- [ ] Exercise real TestFlight sandbox purchase, cancellation, restore, renewal, expiration, billing retry, refund, revocation, reinstall, new-device, duplicate-delivery, and account-deletion scenarios.
- [ ] Confirm quota reset, Max unlimited local behavior, purchased-credit ordering, zero-charge cancellation/failure, and multi-device serialization on physical devices.
- [ ] Reconcile the resulting Apple transaction state, notification history, entitlement projection, credit lots, and append-only audit records.

## Must be completed before Add for Review

- [ ] Establish and test a documented manual abuse-response workflow for the server-only safety report queue.
- [ ] Add App Check enforcement where compatible and durable per-user or per-device rate limits around paid or abusable callables.
- [ ] Resolve or formally risk-accept production dependency advisories after reachability testing.
- [ ] Configure and test the remaining `security`, `legal`, and `press` mail aliases. `hello`, `privacy`, and `safety` are confirmed working.
- [x] Create non-expiring App Review demo accounts and populate the review fields in App Store Connect.
- [x] Capture sanitized screenshots from the release app for iPhone and iPad.
- [x] Complete App Privacy responses using `privacy-labels.md` and publish them.
- [x] Complete the current age-rating questionnaire and accept the calculated rating.
- [x] Confirm EU Digital Services Act non-trader status, content rights, worldwide availability, and free pricing.
- [x] Confirm the exact binary declares the export-compliance flag and passes App Store Connect validation without an export-compliance blocker.
- [x] Select build 0.0.239 and save the approved metadata.
- [ ] Update the App Review notes, sign-in fields, contact fields, and privacy disclosures for subscriptions, credits, quotas, and build 1.0.0.
- [ ] Replace TestFlight build 0.0.241 with a build produced by an Apple-accepted Xcode release seed. Xcode 27 beta 6 is TestFlight-only.
- [ ] Attach the replacement non-beta build and version 1.0.0, then include the first subscription group and in-app purchases in the review submission.
- [x] User explicitly authorized final App Review submission on 9 September 2026. Do not request redundant approval for the same submission; stop only for a new material decision or unresolved readiness blocker.

## Deferred launch follow-up

- [ ] Attach the registered `manasplit.com` domain to the Cloudflare Pages project, preserve its iCloud Mail records, and verify every public URL over HTTPS. The verified Pages URLs can be used for this submission.

## Current public preview

https://manasplit.pages.dev/
