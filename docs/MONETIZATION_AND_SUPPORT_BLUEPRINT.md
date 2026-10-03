# ManaSplit monetization, credits, testing, and support blueprint

Status: commercial backend deployed 7 September 2026. Advanced Split completion is server-enforced, subscription and consumable-credit products exist in App Store Connect, and the StoreKit checkout client is included in the current Expo/EAS release build. Permanent unlocks, friend gifting, transfers, and monetization of other feature families remain deliberately inactive.

## Current implementation status

- Production exposes authenticated snapshot, authorization, reservation, finalization, Apple transaction verification, App Store Server Notification V2, support, cleanup, and recurring-reaper functions.
- Advanced Split completion is the only customer workflow currently enforced. The server grants the free preview or allowance first, can reserve purchased credits after allowance exhaustion, and commits a charge only after successful completion. Cancellation, duplicate retry, and failed completion cost zero credits.
- The app contains an interactive **Plans & Mana Credits** screen with localized StoreKit products, monthly and annual subscriptions, credit packs, purchase, restore, and Manage Subscription flows.
- One Apple subscription group contains Essential, Plus, Pro, Power, and Max monthly and annual products. Four consumable packs contain 25, 80, 200, and 500 Mana Credits.
- Apple-signed transactions are verified on the server before the client finishes them. Entitlements, non-expiring purchased-credit lots, replay protection, refund and revocation reconciliation, and cross-device quota state remain server-owned.
- Exact-UID internal test access is active for the owner in the sandbox environment, with audited, expiring commercial-quota bypass and no provider-safety bypass. A separate reviewer account uses sandbox commerce with ordinary quotas.
- Firestore rules reject direct client writes to entitlements, usage, credits, reservations, expenses, settlements, and recurring financial records. Financial mutations and quota authorization share server-side stale-state and idempotency checks.
- Other candidate features remain in shadow/planning status and cannot silently consume credits. Permanent mode purchases, friend gifting, wallet transfers, Family Sharing, and randomized-mode monetization are still held.

The current quotas and App Store prices are an initial launch configuration, not a permanent promise. Measure conversion, cost, reliability, and support load before expanding the catalog or changing limits.

## Executive decision

Build the commercial system around four clearly different things:

1. **Free access**: the useful core app plus small recurring allowances for premium workflows.
2. **Subscription access**: a resetting allowance of uses, not wallet credits, across eligible premium workflows.
3. **Purchased Mana Credits**: non-expiring consumable purchases that work with or without a subscription and are spent only after included uses are gone.
4. **Permanent unlocks**: one-time purchases for well-defined, local-only capability packs with no continuing provider cost.

Support six access levels internally: Free, Essential, Plus, Pro, Power, and Max. Do not present all five paid tiers at launch. Initially show Plus, Pro, and Max, then expose Essential or Power contextually only if real usage shows those segments exist.

The earlier table made Advanced Splits, Customization, and Local Insights unlimited from Essential upward. That is too generous and leaves almost no reason to move up. The revised ladder limits those premium experiences through Power and makes eligible local experiences unlimited only on Max.

Do not launch individual permanent purchases for every advanced split mode yet. Keep mode-level entitlement capability in the design, but first measure which modes people repeatedly use and whether per-mode pricing feels useful or petty. Launching many immutable StoreKit products before that evidence would create avoidable catalog, support, and trust cost.

## Non-negotiable product boundary

The following stay usable without payment:

- ordinary expenses, editing, groups, balances, settlements, and recurring bills
- Equal, Exact, Percentage, Shares, and Adjustment split methods
- access to the user's records, raw history, and a usable data export
- ordinary text and media messaging
- ordinary audio and video calling at launch
- blocking, reporting, recovery, account deletion, and other safety controls
- currently shipped themes, accents, glass/flat appearance, and wallpapers
- on-device fallback after a paid cloud path fails
- a positive free allowance or preview for every newly monetized accelerator

Paid access should save time, add depth, unlock newly produced content, or fund measurable ongoing service cost. It must not hold a person's financial records, safety, or relationships hostage.

