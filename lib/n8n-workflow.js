import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Generate SDK source; import/activation remains an explicit deployment operation.
export function workflowSource(release) {
  if (!/^[a-f0-9]{40}$/.test(release)) throw new Error('Expected immutable release SHA');
  const command = mode => `/usr/bin/node /srv/georgia-wood-tools-publisher/releases/${release}/lib/publisher-cli.js ${mode} --config /etc/georgia-wood-tools/publisher.json`;
  const parse = mode => `const r = $input.first().json;
let result; try { result = JSON.parse(r.stdout || ''); } catch { throw new Error('PUBLISHER_INVALID_OUTPUT'); }
if (r.code !== 0 || result.ok !== true || result.mode !== '${mode}') {
  const code = typeof result.code === 'string' && /^[A-Z_]+$/.test(result.code) ? result.code : 'PUBLISHER_FAILED';
  throw new Error(code);
}
return [{json:result}];`;
  const ssh = (variable, name, cmd, x, y) => `const ${variable} = node({type:'n8n-nodes-base.ssh',version:1,config:{name:${JSON.stringify(name)},position:[${x},${y}],parameters:{resource:'command',operation:'execute',authentication:'privateKey',command:${JSON.stringify(cmd)}},credentials:{sshPrivateKey:newCredential('VPS Host (n8n-to-host)')},retryOnFail:false},output:[{code:0,stdout:'{}',stderr:''}]});`;
  const code = (variable, name, js, x, y) => `const ${variable} = node({type:'n8n-nodes-base.code',version:2,config:{name:${JSON.stringify(name)},position:[${x},${y}],parameters:{mode:'runOnceForAllItems',language:'javaScript',jsCode:${JSON.stringify(js)}}},output:[{ok:true}]});`;
  return [
    "import {workflow,node,trigger,newCredential,sticky} from '@n8n/workflow-sdk';",
    "const check = trigger({type:'n8n-nodes-base.manualTrigger',version:1,config:{name:'Check readiness without posting',position:[0,0]},output:[{}]});",
    ssh('identity','Read VPS service identity','/usr/bin/id -un',220,0),
    code('requireIdentity','Require Jim service user',"const r=$input.first().json; if(r.code!==0 || r.stdout.trim()!=='jim') throw new Error('PUBLISHER_USER_MISMATCH'); return [{json:{serviceUser:'jim'}}];",440,0),
    ssh('plan','Read current CRM publishing plan',command('plan'),660,0),
    code('checkPlan','Validate inventory plan',parse('plan'),880,0),
    ssh('session','Check VPS Facebook session',command('status'),1100,0),
    code('checkSession','Require verified Page access',parse('status'),1320,0),
    "const clock = trigger({type:'n8n-nodes-base.scheduleTrigger',version:1.3,config:{name:'Every 15 minutes after activation',position:[0,300],parameters:{rule:{interval:[{field:'minutes',minutesInterval:15}]}}},output:[{}]});",
    ssh('publish','Sync CRM inventory to Page',command('sync'),220,300),
    code('verify','Verify publisher result',parse('sync'),440,300),
    "const note=sticky('Publishing stays OFF until the VPS Page login and a real create/update/sold canary pass. Manual execution only checks identity, CRM inventory and the existing Facebook session. The scheduled branch publishes only when both this workflow and the private liveEnabled setting are enabled. It never enters passwords or requests verification codes. Missing catalog listings require review; no inferred sales or deletion. Three writes per run, with remaining work retained; no monthly plan limit.',[],{color:5});",
    "export default workflow('gwt-selfhost-publisher','Georgia Wood Tools — Self-hosted Facebook Publisher',{timezone:'America/New_York',executionTimeout:600,executionOrder:'v1',errorWorkflow:'N9c3ZYOWw2xIFq5j',callerPolicy:'workflowsFromSameOwner',availableInMCP:true}).add(check).to(identity).to(requireIdentity).to(plan).to(checkPlan).to(session).to(checkSession).add(clock).to(publish).to(verify).add(note);",
  ].join('\n');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.stdout.write(workflowSource(process.argv[2]) + '\n');
