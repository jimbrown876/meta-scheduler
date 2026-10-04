import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { ensureFacebookDestination, scheduleAndVerify, assertAccessiblePage, validateReceipt } from './publishing-guards.js';
const account={pageId:'123',pageName:'Fixture Page',destinationGroupLabel:'Publish to',destinationLabel:'Fixture Page Facebook',successText:'Post scheduled',successLinkLabel:'View scheduled post'};
async function fixture(t,html){const browser=await chromium.launch({headless:true,...(process.env.META_TEST_BROWSER?{executablePath:process.env.META_TEST_BROWSER}:{})});t.after(()=>browser.close());const context=await browser.newContext();await context.route('**/*',route=>route.fulfill({contentType:'text/html',body:html}));const page=await context.newPage();await page.goto('https://business.facebook.com/latest/composer/?asset_id=123');return page;}
const controls='<fieldset aria-label="Publish to"><label><input type="checkbox">Fixture Page Facebook</label><label><input type="checkbox" checked>Instagram</label><label><input type="checkbox" checked>Other Facebook</label></fieldset>';
test('browser destination selection leaves exactly the intended Facebook Page checked',async t=>{const page=await fixture(t,controls);await ensureFacebookDestination(page,account);assert.equal(await page.getByRole('checkbox',{name:'Fixture Page Facebook',exact:true}).isChecked(),true);assert.equal(await page.locator('input:checked').count(),1);await page.goto('https://business.facebook.com/latest/composer/?asset_id=999');await assert.rejects(ensureFacebookDestination(page,account),/identity/);});
test('browser receipt appears after a persisted intent and verifies the post identity',async t=>{const page=await fixture(t,controls+'<button onclick="document.body.insertAdjacentHTML(\'beforeend\',\'<p>Post scheduled</p><a href=https://www.facebook.com/fixture/posts/456>View scheduled post</a>\')">Schedule</button>');let saved=false;const receipt=await scheduleAndVerify(page,account,async()=>{assert.equal(await page.getByText('Post scheduled',{exact:true}).count(),0);saved=true;});assert.equal(saved,true);assert.equal(receipt.postId,'456');await assert.rejects(scheduleAndVerify(page,account,()=>assert.fail()),/stale/);});
test('a restriction stops before the browser can submit',async t=>{const page=await fixture(t,controls+'<p>You cannot access this service</p><button>Schedule</button>');await assert.rejects(scheduleAndVerify(page,account,()=>assert.fail()),/account action/);});
test('a Business Suite URL with the right asset is not proof of account access',async t=>{
  const page=await fixture(t,'<h1>Unable to access Meta Business Suite with this account</h1><p>Your account does not have access to any Facebook Pages.</p>');
  await assert.rejects(assertAccessiblePage(page,account),/account action/);
});
test('Page permalink receipts require an independently configured profile identity',()=>{
  const receipt={pageId:'123',postId:'pfbidAbc123',verified:true,url:'https://www.facebook.com/permalink.php?story_fbid=pfbidAbc123&id=456'};
  assert.equal(validateReceipt(receipt,'123','456'),receipt);
  for (const profile of [undefined,'123','999']) assert.throws(()=>validateReceipt(receipt,'123',profile),/profile identity/);
  for (const suffix of ['&id=456','&fbclid=tracking','#fragment']) assert.throws(()=>validateReceipt({...receipt,url:receipt.url+suffix},'123','456'));
  assert.throws(()=>validateReceipt({...receipt,postId:'pfbidOther'},'123','456'),/do not match/);
  assert.throws(()=>validateReceipt({...receipt,url:receipt.url.replace('www.facebook.com','www.facebook.com:444')},'123','456'));
});