Only the creator of a new premium result can consume an allowance. Recipients never need a matching purchase to view, understand, correct, export, or settle a split sent to them. Editing an existing expense, attaching or viewing its receipt, selecting participants or payers, syncing an offline record, and responding to unusual-amount warnings are not billable events.

### Cost map before price map

Tag every candidate operation by its real cost source before assigning a quota:

| Cost class | Current examples | Commercial implication |
|---|---|---|
| Deterministic local | Split math, ordinary statistics, appearance settings | Sell value carefully; Max can be truly unlimited |
| Apple device capability | VisionKit OCR, Foundation Models on eligible devices | Never claim a server cost or spend cloud credits when execution stays on-device |
| Persistent infrastructure | Firebase metadata, storage, relay, notifications | Measure per active user; keep core reliability out of surprise paywalls |
| Session infrastructure | LiveKit audio/video media | Keep ordinary calls free at launch; measure actual minutes before designing enhancements or fair-use controls |
| Third-party/provider | Security APIs or a future server AI/OCR fallback | Use explicit allowances and credits only when the provider path actually runs |

Record execution route, latency, success, and coarse cost class without logging financial or message content.

## What the code actually contains

The advanced split rail has five basic methods and six top-level advanced entries. The advanced entries expand into nine meaningful user experiences. The inventory comes from [the method rail](/Users/chanakya/SplitCircle/src/components/BillSplit/MethodRail.tsx:22), [the advanced UI](/Users/chanakya/SplitCircle/src/components/BillSplit/AdvancedModeContent.tsx:436), and [the split calculations](/Users/chanakya/SplitCircle/src/components/BillSplit/splitMath.ts:136).

| Rail entry | Actual experience | Monetization treatment |
|---|---|---|
| Receipt | Manual itemized receipt allocation | Eligible local workflow; scanning and parsing must be classified separately |
| Income | Income-weighted allocation | Eligible local workflow |
| Consumed | Consumption-weighted allocation | Eligible local workflow |
| Time | Dynamic and Standard variants | Keep together as one product family; Days and Dates are input styles, not products |
| Roulette | One randomly chosen person pays the whole amount | No credits; monetization hold pending written Apple clarification |
| Double Wheel | Random person/percentage draws continue until 100 percent is allocated | No credits; monetization hold plus fairness testing |
| Karma | Rebalances using historical gross amounts paid | Separate fairness tool; hold until naming, persistence, and math are validated |
| Category | Item-type/category allocation | Eligible local workflow |

Receipt scanning is primarily on-device today: [VisionKit performs OCR](/Users/chanakya/SplitCircle/src/services/visionKitService.ts:107) and [Apple Foundation Models perform structured parsing](/Users/chanakya/SplitCircle/src/services/onDeviceReceiptService.ts:2) on eligible devices. The old per-call cloud parsing path has been removed. Do not describe that as cloud receipt AI or charge cloud credits when the work stayed on the phone. A future server OCR fallback may be separately metered only when it actually runs and the user sees that boundary.

Personal statistics and insights read the user's own history, while the current narrative can invoke deeper model analysis. Reopening history or ordinary charts is not a billable action. Make model generation an explicit Generate or Refresh action before metering it. A future advanced report, comparison, narrative, or export template may be metered when it produces a new premium result. See [PersonalStatsScreen.tsx](/Users/chanakya/SplitCircle/src/screens/stats/PersonalStatsScreen.tsx:61).

Customization settings are also local and cheap. The shipped surface includes theme mode, glass/flat appearance, six accents, app wallpapers, and per-chat overrides. Counting every theme or wallpaper tap would feel absurd. Grandfather everything already shipped, including accessibility-sensitive appearance choices. Monetize only new premium collections, premium saved-look slots, creator collections, or future high-effort assets. See [SettingsScreen.tsx](/Users/chanakya/SplitCircle/src/screens/settings/SettingsScreen.tsx:545) and [WallpaperPickerSheet.tsx](/Users/chanakya/SplitCircle/src/components/ui/WallpaperPickerSheet.tsx:214).

### Correctness gates discovered in the audit

Do not enforce monetization until these are resolved and tested:

