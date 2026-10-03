# App Privacy answers for version 1.0.0

Answer **Yes, we collect data from this app**. In Apple's terminology, data sent off the device for app functionality can count as collected even when it is encrypted, transient, or not used for advertising.

ManaSplit does not track users across other companies' apps or websites. No listed data is used for third-party advertising, developer advertising, or advertising measurement.

| Apple data type | Collected | Linked to user | Primary purpose | Notes |
|---|---:|---:|---|---|
| Contact Info: Name | Yes | Yes | App Functionality | Account profile and member identity |
| Contact Info: Email Address | Yes | Yes | App Functionality | Authentication, account recovery, and security monitoring when enrolled |
| Financial Info: Other Financial Info | Yes | Yes | App Functionality | Shared expenses, balances, settlements, budgets, and receipt totals |
| Location: Precise Location | Yes, when shared | Yes | App Functionality | User-selected chat location and nearby-place lookup |
| User Content: Emails or Text Messages | Yes | Yes | App Functionality | Encrypted or protected message transit; history is local-first |
| User Content: Photos or Videos | Yes, when shared | Yes | App Functionality | Chat media, group imagery, and receipt attachments |
| User Content: Audio Data | Yes, when shared | Yes | App Functionality | Voice messages and live call media |
| User Content: Other User Content | Yes | Yes | App Functionality | Groups, files, expense notes, call signaling, and security submissions |
| Search History | Yes, when used | Yes | App Functionality | Place search and submitted URL-security checks |
| Identifiers: User ID | Yes | Yes | App Functionality | Firebase account and group membership |
| Identifiers: Device ID | Yes | Yes | App Functionality | Push tokens, paired-device identity, and message delivery |
| Purchases: Purchase History | Yes | Yes | App Functionality | App Store transactions, subscription entitlements, restoration, refunds, and Mana Credit ledger |
| Usage Data: Product Interaction | Yes | Yes | App Functionality | Server-owned Advanced Split usage, quota reservations, and completion records |

Do not select Contacts unless a later build reads the device address book. The reviewed source does not import an address-book API. Do not select Payment Info because ManaSplit does not receive card or bank credentials. Purchase History and Product Interaction now apply because commerce transactions and eligible-operation usage are stored by the backend. Neither is used for advertising or tracking. Do not select Advertising Data or diagnostics unless telemetry or crash reporting is enabled outside the reviewed source.

Third-party and infrastructure practices included in these answers must cover Firebase services, Apple Push Notification service, LiveKit call transport, Google Places or Maps where used, Google Web Risk, and the configured security-monitoring providers.

Privacy Policy URL: https://manasplit.pages.dev/privacy/

Privacy Choices URL: https://manasplit.pages.dev/delete-account/
