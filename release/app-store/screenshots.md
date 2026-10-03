# Screenshot production plan

## Purchase-review capture on September 9, 2026

- Verified the connected physical iPhonePro has ManaSplit 1.0.0, build 0.0.244 using `devicectl device info apps`.
- Captured the real Plans & Credits screen at 1206 x 2622 using `devicectl device capture screenshot`. Device Hub accessibility control still times out; direct physical-device capture works.
- Saved `screenshots/iphone-17pro-build244-plus-annual-review.png`, showing the Plus annual plan, its price, allowance, and purchase button without personal account content.
- Uploaded it to Review Information for ManaSplit Plus Annual v1 (6809246147). Reload verified the retained image and disabled Save button. This is a purchase-review asset, not a public device-size screenshot replacement.
- Other plan periods, tiers, and credit packs still need appropriate captures. This screenshot does not prove a successful purchase or restore.

## Purchase-review capture on September 10, 2026

- Saved `screenshots/iphone-17pro-build244-pro-max-annual-review.png`, a direct 1206 x 2622 capture from iPhonePro. It shows complete Pro annual and Max annual cards, prices, allowances, and purchase buttons, without personal account content.
- Uploaded to Pro Annual (6809246199) and Max Annual (6809245925). Both retained the image after reload with Save disabled.
- Saved `screenshots/iphone-17pro-build244-essential-power-annual-review.png`, another direct 1206 x 2622 iPhonePro capture showing complete Essential and Power annual cards, their prices, allowances, and purchase buttons. Uploaded to Essential Annual (6809246390) and Power Annual (6809246092); both retained the image after reload with Save disabled.
- Saved `screenshots/iphone-17pro-build244-credit-packs-review.png`, showing all four consumable packs, prices, purchase buttons, and the one-time-purchase explanation. Uploaded to the 25 (6809246729), 80 (6809533892), 200 (6809543161), and 500 (6809543731) credit-pack records. All four retained the image after reload with Save disabled.
- Saved `screenshots/iphone-17pro-build244-plus-pro-max-monthly-review.png`, showing the Monthly selector and complete Plus, Pro, and Max monthly cards. Uploaded to Plus Monthly (6809246142), Pro Monthly (6809246198), and Max Monthly (6809245388); all three retained their images after reload with Save disabled.
- Saved `screenshots/iphone-17pro-build244-essential-power-monthly-review.png`, showing complete Essential and Power monthly cards with prices and purchase buttons. Uploaded to Essential Monthly (6809246235) and Power Monthly (6809246188); both retained their images after reload with Save disabled.
- All fourteen commerce products now have genuine review screenshots saved in App Store Connect and backed up here. These are purchase-review images, not additional public App Store gallery images. Purchase and restore testing remain separate requirements.

## Submission assets captured September 3, 2026

- `screenshots/iphone-6.5-home.png`: 1242 x 2688, uploaded to the iPhone 6.5-inch slot in App Store Connect.
- `screenshots/ipad-13-home.png`: 2064 x 2752, uploaded to the iPad 13-inch slot in App Store Connect.
- Both screenshots use the fictional `Austin Weekend` review group and the internally consistent `You are owed $19.20` balance.
- App Store Connect was reloaded after saving and showed one retained screenshot in each required device slot.

Apple requires real app-in-use screenshots. Do not use splash screens, beta badges, private user content, personal photos, real emails, or real financial records.

Create a dedicated review account and a fictional group named `Austin Weekend` with fictional members and internally consistent balances. Capture on the exact TestFlight build selected for release.

## iPhone sequence

1. **One group. One shared plan.** Expenses overview with a clear balance and recent activity.
2. **Split it the way it happened.** Add Expense with item, percentage, shares, and exact-amount choices visible.
3. **Turn a receipt into a clear split.** Receipt review with fictional items and totals.
4. **Keep the receipt and the reply together.** Group chat containing an expense card and ordinary conversation.
5. **Call the people already in the plan.** Active group-call UI with fictional initials.
6. **Know where the group stands.** Statistics or settle-up view with an understandable chart and balances.
7. **Privacy you can inspect.** Security Center or privacy settings with no real identity data.

Supply between one and ten images. Prefer 6.9-inch portrait exports accepted by App Store Connect. The currently documented accepted portrait sizes include 1260 x 2736, 1290 x 2796, and 1320 x 2868 pixels.

Because the app declares iPad support, also supply current iPad screenshots or remove iPad support in a future binary. Do not assume iPhone screenshots satisfy the iPad requirement.

Overlay copy may explain the visible workflow, but the underlying screen must be the real app. Keep overlays within safe margins, maintain readable contrast, and avoid Apple device artwork unless it follows Apple's marketing requirements.