- the internal `weightedRoulette` name and visible **Double Wheel** behavior do not describe the same algorithm
- legacy `scrooge` terminology conflicts with the visible **Karma** mode and appears partly dead
- editing and re-saving an advanced receipt can drop tax/tip split metadata produced by the scanner
- advanced split metadata currently carries fields from unrelated modes, including sensitive income and payment-history inputs; persist only the fields required by the chosen mode and prefer normalized income ratios over literal salaries
- Double Wheel uses `Math.random()` even though related wheel code uses cryptographic randomness; define and statistically test one fairness contract before marketing it as fair
- Siri or other headless creation paths could bypass a UI-only quota check, so enforcement must happen at the final operation boundary
- each billable operation needs one stable identifier and one definition of success before counting can be trusted

These are product integrity issues, not merely billing implementation details.

## Revised quota ladder

All figures are test hypotheses. Run non-blocking shadow counters before choosing final numbers. A successful completion consumes an included use. Opening a screen, switching a mode, editing a draft, canceling, or receiving an error does not.

For advanced splits, success means the new expense is successfully saved with that mode, keyed by the expense/request ID. The Bill Split Done action only stages metadata, so counting there would charge abandoned drafts. Edits to an existing expense do not consume another use.

| Feature unit | Free | Essential | Plus | Pro | Power | Max |
|---|---:|---:|---:|---:|---:|---:|
| Eligible advanced split completions | First mode preview, then 3/week pooled | 20/month | 75/month | 250/month | 1,000/month | Unlimited local use |
| New premium saved looks | 0, rotating preview | 3 | 10 | 25 | 100 | Unlimited |
| Premium appearance collections | Rotating preview | 2 | 5 | 10 | All current | All current and future while subscribed |
| Generated advanced local reports | 3/week | 20/month | 75/month | 250/month | 1,000/month | Unlimited local use |
| Expense assistant turns on-device | 3/day | 30/month | 100/month | 400/month | 1,500/month | No routine personal-use limit |
| Provider-backed AI or OCR jobs | 1/week | 5/month | 20/month | 75/month | 250/month | High fair-use allowance, measured later |
| Provider-backed security checks | 3/day | 15/day | 50/day | 200/day | 750/day | High fair-use allowance, measured later |
| Manual provider-backed monitor runs | 1/week | 4/month | 15/month | 50/month | 150/month | High fair-use allowance, measured later |

Notes:

- The advanced-split row excludes Roulette, Double Wheel, and Karma until their product and review status is cleared.
- The first successful preview of each eligible advanced mode does not consume the shared Free pool. This lets a user understand every option before choosing. If testing shows two allowance concepts are confusing, drop the previews and keep a single 3/week pool.
- Paid monthly figures mean a monthly entitlement window, including for annual subscribers. They do not bank or roll over. The active paid allowance replaces the Free pool rather than stacking with it.
- Existing appearance options remain free. Counts apply only to new premium assets or saved premium presets.
- Raw history and ordinary charts remain free. Only generating a new advanced output counts.
- A true Max subscription may say **unlimited** for deterministic local work. Variable-cost or abuse-sensitive cloud work should say exactly what is included, or **no routine personal-use limit** only if ordinary human use is genuinely uncapped.
- Security and anti-automation ceilings remain in every tier. They are safety controls, not hidden commercial quotas.
- Avoid an arbitrary number such as 956/day. Users should be able to understand the allowance and why it exists.

## Subscription design

Create one Apple subscription group, provisionally **ManaSplit All Access**. Monthly and annual products for the same tier sit at the same service level. A customer should hold only one tier at a time.

Price hypotheses for US research, not StoreKit metadata:

| Tier | Monthly | Annual hypothesis | Product role |
|---|---:|---:|---|
| Essential | $2.99 | $24.99 | Contextual rescue offer for light users |
| Plus | $4.99 | $39.99 | Entry plan shown at launch |
| Pro | $8.99 | $69.99 | Recommended plan |
| Power | $14.99 | $119.99 | Contextual offer after verified heavy use |
| Max | $24.99 | $199.99 | Unlimited eligible local tools and the largest cloud allowance |

