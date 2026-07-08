# Shipping SplitCircle to iOS (one command)

`scripts/ship-ios.sh` replaces the manual **"`eas build …` → drag the .ipa into
Transporter → Deliver"** flow with a single headless command. It builds the app
locally and uploads it to App Store Connect (the same delivery Transporter does,
via `eas submit`, no GUI).

## Usage

```bash
npm run ship:ios         # build (local, production) + deliver to App Store Connect
npm run ship:ios:full    # ALSO deploy Firebase functions + Firestore rules first
npm run build:ios:local  # build the .ipa only, no upload
```

Under the hood (`scripts/ship-ios.sh`):

1. *(only with `--full`)* `firebase deploy --only functions,firestore:rules`
2. `eas build -p ios --local --profile production` → a timestamped `.ipa` in `build-output/`
3. `eas submit -p ios --path <that .ipa>` → App Store Connect → TestFlight after Apple processes it

Every build is kept in `build-output/` (git-ignored). Flags: `--profile <name>`,
`--build-only`, `--full`, `--help`.

## One-time credential setup (required once, then fully automatic)

`eas submit` needs an **App Store Connect API key** so it can upload without a
password. Set it up once and EAS stores it on their servers — nothing secret
ever lands in this repo.

Option A — let EAS create & store the key (simplest):

```bash
eas credentials        # → iOS → (production) → App Store Connect API Key → Set up a new key
```

Option B — you already have an API key `.p8` (App Store Connect → Users and
Access → Integrations → App Store Connect API):

```bash
eas credentials        # → iOS → App Store Connect API Key → Use an existing key → paste Key ID / Issuer ID / .p8
```

After either, `npm run ship:ios` runs end-to-end non-interactively.

> If you'd rather keep the key in the repo dir instead of on EAS, drop it in
> `credentials/` (git-ignored) and set `ascApiKeyPath` / `ascApiKeyId` /
> `ascApiKeyIssuerId` under `submit.production.ios` in `eas.json`.

## Native one-liner alternative

EAS can also submit automatically right after a build:

```bash
eas build -p ios --local --auto-submit-with-profile production
```

The wrapper script is preferred because it archives each `.ipa`, can deploy the
backend in the same step, and gives clearer logging — but this one-liner uses
the same credentials and works too.

## Notes

- **Build number** auto-increments (`eas.json` production profile has
  `autoIncrement: true`), so every ship gets a fresh build for App Store Connect.
- The build compiles all native modules, so native features (Face ID, screenshot
  shield, ringback audio, sensors/shake guard) are live in every shipped build.
- Disk: a local iOS archive needs ~12 GB free; `scripts/eas-local-preflight.sh`
  guards this and purges stale DerivedData before each build.
