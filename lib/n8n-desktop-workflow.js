import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function desktopWorkflowSource(release) {
  if (!/^[a-f0-9]{40}$/.test(release)) throw new Error('Expected immutable release SHA');
  const command = mode => `/usr/bin/node /srv/georgia-wood-tools-publisher/releases/${release}/lib/desktop-queue-cli.js ${mode} --state /var/lib/georgia-wood-tools-publisher/desktop-queue.json`;
  const ssh = (v, name, mode, y) => `const ${v}=node({type:'n8n-nodes-base.ssh',version:1,config:{name:${JSON.stringify(name)},position:[240,${y}],parameters:{resource:'command',operation:'execute',authentication:'privateKey',command:${JSON.stringify(command(mode))}},credentials:{sshPrivateKey:newCredential('VPS Host (n8n-to-host)')},retryOnFail:false},output:[{code:0,stdout:'{}',stderr:''}]});`;
  const parse = `const r=$input.first().json; let q; try{q=JSON.parse(r.stdout||'');}catch{throw new Error('DESKTOP_QUEUE_UNAVAILABLE');} if(r.code!==0||q.ok!==true) throw new Error('DESKTOP_QUEUE_UNAVAILABLE'); if(q.notifyCode && /^[A-Z_]+$/.test(q.notifyCode)) throw new Error('GWT_DESKTOP_NEEDS_ATTENTION: '+q.notifyCode); return [{json:q}];`;
  return [
    "import {workflow,node,trigger,newCredential,sticky} from '@n8n/workflow-sdk';",
    "const manual=trigger({type:'n8n-nodes-base.manualTrigger',version:1,config:{name:'Check desktop queue',position:[0,0]},output:[{}]});",
    "const clock=trigger({type:'n8n-nodes-base.scheduleTrigger',version:1.3,config:{name:'Queue latest inventory every 15 minutes',position:[0,240],parameters:{rule:{interval:[{field:'minutes',minutesInterval:15}]}}},output:[{}]});",
    ssh('read','Read queue and Mac status','status',0),
    ssh('enqueue','Retain latest catalog work','enqueue',240),
    `const verify=node({type:'n8n-nodes-base.code',version:2,config:{name:'Verify durable queue',position:[500,100],parameters:{mode:'runOnceForAllItems',language:'javaScript',jsCode:${JSON.stringify(parse)}}},output:[{ok:true,pending:true,workerRecentlySeen:false,blocked:null}]});`,
    "const note=sticky('Desktop mode: n8n retains a durable reconcile-latest-catalog job on the VPS. The Mac polls outbound through the existing private SSH connection. Connection retries wait 1, 5, 15, then 60 minutes; jobs do not expire. Newer CRM state supersedes stale work. Existing verified post receipts prevent duplicates. Login/challenge/restriction/uncertain results remain visible as blocked and need attention. The Mac worker stays disabled until extension access and a scoped live canary pass. VPS browser login remains a deferred follow-up.',[],{color:5});",
    "export default workflow('gwt-desktop-publisher','Georgia Wood Tools — Desktop Facebook Publisher',{timezone:'America/New_York',executionTimeout:60,executionOrder:'v1',errorWorkflow:'N9c3ZYOWw2xIFq5j',callerPolicy:'workflowsFromSameOwner',availableInMCP:true}).add(manual).to(read).to(verify).add(clock).to(enqueue).to(verify).add(note);",
  ].join('\n');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.stdout.write(desktopWorkflowSource(process.argv[2]) + '\n');