The app must render localized StoreKit price and billing terms, never hardcoded dollar strings. Annual savings, trials, and introductory offers should be modeled from actual renewal and retention data. Do not create five nearly identical choices on one screen.

### Max and the word unlimited

Max can honestly include unlimited eligible advanced split completions, saved looks, and generated local reports. It should not claim unlimited provider-backed AI, monitoring, hosted media, or other work with ongoing cost unless ordinary personal use is genuinely uncapped. Publish the real included allowance when one exists. Keep a separately disclosed fair-use and abuse policy for automation, attacks, resale, or service degradation.

## Permanent purchases: hold individual mode SKUs

An individual non-consumable for Receipt, Income, Consumed, Time, or Category is technically possible. It is not the recommended launch shape.

Reasons to hold it:

- there is no mode-level demand data yet
- many small products can feel like nickel-and-diming inside a collaborative bill flow
- receipt, time, and category experiences contain submodes that are easy to describe inconsistently
- Apple product IDs cannot be reused after creation
- support, restore, refund, Family Sharing, screenshots, review notes, and regression tests multiply with every SKU
- a one-time unlock must never still demand per-use credits for the same local capability

Use credits during the learning phase because every debit can reveal real repeat demand by feature. After shadow measurement, test coherent one-time packs before isolated modes:

| Later hypothesis | Contents | Research range | Important boundary |
|---|---|---:|---|
| Fair Split Toolkit | Income, Consumed, Time, Category | $14.99 to $19.99 | Local computation only |
| Receipt Builder | Manual itemization and local receipt workflow | $7.99 to $12.99 | Future server OCR not included |
| Complete Advanced Toolkit | Both packs above | $24.99 to $29.99 | Fun modes excluded until cleared |
| Appearance Collection Pass | Newly created premium visual collections | $9.99 to $14.99 | Already shipped appearance stays free |
| Insights Lab | Newly created advanced local reports | $14.99 to $24.99 | Raw history and ordinary charts stay free |

Only create an individual mode product if telemetry shows independent repeat use, interviews show willingness to buy it alone, the name and boundary are stable, and it is materially clearer than a pack. Call it a **Permanent unlock** or **One-time purchase**, not an expansive lifetime promise.

Do not sell overlapping partial and complete packs at the same time unless an ownership-aware upgrade path prevents double payment. StoreKit will not automatically credit someone for a smaller non-consumable they already own. The clean first test is either the two component packs or the complete pack, not all three.

## Mana Credits

### Two balances that must never be blurred

1. **Included uses** come from Free or a subscription. They reset, do not roll over, are not transferable, and are not wallet currency.
2. **Purchased Mana Credits** are consumable in-app purchases. They never expire, survive subscription cancellation, and remain usable without a subscription for every advertised eligible feature.

Optional courtesy or promotional credits form a third, visibly separate lot. Purely promotional credits may have clear expiry terms. A paid pack's bonus units should conservatively be treated as purchased and non-expiring.

### Debit order

For an eligible operation, resolve value in this order:

1. internal testing or support grant, if valid for that environment
2. permanent local entitlement
3. the active plan's included use, either subscription or Free, never both
4. promotional credit lot with the nearest disclosed expiry
5. purchased or gifted non-expiring credit lot, oldest first

Never silently consume purchased credits for the first time. At allowance exhaustion, show the exact cost, current balance, next reset, and alternatives. The user may approve that operation or enable a per-feature **Use Mana Credits automatically** setting. That setting must be easy to turn off.

### Draft credit weights

These are comprehension and cost experiments, not prices:

| Successful result | Draft debit |
|---|---:|
| Eligible advanced local split completion | 1 credit |
| Generated advanced local report | 1 credit |
| Provider-backed link check | 2 credits |
| Provider-backed AI narrative | 3 credits |
| Provider-backed receipt/OCR job | 4 credits |
| Manual provider-backed monitoring run | 10 credits |

Do not debit credits for opening or editing, an on-device fallback, a provider error, a duplicate retry, a canceled operation, or a result the system refuses to show. Do not dynamically change a feature's price mid-flow.

