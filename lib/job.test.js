import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jobFingerprint } from './job.js';
test('job fingerprint includes changed caption, media and schedule; invalid dry-run assets fail',t=>{const dir=mkdtempSync(join(tmpdir(),'meta-job-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const images=join(dir,'images'),caption=join(dir,'caption');mkdirSync(images);writeFileSync(caption,'Machine listing');const entry={images,caption,datetime:'2026-10-10 09:00',captionStartLine:1};const account={pageId:'123',platforms:['facebook'],timezone:'America/New_York'};assert.throws(()=>jobFingerprint(entry,account),/nonempty/);writeFileSync(join(images,'1.png'),'fixture one');const a=jobFingerprint(entry,account);writeFileSync(caption,'Updated machine');assert.notEqual(jobFingerprint(entry,account),a);writeFileSync(caption,'Machine listing');writeFileSync(join(images,'1.png'),'fixture two');assert.notEqual(jobFingerprint(entry,account),a);assert.notEqual(jobFingerprint({...entry,datetime:'2026-10-11 09:00'},account),jobFingerprint(entry,account));writeFileSync(caption,'');assert.throws(()=>jobFingerprint(entry,account),/empty/);});
