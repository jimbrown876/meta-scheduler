# Installation for this fork

Use a reviewed checkout of `jimbrown876/meta-scheduler` on a dedicated task branch. Preserve existing checkouts, account files, browser profiles and state. The previous one-line installer is intentionally disabled.

Run `npm ci --ignore-scripts`, install the test browser with `npx playwright install chromium`, then run `npm test`. On Linux CI, `npx playwright install --with-deps chromium` supplies browser dependencies. A local fixture run can use an already installed browser executable through `META_TEST_BROWSER`; it launches a fresh temporary profile, never the user's browser profile.

See README.md for the exact limitations and input contracts. Do not invoke `--setup` or enable live publishing until access and the destination are verified. No live CRM/Meta lifecycle adapter is provided by this version. Do not store credentials, cookies, account state or private inventory snapshots in Git.