Roulette, Double Wheel, and Karma must not consume purchased credits. Because their randomized output affects a real bill, Apple may view credit-paid access as touching its real-money gaming restriction. Keep them outside the credit economy and obtain written App Review clarification before directly monetizing them.

### Pack hypotheses

| Pack | Price hypothesis | Approximate unit price |
|---|---:|---:|
| 25 credits | $1.99 | 8 cents |
| 80 credits | $4.99 | 6 cents |
| 200 credits | $9.99 | 5 cents |
| 500 credits | $19.99 | 4 cents |

Do not ship these figures until shadow telemetry establishes provider cost and willingness to pay. For each storefront and pack, model:

```text
net proceeds
- provider and Firebase cost at expected feature mix
- refunds and chargeback loss
- support and fraud cost
- outstanding non-expiring credit liability
= contribution margin
```

Use actual App Store financial reports rather than assuming one universal commission or tax rate. Keep user-facing conversion simple and always show both the credit debit and remaining balance.

### Atomic ledger model

Consumables are not restored like permanent purchases. The server must persist them and make every mutation idempotent.

```text
creditLots/{lotId}
  ownerUid, origin, granted, remaining, purchasedByUid
  appleTransactionId, productId, environment
  expiresAt, transferable, status, createdAt

creditLedger/{entryId}
  ownerUid, lotId, operation
  amount, featureId, idempotencyKey, correlationId
  actorUid, relatedGiftId, createdAt

creditReservations/{operationId}
  ownerUid, featureId, amount, sourceLots
  status, expiresAt, providerJobId
```

The operation flow is `authorize -> reserve -> perform -> commit`. Release the reservation on cancellation or failure. A retry with the same idempotency key returns the first decision. Use server time and server-side rules. Separate sandbox and production ledgers completely.

ManaSplit is offline-first, so a strict online check cannot be the only path for zero-cost local modes. Issue a short-lived signed local allowance lease, consume it idempotently on-device, and reconcile later. Never discard or invalidate a financial record that was validly created offline. Provider-backed operations can require connectivity because they cannot run without the provider.

Purchased-credit spending should require connectivity at first so two devices cannot spend the same balance. If offline credit use becomes necessary, escrow only a small signed, device-bound credit lot and reconcile it before issuing another. Never cache the whole wallet as an editable local balance.

## Buying for friends and sharing credits

### Recommended staged decision

- **Launch:** no transfers and no gifting. Prove purchases, refunds, restoration, fraud controls, and account recovery first.
- **Later pilot:** direct **Buy credits for a friend**. The purchaser chooses a named existing friend before StoreKit confirmation; the server grants a dedicated non-expiring gift lot after verification.
- **Hold:** sending from an existing wallet, re-gifting, group trading, resale, marketplaces, withdrawals, or cash-out.

The later gift pilot should require an existing relationship such as mutual friendship or shared group membership, respect blocks, show the recipient and pack twice, use account-age and velocity limits, and prevent the recipient from exchanging or re-gifting the lot. A gifted credit has no cash value, cannot settle an expense, cannot alter a **you owe** balance, and cannot be converted to crypto, gift cards, or physical goods.

Refunds belong to the original purchaser. Preserve lot provenance so a refund can remove the recipient's unused units from that exact gift. If units were already consumed, do not create a financial debt between users or lock the recipient out of the core app. Treat the consumed portion as controlled loss, restrict future sender gifting, and send the case to risk review.

Open wallet-to-wallet transfer is a separate regulated-risk project. Transferability can move a simple in-app consumable toward stored-value and money-transmission questions. It requires specialist legal review, fraud tooling, sanctions/geography analysis, customer support procedures, and written App Review positioning before engineering begins.

Family Sharing is not friend gifting. Apple can share eligible subscriptions and non-consumables, but not consumable credits, and enabling Family Sharing for an App Store product cannot be reversed. Defer it until account-linking and household abuse behavior are designed.

## Access decision flow

For every billable result:

