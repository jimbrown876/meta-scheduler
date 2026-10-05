# Georgia Wood Tools scheduler fork

Fork of [Antonio Automates' meta-scheduler](https://github.com/arillera/meta-scheduler), retaining its MIT license and attribution. This branch hardens the scheduler and adds an offline inventory synchronization core for Georgia Wood Tools.

**Desktop Chrome is the selected publishing path. Live publishing stays disabled until the browser connection and live canary are verified.** VPS-only Facebook login is deferred: code delivery failed there while the existing Mac session worked; the underlying cause has not been established. The worker uses the effective CRM catalog and the Meta Business Suite Page composer. Synthetic browser tests do not prove live Facebook posting.

## Desktop schedule and recovery

n8n retains one durable reconciliation request on the VPS every 15 minutes. A Mac LaunchAgent checks once a minute through the existing private SSH connection. Failed connections wait 1, 5, 15, then 60 minutes between attempts, continuing hourly without expiring pending work. New schedule ticks do not reset that backoff. Sleep, shutdown and Wi-Fi loss delay publication; after the Mac is awake, logged in and connected, it resumes pending work with the latest catalog. It does not replay obsolete available listings that have since sold.

The official Playwright extension connects to the selected, already signed-in Chrome profile. The worker opens and closes its own tab; it does not copy cookies, launch Chrome against the default profile directory, close user tabs, enter passwords or solve challenges. Installation and the persistent connection grant require the user's approval. Keep the extension connection token in a private file on the Mac, outside Git. See the [official extension documentation](https://github.com/microsoft/playwright/blob/main/packages/extension/README.md).

```json
{
  "tenantId": "01M41C0XR04Y9DXGAJ9Q52C1E1",
  "stateDirectory": "/Users/USER/Library/Application Support/Georgia Wood Tools Publisher/state",
  "browserMode": "extension",
  "chromeProfileDirectory": "Default",
  "extensionTokenFile": "/Users/USER/Library/Application Support/Georgia Wood Tools Publisher/extension-token",
  "queueRelease": "VERIFIED_40_CHARACTER_RELEASE_SHA",
  "workerId": "gwt-desktop-mac",
  "liveEnabled": false
}
```

Replace the profile name with its verified `Default` or `Profile N` value. State directories must be 0700; configuration and the token file must be 0600. Use an immutable release directory and an absolute Node executable in the generated LaunchAgent. `lib/desktop-launchagent.js` creates its plist; `lib/n8n-desktop-workflow.js` generates the replacement for the existing GWT publisher workflow. The n8n manual branch reads queue status; only the 15-minute clock enqueues work. It cannot itself publish to Facebook.

```sh
node lib/desktop-runner.js queue --config /absolute/private/config.json
node lib/desktop-runner.js status --config /absolute/private/config.json
node lib/desktop-runner.js tick --config /absolute/private/config.json
node lib/n8n-desktop-workflow.js VERIFIED_40_CHARACTER_RELEASE_SHA
```

Each run is limited to three writes, prioritizing changes to existing posts. Partial batches remain queued. A lease is checked just before Publish; another worker cannot claim an unexpired lease. The private journal distinguishes preparation from submission, retains verified post identities, and survives restarts. A lost server acknowledgement is retried without posting again. After an uncertain submission, the worker only reads back the exact caption, Page owner and post identity before accepting completion. Delayed readback retries and alerts once after three failures; contradictory results, login, challenges and restrictions pause work for attention. No uncertainty is resolved by another Publish click.

Mac `lockf` and Linux `flock` hold OS advisory locks on permanent private files. A pipe-bound holder releases ownership if its parent crashes; the files themselves are never deleted to force recovery. Fixture tests cover a killed owner, concurrent exclusion, queue backoff, lost acknowledgements, interrupted preparation, sold catch-up and the pinned MCP init-page bridge.

Before activation, reconcile any existing posts for the same machine links, verify the exact Page, then run a scoped live canary and a normal scheduled cycle. A queue-only schedule may be enabled while the Mac publisher stays disabled; this proves retention, not Facebook publishing. Rollback: disable the Mac configuration, unload its named LaunchAgent and deactivate the GWT desktop n8n workflow. Preserve the queue, token and publication journal for recovery. Do not change the independent Marketplace scraper.

The one-time `desktop-runner.js canary --config /absolute/private/config.json` command requires a separately approved `canaryEnabled: true` while general `liveEnabled` remains false. It is pinned to the existing labelled GWT test post and its machine, verifies ownership, edits that same post through two test captions and a clearly labelled simulated sold status, and verifies a repeat makes zero writes. Its separate journal prevents simulated status from entering the CRM or the production sold latch. It then adopts the verified post once and restores fresh real CRM copy. It cannot overwrite another production receipt, create a different test post, or run as part of the scheduled queue. Afterward, remove the canary opt-in and separately verify a bounded ordinary creation batch and a normal scheduled cycle before general activation. A canary failure retains its journal for reconciliation; never delete the journal to retry.

## What changed

- A dry run validates local input without opening a browser, publishing or recording completion.
- Stable job IDs bind Page identity, content, media, schedule and timezone. Changed completed jobs cannot silently become duplicates.
- An atomic private journal records intent before the Schedule click. A missing or ambiguous receipt stops retries and requires reconciliation.
- Publishing requires one exact configured Facebook destination. Other Facebook and Instagram selections are cleared and verified. Restrictions, sign-in redirects and challenges stop execution.
- Calendar rollover and ambiguous/nonexistent DST times are rejected. The account timezone controls input interpretation.
- The inventory core creates direct machine links ending in `#inquire`, updates the same post after a change, marks sold/reserved in its caption, and deletes only on an explicit removal instruction.
- Missing listings never imply deletion. Operator holds and newer revisions block stale work. A sold latch survives hiding/deleting until an explicit reopen.
- The installer no longer changes another checkout, installs a skill, removes locks or initiates account setup automatically.

The remaining legacy image composer helpers come from upstream and have not been verified against the current live Meta UI. Reels and Instagram are disabled in this fork. The new Page adapter reads back the published caption, Page owner and canonical permalink from the post's Business Suite insights. A URL parameter alone is not evidence of post ownership.

GWT posts require an explicit link preview with the machine photograph and its direct website inquiry URL. The adapter attaches that preview in the composer and confirms the image has loaded before clicking Publish. It independently verifies the saved image and destination afterward. Missing images stop the batch; a text-only post cannot be recorded as complete. Existing receipts without image proof are repaired on the same post, even when the CRM revision has not changed. Sold edits retain the same image card and post identity.

## Deferred VPS browser worker

Run the worker as the existing `jim` service user, with a private JSON config at `/etc/georgia-wood-tools/publisher.json`:

```json
{
  "tenantId": "01M41C0XR04Y9DXGAJ9Q52C1E1",
  "stateDirectory": "/var/lib/georgia-wood-tools-publisher",
  "browserExecutable": "/home/jim/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome",
  "liveEnabled": false
}
```

Verify the installed executable path before deploying; it is not portable. The config must be mode 0600. The state directory and its existing `browser-profile` subdirectory must be owned by the running user and mode 0700. This publisher profile is separate from the Alton Marketplace scraper profile. The code pins the GWT tenant, Page and website identities; it never imports personal browser cookies or automates password/verification entry.

```sh
node lib/publisher-cli.js plan --config /etc/georgia-wood-tools/publisher.json
node lib/publisher-cli.js status --config /etc/georgia-wood-tools/publisher.json
node lib/publisher-cli.js sync --config /etc/georgia-wood-tools/publisher.json
node lib/n8n-workflow.js VERIFIED_40_CHARACTER_RELEASE_SHA
```

`plan` reads the public catalog and exact sitemap URLs without opening a browser or recording completion. `status` checks the existing VPS session and exact Page destination without posting. `sync` also requires `liveEnabled: true`. Each run prioritizes updates and processes at most three writes; remaining work is read again next run, with no monthly quota. Confirmed posts retain their identity when captions/prices/status change. Before each publish, the worker verifies the machine page's canonical URL and inquiry form, refreshes the effective CRM revision, persists intent, clicks once, and checks the published result.

The generated n8n workflow uses the existing `VPS Host (n8n-to-host)` SSH credential. Its manual branch checks the OS user, catalog plan and Facebook session. Its separate schedule branch runs every 15 minutes after activation; errors route to the existing GWT error workflow. Validate the generated code before import, verify the actual credential assignment and remove any pinned data before a real execution. Keep the workflow inactive until live tests pass. No scheduler subscription or developer app is required by this browser implementation, but Facebook login and account controls still apply.

The public catalog exposes available/reserved/sold inventory. It excludes hidden/removed records and does not expose the CRM's private distribution controls. Missing previously published items are reported as `missingPublished` for review; they are never assumed sold. Existing sold items without a known post are held. A sold item cannot automatically reopen without an explicit reconciled instruction. Permanent deletion is deliberately unsupported by this adapter. Uncertain operations stay in the private journal and require receipt reconciliation; never clear locks/history to force a retry. First-run duplicate discovery uses the current Business Suite published-post search window, so inventory predating that window requires an explicit baseline reconciliation before activation.

Deploy only a reviewed immutable commit into its own release directory, with `liveEnabled: false`. Verify the real n8n service user, plan and status, then a scoped live create/edit/sold canary and a normal clock-triggered run before general activation. Rollback is to deactivate this workflow and restore the previously verified release command/config; retain the browser profile and journal. A failed login check is a blocker, not a successful no-change sync.

## Local tests

See [INSTALL.md](INSTALL.md). Use Node 22 or newer:

```sh
npm ci --ignore-scripts
npx playwright install chromium
npm test
```

Tests cover dry runs, invalid snapshots, exact destination selection, post receipts, duplicate prevention, changed content, create/update/reserve/sell/delete/reopen, stale revisions, retained holds, corrupt state, concurrent locks, interrupted writes and reconciliation. Browser fixtures intercept all page requests and never use a signed-in profile.

## Offline inventory plan

```sh
node inventory-sync.js --snapshot effective-crm-snapshot.json --tenant VERIFIED_TENANT_ID
```

The CLI only plans; it cannot publish. `lib/gwt-config.js` records the public Georgia Wood Tools destination and defaults `liveEnabled` to false. Its Page asset ID must be reverified before any activation.

Snapshot input is an **adapter contract**, not the current CRM API response format:

```json
{
  "version": 1,
  "source": "crm",
  "tenantId": "VERIFIED_TENANT_ID",
  "items": [{
    "id": "machine_123",
    "revision": 1,
    "status": "available",
    "title": "Example machine",
    "description": "Effective, operator-approved machine details",
    "price": "$1,000",
    "url": "https://georgiawoodtools.com/equipment/machine_123/example-machine"
  }]
}
```

Revisions must increase whenever effective content, status or controls change. A future CRM adapter must establish this monotonic ordering; it cannot reinterpret a hash as an ordered revision. IDs, titles, prices and URLs must come from the effective CRM record, including operator overrides. Supported statuses: available, reserved, sold, hidden, removed, draft. Controls: `hold`, `suppressed`, `removeFromFacebook`, `saleReopened` (booleans). Absence from a snapshot is not a deletion instruction.

An enabled adapter implements `verifyDestination(url, id)`, `create(operation)`, `update(operation)` and `delete(operation)`. Each mutation must return independently verified `pageId`, `postId`, canonical `url`, `verified: true`, exact `action`, `operationId` and `contentHash`. Updates/deletions must preserve the original post identity. Persisted uncertain operations are reconciled with `reconcileReceipt`; they are never blindly retried. State files must survive restarts, remain private and be backed up. Do not delete them to get past an error.

## Legacy image scheduling interface

Copy `accounts/example.json` to a private ignored account file and replace every fixture value with verified values. The example is disabled. Required fields include exact Page ID, Page name, Facebook-only platform list, timezone, composer URL, destination group/checkbox labels and success text/link labels. These labels are fixture examples, not a claim about Meta's current UI.

```sh
node schedule-post.js --account example --images /path/to/images --caption /path/to/caption.txt --caption-start-line 1 --datetime "2026-10-10 09:00" --dry-run
node batch-schedule.js --account example --plan plan.json --dry-run
```

Batch plans are arrays with unique `id`, `datetime`, and either `day` or `images` plus `caption`; `captionStartLine` is optional. The CLI automatically resumes confirmed identical work. Range generation, unbounded retries and implicit cross-posting are removed. Existing upstream batch state is rejected for explicit reconciliation rather than migrated into an assumed success.

## Activation still required

Before Facebook activation, verify the selected desktop connection to this exact Page, a scoped canary create/edit/sold sequence and a scheduled run. Deletion remains a separate manual action; the adapter fails closed. Never change accounts, copy browser cookies, remove another process's locks or bypass verification/restrictions to make a test pass. Keep live mode off until these requirements are met.
