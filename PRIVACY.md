# Privacy Policy

Effective date: 2026-10-22

ChatGPT Account Keeper is a local desktop application. The project maintainer does not operate a telemetry, analytics, account, or synchronization service for the application and does not receive your application data.

## Data stored locally

Depending on the features you use, the application stores account labels and identifiers, Chrome Profile data (including cookies and web storage), conversation-set instructions, generated conversation history, schedules, proxy configuration and credentials, operation history, settings, backups, and redacted diagnostic logs. These files remain in the data directories documented in `README.md` until you delete them or remove the relevant Profile/data directory.

Chrome Profile data and proxy credentials are sensitive. Do not publish, share, or attach them to issue reports. Diagnostic logs are designed to redact common secrets, but you should still inspect logs before sharing them.

If you use iCloud Hide My Email, the application also stores the synchronized addresses, cloud labels and notes, local notes, usage flags, a hashed account identifier, creation scheduling records, and uncertain creation results locally. Apple login cookies remain in a dedicated Chrome Profile; the application does not ask for your Apple password or copy login cookies into its database.

## Network connections

The application makes network connections only to provide requested local features:

- Google Chrome connects to ChatGPT/OpenAI authentication and web endpoints when you log in, open a page, run a check, or enable scheduled work. Page content, prompts, outputs, cookies, IP addresses, and ordinary browser metadata are then processed under the destination service's privacy policy.
- When you open or synchronize iCloud Hide My Email, create an address, or enable continuous creation, the dedicated Chrome Profile connects to Apple's iCloud website and authentication services. Fixed labels and cloud notes are submitted to Apple when an address is created. Local notes and usage flags remain in this application.
- Traffic may pass through proxy servers that you configure. Their operators can observe metadata and, depending on protocol and destination encryption, other traffic.
- When a proxy-backed group has no manually configured region, the Agent queries `ip-api.com` through that proxy to derive the proxy exit's country and time zone. The service sees the proxy exit IP, not a maintainer-controlled identifier.
- An explicit proxy latency test requests Google's `generate_204` endpoint through the selected proxy.
- Installed builds check the public GitHub Releases feed after startup and periodically thereafter. Depending on your update setting, they may also download a release package from GitHub.

The application does not send this local data to the project maintainer. It does not sell personal data and contains no advertising or analytics SDK.

## Control and deletion

You can stop scheduling, remove accounts, delete or archive Profiles, clear reconstructible caches, delete history, remove proxy credentials, and uninstall the application. Uninstalling the executable may intentionally leave the user data directory in place so an upgrade or reinstall cannot silently destroy Profile data; delete that directory separately if you want to erase it.

For a complete offline copy, this policy is included in each release package under `licenses/PRIVACY.md`.