1. authenticate the ManaSplit account and identify sandbox or production
2. check a valid internal-test grant for the current environment
3. check a verified permanent entitlement for that exact local capability
4. select the active plan, subscription or Free, and check its remaining included uses
5. use a signed offline allowance lease when an eligible local operation cannot reach the server
6. offer an explicit credit debit if the feature is credit-eligible
7. otherwise preserve the draft and offer reset time, relevant permanent pack, or subscription

Return a stable decision object such as `allowed`, `source`, `remaining`, `resetsAt`, `creditCost`, `creditBalance`, `reservationId`, and `reasonCode`. The client may cache a signed snapshot for interface continuity, but the backend or final local-operation boundary remains authoritative. Never grant access from a client-supplied plan, local storage flag, email comparison, or UI-only check.

## Purchase and entitlement architecture

### Client responsibilities

- fetch StoreKit products and localized prices
- show exact benefits, limits, duration, renewal, and permanent/cloud boundaries
- purchase, observe transaction updates, and provide **Restore Purchases** and **Manage Subscription**
- show separate included-use and purchased-credit balances
- show provisional success only until server verification completes
- preserve drafts through paywalls and purchase interruptions

### Server responsibilities

- assign each account a stable UUID `appAccountToken`, not a raw Firebase UID
- verify signed StoreKit transactions and subscription states
- process App Store Server Notifications V2 idempotently
- project server-owned subscription, permanent entitlement, and credit state
- handle renewals, grace, retry, upgrade, downgrade, cancellation, expiration, refund, revocation, and refund reversal
- respond to consumption requests only with valid user consent and within Apple's time window
- reconcile duplicate, delayed, and out-of-order notifications
- keep purchased access after reinstall, device change, and subscription cancellation where applicable

Suggested server-owned records:

```text
billingCustomers/{uid}
billingTransactions/{transactionId}
entitlementSnapshots/{uid}
usageWindows/{uid_feature_window}
creditLots/{lotId}
creditLedger/{entryId}
giftIntents/{giftId}
billingAudit/{eventId}
```

No client may directly write entitlement, usage, gift, or credit records.

## Owner testing and App Review access

Use three separate mechanisms:

1. **Xcode StoreKit testing** for local purchase, renewal, refund, failure, interruption, and expiration scenarios before products exist.
2. **Apple Sandbox and TestFlight** for end-to-end Apple infrastructure. TestFlight transactions use the sandbox and do not charge testers.
3. **ManaSplit internal-test access** for repeatedly exercising feature paths without commercial limits.

Internal access should be a server-issued role or short-lived grant tied to an exact owner UID, visible through an **Internal Test Access** badge, isolated by environment, and audited. It must not be an email comparison, magic password, client flag, or fake StoreKit purchase. Re-authentication or Firebase token refresh is required after role changes. Remote support calls must not let an administrator change their own test access; owner and administrator self-access changes use the audited local `npm run internal-test:access` operator command.

This access prevents commercial quotas and purchase prompts, but it does not make LiveKit, Firebase, or third-party calls free to the developer. Use deterministic fixtures, Xcode StoreKit testing, local models, and provider sandboxes for unlimited repetition. Retain a hard provider-safety budget and visible execution route even for the owner account.

The owner account should default to sandbox data. Production bypass, if ever needed, should be time-limited, reason-bound, strongly authenticated, and visually unmistakable. App Review receives a separate working reviewer account or approved demo path with exact navigation and all backend services live.

## Customer support and admin console

Build a separate web console behind MFA and an identity-aware access proxy. Do not hide admin powers in the consumer app.

| Role | Allowed capability |
|---|---|
| Support viewer | Exact-user lookup, app/device versions, sanitized provider status, entitlements, usage, and credit balances |
| Support agent | Entitlement refresh, verification resend, short courtesy use grant, stuck reservation release, documented quota correction |
| Billing specialist | Transaction, refund, gift, and credit-lot reconciliation; no arbitrary balance editing |
| Risk specialist | Gift velocity review, device/account linkage, abuse holds, and appeal notes |
| Owner | Staff roles, internal-test allowlist, policy configuration, and emergency kill switches |

