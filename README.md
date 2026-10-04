# Georgia Wood Tools scheduler fork

Fork of [Antonio Automates' meta-scheduler](https://github.com/arillera/meta-scheduler), retaining its MIT license and attribution. This branch hardens the scheduler and adds an offline inventory synchronization core for Georgia Wood Tools.

**Live Georgia Wood Tools publishing is disabled.** The lifecycle tests use a fake publishing adapter and the browser tests serve synthetic HTML. This is not proof of working Facebook automation. No live CRM reader or Facebook create/edit/delete adapter is bundled. Do not activate this as a workaround for an account restriction or claim it is connected to the CRM.

## What changed

- A dry run validates local input without opening a browser, publishing or recording completion.
- Stable job IDs bind Page identity, content, media, schedule and timezone. Changed completed jobs cannot silently become duplicates.
- An atomic private journal records intent before the Schedule click. A missing or ambiguous receipt stops retries and requires reconciliation.
- Publishing requires one exact configured Facebook destination. Other Facebook and Instagram selections are cleared and verified. Restrictions, sign-in redirects and challenges stop execution.
- Calendar rollover and ambiguous/nonexistent DST times are rejected. The account timezone controls input interpretation.
- The inventory core creates direct machine links ending in `#inquire`, updates the same post after a change, marks sold/reserved in its caption, and deletes only on an explicit removal instruction.
- Missing listings never imply deletion. Operator holds and newer revisions block stale work. A sold latch survives hiding/deleting until an explicit reopen.
- The installer no longer changes another checkout, installs a skill, removes locks or initiates account setup automatically.

The remaining image composer helpers come from upstream and have not been verified against the current live Meta UI. Reels and Instagram are disabled in this fork. A receipt validator checks configured Page identity and canonical post URLs; a production adapter must additionally read back the real owner, status, content and destination from Meta. A URL parameter alone is not evidence of post ownership.

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

Before a live integration, verify permitted access to this exact Page; implement a scoped effective-CRM snapshot adapter and a read-back-verified Meta lifecycle adapter; verify each machine page and inquiry form; then perform an explicitly authorized canary create/edit/sold/remove sequence and verify a scheduled run. Never change accounts, copy browser cookies, remove another process's locks or bypass verification/restrictions to make a test pass. Keep live mode off until these requirements are met.
