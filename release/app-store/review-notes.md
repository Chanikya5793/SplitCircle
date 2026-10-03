# App Review notes

ManaSplit combines shared-expense records, private group messaging, and audio or video calling. It does not move money. It offers optional subscriptions and consumable Mana Credits for repeated use of Advanced Split completion after the free allowance is exhausted.

## Review access

Account creation supports Sign in with Apple and the other sign-in options visible in the app. Two durable demo accounts are ready with a populated fictional group, sample expenses, and a stable expected balance. Both passwords passed real sign-in checks on September 10. This is not a claim that their Firebase emailVerified flags are true. Passwords are stored outside the repository in macOS Keychain under the `ManaSplit App Review` service.

- Primary demo username: `appreview.239.20260903@manasplit.com`
- Secondary demo username: `appreview.239b.20260903@manasplit.com`
- Demo group: `Austin Weekend`
- Expected balance: `You are owed $19.20`
- Review contact name: Chanakya Thotakura
- Review contact email: `hello@manasplit.com`
- Review contact phone: saved in App Store Connect in international format

If two accounts are needed to exercise messaging or calling, place the second account credentials here too.

## Suggested review path

1. Sign in with the demo account.
2. Open the populated review group on the Expenses tab to inspect balances and expense history.
3. Open the group's chat to view messages and an expense card.
4. Use Add Expense and open Advanced Split to inspect itemized, income, consumption, time-based, and item-type modes. Opening, editing, canceling, or receiving an error does not consume an included use or Mana Credits.
5. Open Settings, then Plans & Mana Credits, to inspect localized subscription and credit-pack offers. Restore Purchases and Manage Subscription are available there.
6. TestFlight purchases run in Apple's sandbox and do not charge the tester. Only a successfully completed eligible operation consumes an included use or an approved credit reservation.
7. Open Settings to review privacy controls and the in-app account-deletion flow.
8. Audio and video calling require a second signed-in account and normal network, microphone, camera, notification, and CallKit permissions.

## In-app purchases and quota behavior

- The ManaSplit Memberships subscription group contains Essential, Plus, Pro, Power, and Max, each with monthly and annual products.
- Consumable packs contain 25, 80, 200, or 500 non-expiring purchased Mana Credits.
- Ordinary expenses, edits, groups, balances, settlements, recurring bills, messaging, calls, blocking, reporting, export, and account deletion are not paywalled.
- Advanced Split completion is the only customer workflow currently enforced. Other candidate premium features cannot consume credits.
- The server authorizes and reserves quota or credits before completion, then commits only after success. Cancellation, failure, and duplicate retries cost zero credits.
- Apple-signed transactions are verified on the server before the client finishes them. App Store Server Notifications reconcile renewals, refunds, and revocations.
- Permanent mode purchases, credit gifting, wallet transfers, Family Sharing, and randomized-mode monetization are not offered in this version.

## iOS and AI behavior

Version 1.0.0, build 0.0.244 uses Xcode 27 RC (27A266a) and the iOS 27.0 SDK. It supports iOS 17 and later. Supported Apple Intelligence features run on eligible devices. The app uses other supported methods when the model is unavailable. AI does not move money or change a shared expense without the user's confirmation.

## User safety controls

In chat, people can report a message from its action menu, block or unblock another person from the chat or group member menu, and keep the sensitive-content filter enabled. Blocking prevents direct messages, calls, and attachments in both directions. Server-authorized call, message, and group-member mutations enforce membership and role checks and apply bounded payload and rate limits. Reports are stored in a server-only moderation collection for manual review.

## Local-first architecture

Message and call history are stored on the device. Firebase Realtime Database is used as transient message and call-signaling transport, while Firestore stores account, group, chat metadata, and expense records. LiveKit carries call media. Account deletion is available in the app and at the public privacy-choices URL.

## Current submission boundary

- Version 1.0.0, build 0.0.244 was submitted September 10 at 12:55 AM. Apple rejected it September 14 under Guideline 5 because CallKit was enabled while China mainland was available. This live verification supersedes the older local claim that submission was unfinished.
- Submission `afc7e32a-1b9e-4e32-91d8-c357504139f7` contains 16 items: the app, subscription group, ten subscriptions, and four credit packs. The app is rejected; other submitted items cannot be approved until unresolved issues are addressed.
- China mainland was removed from app availability September 14 and reload-verified as Not Available, with 174 other territories retained. CallKit remains unchanged. Apple says territory changes can take up to 24 hours. A replacement build is requested and must be validated before resubmission; build 0.0.244 must not be resubmitted.
- Production and Sandbox notification URLs are saved. Purchase History and Product Interaction are published as account-linked data used for App Functionality, not tracking. The draft version is 1.0.0.
- All product Review Information screenshots are saved and reload-verified. Fixed the 25-credit pack's missing country availability; all products passed draft inclusion validation.
- Primary reviewer login and the live monetization snapshot were verified: sandbox environment, free plan, standard access without quota bypass, commerce enabled, active sandbox grant through October 8. The secondary chat/call account uses production commerce and is not the sandbox purchase account.
- Before commercial submission, verify real sandbox purchase and restore/lifecycle behavior, then send the completed draft. Read-only September 10 checks found zero sandbox Apple transaction records and zero sandbox Apple notification records. Device Hub automation cannot navigate the phone, and the last capture showed it locked; the user must participate in the genuine StoreKit checkout check.
- Nearby delivery is enabled and should be tested on compatible hardware if Apple requests it.