Every mutation requires a reason and optional ticket, shows a before/after preview, has a narrow target, and writes an append-only audit event with actor, action, target, time, environment, and correlation ID. High-risk credit adjustments require two-person approval above a configured threshold.

Useful views:

- customer summary and consented diagnostic bundle
- subscription and permanent entitlement timeline
- included-use windows and recent denial reasons
- purchased, promotional, and gifted credit lots with provenance
- reservation, commit, release, refund, and reversal history
- gift sender/recipient timeline with privacy-aware risk signals
- provider health without message, call, receipt, or monitored-identity content
- configuration history and emergency pause controls

Never expose message content, call content, encryption keys, backup contents, unrestricted database browsing, full payment credentials, monitored identity plaintext, or an impersonation feature.

## User experience rules

- Deliver the last included successful result before showing the exhaustion paywall.
- Explain what resets, when it resets in local time, and what never expires.
- At exhaustion, offer **Wait for reset**, **Use N Mana Credits**, the relevant permanent pack if one exists, and **See plans**.
- Show one recommended plan and at most two immediate alternatives. Put the full matrix behind comparison.
- Never preselect a purchase, hide the close control, use fake urgency, or obscure renewal price.
- Never make a subscriber buy credits for a local feature that their tier labels as unlimited.
- Label a permanent product's local boundary before purchase.
- Provide purchase history, Restore Purchases, Manage Subscription, credit balance, and plain-language help.
- Apply Dynamic Type, VoiceOver, reduced motion, clear focus order, and accessible touch targets.

## Account deletion, refunds, and recovery

Before deleting an account, explain how to manage an active Apple subscription and what happens to purchased credit records. Apple billing is not canceled merely by deleting a ManaSplit account.

Purchased credits create a tension between privacy deletion and durable purchase fulfillment. Before launch, obtain a written retention policy covering the minimum transaction/ledger tombstones needed for fraud, refund, tax, and recovery obligations. Do not promise cross-account reattachment until identity proof and abuse consequences are designed.

Support adjustments must be additive ledger entries, never silent history edits. A refund, revocation, or reversal targets the exact transaction and derived lot. Permanent entitlements follow verified StoreKit revocation state.

## Metrics and experiments

Collect product events without expense amounts, participant names, messages, receipt contents, monitored identities, or other financial/social content:

- eligible mode selected, completed, abandoned, or failed
- included-use balance viewed, 80 percent used, and exhausted
- credit offer viewed, approved, declined, committed, or released
- paywall source, product selected, purchase outcome, restore outcome
- subscription upgrade, downgrade, cancellation state, and retained usage
- permanent-pack attach rate and mode usage after purchase
- refund, gift, courtesy grant, and support contact rates
- provider cost and latency by coarse feature class

Key decision metrics include free-to-repeat use, exhaustion-to-return, exhaustion-to-credit, exhaustion-to-subscription, subscriber credit top-up rate, contribution margin by feature mix, entitlement error rate, and customer support contacts per 1,000 transactions.

## Rollout plan

### Phase 0: product integrity

- fix and test the advanced-mode naming, algorithms, metadata round-trip, data minimization, randomness, offline leases, and headless entry points
- define one success event for every potentially billable operation
- classify each operation as local, Apple on-device/PCC, or third-party/provider backed
- add sum-to-total, cent rounding, malformed input, rehydration, roster change, receipt tax/tip preservation, and randomness tests

### Phase 1: shadow measurement (completed for the foundation)

- add privacy-preserving counters with no blocking or paywall
- measure at least four weeks, including weekly and monthly behavior
- calculate provider cost distributions and simulate each proposed tier
- interview users at natural exhaustion points with a non-purchase survey

### Phase 2: purchase foundation (implemented and deployed)

- implement StoreKit testing, server verification, restore/sync, notifications, and credit ledger
- keep new feature families unenforced while testing purchase, cancellation, refund, reinstall, new device, duplicates, outages, and account deletion; Advanced Split completion is the bounded first enforced workflow
- run a separate sandbox/prod ledger reconciliation suite

### Phase 3: smallest commercial launch

