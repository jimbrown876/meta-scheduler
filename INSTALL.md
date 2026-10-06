# Installation for this fork

Use a reviewed checkout of `jimbrown876/meta-scheduler` on a dedicated task branch. Preserve existing checkouts, account files, browser profiles and state. The previous one-line installer is intentionally disabled.

Run `npm ci --ignore-scripts`, install the test browser with `npx playwright install chromium`, then run `npm test`. On Linux CI, `npx playwright install --with-deps chromium` supplies browser dependencies. A local fixture run can use an already installed browser executable through `META_TEST_BROWSER`; it launches a fresh temporary profile, never the user's browser profile.

See README.md for the worker configuration and live-verification limitations. Do not invoke `--setup` or enable live publishing until access and the destination are verified. The current adapter uses the effective public CRM catalog and the observed Meta Business Suite Page composer. Do not store credentials, cookies, account state or private inventory snapshots in Git.

Desktop dependencies are pinned in the lockfile: Playwright MCP 0.0.83 and MCP SDK 1.32.0. The MCP package includes its own pinned browser protocol implementation; the isolated fixture uses the installed test Chromium executable. macOS needs its system `/usr/bin/lockf`; Linux needs `/usr/bin/flock`. No native npm build or browser-profile export is needed.

On macOS, startup applies an exact SHA-256-guarded correction to this release's pinned MCP bridge: its local `Browser.getVersion` response identifies the Mac platform so Playwright sends the proper editing commands. This does not change Chrome's web-facing user agent or permissions. An unfamiliar dependency build fails closed with `DESKTOP_BRIDGE_VERSION_CHANGED`; dependency upgrades must revalidate or remove the correction. Only the release's own installed package is modified, and applying the correction twice is safe.

Install the reviewed immutable release on the Mac and VPS, export and checksum the existing GWT n8n workflow before replacing it, then validate and test the queue-only workflow. Keep the desktop config disabled until the official extension has been approved, connected to the verified Chrome profile and tested against the exact Page. The queue and fixture tests do not substitute for the live canary. Configure the LaunchAgent with absolute paths under the signed-in user's GUI session; it resumes on login but cannot run while the computer is powered off.
