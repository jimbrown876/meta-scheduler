#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { gwtConfig } from './lib/gwt-config.js';
import { syncInventory } from './lib/inventory.js';

const { values } = parseArgs({ options: { snapshot: { type: 'string' }, tenant: { type: 'string' }, state: { type: 'string', default: 'state/georgiawoodtools.inventory.json' }, help: { type: 'boolean' } } });
if (values.help || !values.snapshot || !values.tenant) {
  console.log('Usage: node inventory-sync.js --snapshot effective-crm-snapshot.json --tenant TENANT_ID [--state PATH]\nRead-only planning only. Live CRM and Facebook adapters are not activated.');
  process.exit(values.help ? 0 : 1);
}
try {
  const snapshot = JSON.parse(readFileSync(values.snapshot, 'utf8'));
  const result = await syncInventory({ path: values.state, snapshot, config: { ...gwtConfig, tenantId: values.tenant } });
  console.log(JSON.stringify(result, null, 2));
} catch (error) { console.error(error.message); process.exitCode = 1; }