- launch Plus, Pro, and Max with exact limits
- launch two small credit packs only after cost modeling
- gate one low-risk, clearly defined accelerator
- do not launch gifting, transfers, Family Sharing, Fun-mode monetization, or individual mode products

### Phase 4: evidence-based expansion

- consider permanent bundles after mode-level repeat-use data
- pilot direct purchase-for-friend only after refund and fraud controls work
- surface Essential or Power only if observed cohorts need them
- consider individual mode unlocks only if they beat bundles in clarity and demand

Rollback or pause if entitlement verification errors exceed 0.5 percent, p95 access propagation exceeds 30 seconds, credit double-debits occur at all, refund reconciliation cannot identify the originating lot, or support contacts spike materially.

## Decisions deliberately held

1. **Individual advanced-mode permanent sales:** hold until usage and interview evidence exists.
2. **Fun-mode monetization:** hold until behavior is corrected and Apple gives written classification guidance.
3. **Wallet-to-wallet transfer:** hold pending legal, fraud, and store-policy review.
4. **Direct friend gifts:** design later, after ordinary consumables are stable.
5. **Family Sharing:** defer because consumables are excluded and enabling it for a product is irreversible.
6. **Final credit weights, pack prices, quotas, and tier prices:** shadow-test before App Store metadata.
7. **Cloud unlimited claims:** do not make them unless the service truly has no routine personal-use cap.
8. **Build versus purchase platform:** decide after comparing StoreKit/App Store Server implementation cost with a vendor's fees, lock-in, privacy, and multi-platform value.

## Apple and regulatory checklist

- use In-App Purchase for digital unlocks, subscriptions, and consumable credits in the iOS app unless a specific storefront entitlement clearly applies
- never expire purchased or paid-gift credits
- keep gifts non-exchangeable and refunds payable only to the original purchaser
- keep Feature Credits separate from real debt, cash, prizes, and wagering
- use StoreKit localized pricing and clear recurring terms
- provide Restore Purchases for restorable items and persist consumables on the server
- configure and test App Store Server Notifications and refund/consumption flows
- describe non-obvious quota, gift, credit, and randomized split behavior in App Review notes
- complete specialist legal review before any transferable stored-value design
- repeat this policy review immediately before implementation and submission because storefront rules change

## Primary sources

- [Apple App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/)
- [Apple in-app purchase product types](https://developer.apple.com/help/app-store-connect/reference/in-app-purchases-and-subscriptions/in-app-purchase-types/)
- [Apple subscription groups, levels, and durations](https://developer.apple.com/help/app-store-connect/manage-subscriptions/offer-auto-renewable-subscriptions/)
- [Apple Human Interface Guidelines for in-app purchase](https://developer.apple.com/design/human-interface-guidelines/in-app-purchase)
- [Apple StoreKit purchase persistence](https://developer.apple.com/documentation/storekit/persisting-a-purchase)
- [Apple App Store Server Notifications](https://developer.apple.com/documentation/appstoreservernotifications)
- [Apple appAccountToken](https://developer.apple.com/documentation/storekit/transaction/appaccounttoken)
- [Apple Family Sharing for in-app purchases](https://developer.apple.com/help/app-store-connect/configure-in-app-purchase-settings/turn-on-family-sharing-for-in-app-purchases)
- [Apple TestFlight purchase testing](https://developer.apple.com/help/app-store-connect/test-a-beta-version/testing-subscriptions-and-in-app-purchases-in-testflight)
- [FinCEN prepaid access guidance](https://www.fincen.gov/resources/statutes-regulations/guidance/frequently-asked-questions-regarding-prepaid-access)
- [FTC dark pattern report](https://www.ftc.gov/reports/bringing-dark-patterns-light)

The commercial backend and bounded Advanced Split enforcement are live. App Store Connect contains the subscription and consumable-credit catalog, and the release client contains checkout. Customer availability still depends on Apple processing and release approval; real StoreKit sandbox purchase, restore, renewal, refund, reinstall, and multi-device scenarios remain release acceptance gates. Permanent entitlements, gifting, transfers, Family Sharing, randomized-mode monetization, and additional enforced feature families remain closed by design.
