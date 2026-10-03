/** Deterministic v1 recipient: no models, schedulers, or Slack output. */
import { createHash, randomUUID } from 'node:crypto';
import type { PerformanceArtifact, PerformanceClient, PerformanceQuery } from './ace-ada-performance.js';
export const ACE_ID='U0B4VEG1JLB', OFFICE_ID='C0B83JXLPK6';
export const RECIPIENT_IDS={piper:'U0B7AF0N3CL',ada:'U0AHK9K5GEB'} as const;
export function canonical(value:unknown):string {
 const normalize=(input:unknown):unknown=>{
  if(input===null||typeof input==='string'||typeof input==='boolean')return input;
  if(typeof input==='number'){if(!Number.isFinite(input))throw new Error('Canonical JSON requires finite numbers');return input;}
  if(Array.isArray(input))return input.map(child=>child===undefined?null:normalize(child));
  if(input&&typeof input==='object')return Object.fromEntries(Object.keys(input).sort().filter(k=>(input as Record<string,unknown>)[k]!==undefined).map(k=>[k,normalize((input as Record<string,unknown>)[k])]));
  throw new Error('Canonical JSON requires JSON-compatible values');
 };return JSON.stringify(normalize(value));
}
export const digest=(v:unknown)=>createHash('sha256').update(canonical(v)).digest('hex');
export const rawHash=(v:string)=>createHash('sha256').update(v).digest('hex');
export interface Store {get<T>(key:string):Promise<{revision:number;value:T}|null>;cas(key:string,revision:number|null,value:unknown):Promise<boolean>}
export interface Pilot {id:string;workspaceId:string;channelId:string;actorIds:string[];startsAt:string;expiresAt:string;maxCases:number;maxModelJobs:number;clients:Array<{portalId:string;name:string;participantEmails:string[]}>;meetings:unknown[]}
export interface Config {recipientReleaseId:string;pilot:Pilot;performanceClients?:PerformanceClient[];clients:Array<{portalId:string;channelId:string;ownerNotionId:string}>}
export interface Transition {requestId:string;workspaceId:string;sourceAgent:'ace';targetAgent:'piper';clientPortalId:string;adSetId:string;source:{draftId:string;briefId:string;receiptKey:string;sentAt:string;permalink:string;evidenceKind:string;receipts:Array<{briefId:string;receiptKey:string;sentAt:string;permalink:string;evidenceKind:string}>};transitions:Array<{taskId:string;propertyId:'vdOD';expectedStatus:string;desiredStatus:string}>}
export interface Request {requestId:string;workspaceId:string;sourceAgent:'ace';targetAgent:'piper'|'ada';clientPortalId:string;channelId:string;originalThread:{channelId:string;threadTs:string};createdAt:string;expiresAt:string;maxPolls:number;payload:{kind:string;transition?:Transition;performance?:PerformanceQuery}}
interface Action {id:string;createdAt:string;scope:{workspaceId:string;channelId:string;threadTs:string;actorId:string;clientId:string};kind:string;payload:{name?:string;input?:{draftId?:string;briefIds?:string[]};query?:PerformanceQuery};expiresAt:string;state:string}
interface Authorization {version:1;actionId:string;requestHash:string;expiresAt:string}
export interface SendReceipt {key:string;draftId:string;briefId:string;adSetId:string;clientPortalId:string;sendTaskId:string;approvalTaskId:string;actorId:string;channelId:string;active:boolean;kind:string;sentAt:string;permalink:string;messageTs?:string;threadTs?:string;versionTs?:string}
export interface ScopeSnapshot {statuses:Record<string,string>;versions:Record<string,string>}
export interface Provider {
 performance?(portalId:string,query:PerformanceQuery,guard:()=>Promise<void>,requestedAt:string):Promise<PerformanceArtifact>;
 identity():Promise<{workspaceId:string;userId:string}>;
 internalOffice():Promise<boolean>;
 /** Independently check exact live task/adset/brief/client/title/owner/policy/signoff relations. */
 scope(transition:Transition,client:Config['clients'][number]):Promise<ScopeSnapshot>;
 observedSend(receipt:SendReceipt,allBriefIds:string[]):Promise<boolean>;
 /** Guard is called inside designated writer immediately before its narrow update. */
 write(taskId:string,expected:string,desired:string,guard:()=>Promise<void>):Promise<void>;
}
export interface Item {taskId:string;propertyId:'vdOD';expectedStatus:string;desiredStatus:string;state:'prepared'|'verified'|'unknown'|'conflict';before?:string;after?:string;observedAt?:string;sourceVersion?:string}
export interface Result {version:1;requestId:string;requestHash:string;authorizationHash:string;workspaceId:string;recipientUserId:string;recipientReleaseId:string;clientPortalId:string;state:'running'|'partial'|'verified'|'rejected'|'unknown';items:Item[];performance?:PerformanceArtifact;reason?:string;lease?:{token:string;expiresAt:string}}
export interface Event {agentId:string;userId:string;workspaceId:string;channelId:string;messageTs:string;threadTs?:string;requestId:string}
const id=(s:unknown):s is string=>typeof s==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
const same=(a:string,b:string)=>a.replace(/-/g,'').toLowerCase()===b.replace(/-/g,'').toLowerCase();
const time=(s:string)=>{const n=Date.parse(s);if(!Number.isFinite(n))throw new Error('Invalid finite handoff time');return n;};
export async function receiveAceHandoff(event:Event,config:Config,store:Store,provider:Provider,now:()=>Date=()=>new Date()):Promise<Result> {
 const pilot=config.pilot;
 if(!/^[a-f0-9]{40}$/.test(config.recipientReleaseId)||!['piper','ada'].includes(event.agentId)||event.userId!==ACE_ID||event.channelId!==OFFICE_ID||event.workspaceId!==pilot.workspaceId||!/^T[A-Z0-9]+$/.test(pilot.workspaceId)||!/^\d+\.\d+$/.test(event.messageTs)||!/^[A-Za-z0-9:_-]{1,150}$/.test(event.requestId))throw new Error('Untrusted handoff transport');
 const identity=await provider.identity();if(identity.workspaceId!==event.workspaceId||identity.userId!==RECIPIENT_IDS[event.agentId as keyof typeof RECIPIENT_IDS]||!await provider.internalOffice())throw new Error('Untrusted recipient identity or office');
 if(time(pilot.expiresAt)-time(pilot.startsAt)>14*86400000||pilot.maxCases<1||pilot.maxCases>20||pilot.maxModelJobs<1||pilot.maxModelJobs>40||pilot.clients.length<1||pilot.clients.length>2)throw new Error('Invalid finite recipient pilot');
 const live=()=>{if(now().getTime()<time(pilot.startsAt)||now().getTime()>=time(pilot.expiresAt))throw new Error('Recipient pilot expired or not started');};live();
 const pin=await store.get<{configHash:string;cases:string[];jobs:string[]}>(`pilot:${pilot.id}`);
 if(!pin||pin.value.configHash!==rawHash(JSON.stringify(pilot))||!pin.value.cases.includes(`handoff:${event.requestId}`)||pin.value.cases.length>pilot.maxCases||pin.value.jobs.length>pilot.maxModelJobs)throw new Error('Pilot is not identically pinned/reserved');
 const record=await store.get<{request:Request;requestHash:string}>(`agent-handoff:${rawHash(event.requestId)}`),r=record?.value.request;
 if(!r||r.requestId!==event.requestId||r.workspaceId!==event.workspaceId||r.channelId!==OFFICE_ID||r.sourceAgent!=='ace'||r.targetAgent!==event.agentId||record!.value.requestHash!==digest(r)||!id(r.clientPortalId)||!pilot.clients.some(c=>same(c.portalId,r.clientPortalId))||time(r.createdAt)>now().getTime()||time(r.expiresAt)<=time(r.createdAt)||time(r.expiresAt)>time(pilot.expiresAt)||r.maxPolls<1||r.maxPolls>10||!/^\d+\.\d+$/.test(r.originalThread.threadTs)||!(r.originalThread.channelId===pilot.channelId||/^D[A-Z0-9]+$/.test(r.originalThread.channelId)))throw new Error('Invalid immutable scoped request');
 const auth=await store.get<Authorization>(`agent-handoff-authorization:${r.requestId}`);
 const action=auth&&await store.get<Action>(`workspace-action:${auth.value.actionId}`),a=action?.value;
 if(!auth||auth.value.version!==1||!a||a.id!==auth.value.actionId||auth.value.requestHash!==digest(r)||!['executing','verified'].includes(a.state)||a.scope.workspaceId!==r.workspaceId||a.scope.channelId!==r.originalThread.channelId||a.scope.threadTs!==r.originalThread.threadTs||!same(a.scope.clientId,r.clientPortalId)||!pilot.actorIds.includes(a.scope.actorId)||time(auth.value.expiresAt)!==Math.min(time(a.expiresAt),time(r.expiresAt),time(pilot.expiresAt)))throw new Error('Missing exact human-confirmed action proof');
 const deadline=Math.min(time(auth.value.expiresAt),now().getTime()+60000),bounded=()=>{live();if(now().getTime()>=deadline)throw new Error('Handoff action deadline expired');};bounded();
 const key=`agent-recipient:${rawHash(r.requestId)}`,hash=digest(r),authorizationHash=digest(auth.value),prior=await store.get<Result>(key);
 if(prior&&(prior.value.requestHash!==hash||prior.value.authorizationHash!==authorizationHash||prior.value.recipientUserId!==identity.userId||prior.value.recipientReleaseId!==config.recipientReleaseId||prior.value.clientPortalId!==r.clientPortalId))throw new Error('Conflicting immutable recipient receipt');
 if(prior?.value.state==='verified'||prior?.value.state==='rejected')return prior.value;
 if(prior?.value.state==='partial'&&prior.value.performance&&event.agentId==='ada'&&r.payload.kind==='ada-account-performance'&&r.createdAt===a.createdAt&&a.kind==='performance-read'&&a.payload.name==='ace_request_performance'&&r.payload.performance&&canonical(a.payload.query)===canonical(r.payload.performance)&&canonical(prior.value.performance.client)===canonical(config.performanceClients?.find(c=>c.portalId===r.clientPortalId))&&prior.value.performance.window.requestedAt===r.createdAt)return prior.value;
 if(prior?.value.lease&&time(prior.value.lease.expiresAt)>now().getTime())throw new Error('Recipient request is leased');
 const initial:Result=prior?.value??{version:1,requestId:r.requestId,requestHash:hash,authorizationHash,workspaceId:r.workspaceId,recipientUserId:identity.userId,recipientReleaseId:config.recipientReleaseId,clientPortalId:r.clientPortalId,state:'running',items:[]};
 const token=randomUUID();initial.lease={token,expiresAt:new Date(deadline).toISOString()};
 if(!await store.cas(key,prior?.revision??null,initial))throw new Error('Recipient claim raced');
 async function save(change:(value:Result)=>Result){bounded();const current=await store.get<Result>(key);if(!current||current.value.lease?.token!==token)throw new Error('Recipient lease lost');const result=change(current.value);if(!await store.cas(key,current.revision,result))throw new Error('Recipient receipt raced');return result;}
 async function finish(state:Result['state'],reason?:string){return save(v=>({...v,state,reason,lease:undefined}));}
 try {
  if(event.agentId==='ada'&&r.payload.kind==='ada-account-performance'){
   const query=r.payload.performance;
   if(r.createdAt!==a.createdAt||a.kind!=='performance-read'||a.payload.name!=='ace_request_performance'||!query||canonical(a.payload.query)!==canonical(query)||Object.keys(query).sort().join(',')!=='days,endDate,startDate'||!provider.performance||!config.performanceClients?.some(c=>c.portalId===r.clientPortalId))return await finish('rejected','Confirmed action does not authorize exact enrolled performance read');
   const guard=async()=>{bounded();const [freshAction,freshAuth,freshRequest,freshPilot]=await Promise.all([store.get<Action>(`workspace-action:${a.id}`),store.get<Authorization>(`agent-handoff-authorization:${r.requestId}`),store.get<{request:Request}>(`agent-handoff:${rawHash(r.requestId)}`),store.get<{configHash:string;cases:string[];jobs:string[]}>(`pilot:${pilot.id}`)]);bounded();
    if(!freshAction||!['executing','verified'].includes(freshAction.value.state)||digest({...freshAction.value,state:undefined,result:undefined})!==digest({...a,state:undefined,result:undefined})||!freshAuth||digest(freshAuth.value)!==authorizationHash||!freshRequest||digest(freshRequest.value.request)!==hash||freshPilot?.value.configHash!==pin!.value.configHash||!freshPilot.value.cases.includes(`handoff:${r.requestId}`)||freshPilot.value.cases.length>pilot.maxCases||freshPilot.value.jobs.length>pilot.maxModelJobs)throw new Error('Performance authority/request changed');
   };
   await guard();const performance=initial.performance??await provider.performance(r.clientPortalId,query,guard,r.createdAt);await guard();
   if(performance.kind!=='ada-account-performance'||performance.state!=='partial'||performance.client.portalId!==r.clientPortalId||canonical(performance.client)!==canonical(config.performanceClients.find(c=>c.portalId===r.clientPortalId))||performance.window.requestedAt!==r.createdAt||canonical({days:performance.window.days,startDate:performance.window.startDate,endDate:performance.window.endDate})!==canonical(query)||performance.freshness.state!=='unverified')throw new Error('Unexpected scoped performance artifact');
   await save(v=>({...v,performance}));return await finish('partial','Stored account performance read; latest sync freshness remains unverified');
  }
  if(event.agentId!=='piper'||r.payload.kind!=='piper-brief-transitions')return await finish('rejected','Unsupported deterministic handoff kind; no model invoked');
  const t=r.payload.transition;
  if(!t||t.requestId!==r.requestId||t.workspaceId!==r.workspaceId||t.sourceAgent!=='ace'||t.targetAgent!=='piper'||!same(t.clientPortalId,r.clientPortalId)||!id(t.adSetId)||!id(t.source.draftId)||!id(t.source.briefId)||!Array.isArray(t.source.receipts)||t.source.receipts.length<1||t.source.receipts.length>20||t.transitions.length!==2||t.transitions.some(x=>!id(x.taskId)||x.propertyId!=='vdOD')||t.transitions[0]!.expectedStatus!=='In Progress'||t.transitions[0]!.desiredStatus!=='Done'||t.transitions[1]!.expectedStatus!=='Blocked'||t.transitions[1]!.desiredStatus!=='In Progress'||same(t.transitions[0]!.taskId,t.transitions[1]!.taskId))return await finish('rejected','Unsupported exact task transition');
  const input=a.payload.input;
  if(a.kind!=='brief-operation'||a.payload.name!=='ace_brief_request_status'||input?.draftId!==t.source.draftId||!Array.isArray(input.briefIds)||!input.briefIds.includes(t.source.briefId)||new Set(input.briefIds).size!==input.briefIds.length)return await finish('rejected','Confirmed action does not authorize exact brief operation');
  const client=config.clients.find(c=>same(c.portalId,r.clientPortalId));if(!client||!id(client.ownerNotionId)||!/^C[A-Z0-9]+$/.test(client.channelId))return await finish('rejected','Recipient client mapping missing');
  const draft=await store.get<any>(`brief-draft:${t.source.draftId}`),d=draft?.value;
  const item=d?.items?.filter((i:any)=>same(i.adSet?.id??'',t.adSetId));
  if(!d||!same(d.clientPortalId,r.clientPortalId)||d.channelId!==client.channelId||item.length!==1||item[0].sendTask.id!==t.transitions[0]!.taskId||item[0].approvalTask?.id!==t.transitions[1]!.taskId)return await finish('rejected','Original draft/task pair changed');
  const briefIds:string[]=item[0].briefs.map((b:any)=>b.id);
  if(!briefIds.length||new Set(briefIds).size!==briefIds.length||canonical([...briefIds].sort())!==canonical(t.source.receipts.map(s=>s.briefId).sort())||!briefIds.includes(t.source.briefId)||!t.source.receipts.some(s=>s.briefId===t.source.briefId&&s.receiptKey===t.source.receiptKey&&s.sentAt===t.source.sentAt&&s.permalink===t.source.permalink&&s.evidenceKind===t.source.evidenceKind))return await finish('rejected','Exact draft brief/send evidence is incomplete');
  const proofs=new Map<string,number>();
  async function evidence(pinVersions:boolean){bounded();const freshAction=await store.get<Action>(`workspace-action:${a!.id}`),freshAuth=await store.get<Authorization>(`agent-handoff-authorization:${r!.requestId}`),freshRequest=await store.get<{request:Request}>(`agent-handoff:${rawHash(r!.requestId)}`),freshPilot=await store.get<{configHash:string;cases:string[];jobs:string[]}>(`pilot:${pilot.id}`);
   const freshDraft=await store.get<any>(`brief-draft:${t!.source.draftId}`);if(!freshDraft||digest(freshDraft.value)!==digest(d))throw new Error('Original draft changed');
   if(!freshAction||!['executing','verified'].includes(freshAction.value.state)||digest({...freshAction.value,state:undefined,result:undefined})!==digest({...a,state:undefined,result:undefined})||!freshAuth||digest(freshAuth.value)!==authorizationHash||!freshRequest||digest(freshRequest.value.request)!==hash||freshPilot?.value.configHash!==pin!.value.configHash||!freshPilot.value.cases.includes(`handoff:${r!.requestId}`)||freshPilot.value.cases.length>pilot.maxCases||freshPilot.value.jobs.length>pilot.maxModelJobs)throw new Error('Authority/request changed before action');
   for(const source of t!.source.receipts){const receipt=await store.get<SendReceipt>(source.receiptKey),s=receipt?.value;
    if(source.receiptKey!==`brief-sent:${t!.source.draftId}:${source.briefId}`||!s||!s.active||s.key!==source.receiptKey||s.draftId!==t!.source.draftId||s.briefId!==source.briefId||s.adSetId!==t!.adSetId||s.clientPortalId!==r!.clientPortalId||s.sendTaskId!==t!.transitions[0]!.taskId||s.approvalTaskId!==t!.transitions[1]!.taskId||s.channelId!==client!.channelId||!pilot.actorIds.includes(s.actorId)||s.sentAt!==source.sentAt||s.permalink!==source.permalink||s.kind!==source.evidenceKind||!['slack-observed','human-attestation'].includes(s.kind)||time(s.sentAt)>now().getTime())throw new Error('Active human send proof changed');
    if(s.kind==='slack-observed'&&!await provider.observedSend(s,briefIds))throw new Error('Observed human send changed');
    if(pinVersions)proofs.set(source.receiptKey,receipt!.revision);else if(proofs.get(source.receiptKey)!==receipt!.revision)throw new Error('Send proof revision changed before write');
   }bounded();}
  await evidence(true);
  for(const op of t.transitions){if(op.taskId===t.transitions[1]!.taskId){const first=await store.get<Result>(key);if(first?.value.items.find(i=>i.taskId===t.transitions[0]!.taskId)?.state!=='verified')break;}bounded();await evidence(false);const snapshot=await provider.scope(t,client);bounded();let result=await store.get<Result>(key),existing=result?.value.items.find(i=>i.taskId===op.taskId),current=snapshot.statuses[op.taskId];
   if(existing){if(current===op.desiredStatus){await save(v=>({...v,items:v.items.map(i=>i.taskId===op.taskId?{...i,state:'verified',after:current,observedAt:now().toISOString(),sourceVersion:snapshot.versions[op.taskId]}:i)}));continue;}
    await save(v=>({...v,items:v.items.map(i=>i.taskId===op.taskId?{...i,state:existing!.state==='verified'?'conflict':'unknown'}:i)}));continue;}
   if(current!==op.expectedStatus){await save(v=>({...v,items:[...v.items,{...op,state:'conflict',before:current}]}));continue;}
   await save(v=>({...v,items:[...v.items,{...op,state:'prepared',before:current,sourceVersion:snapshot.versions[op.taskId]}]}));
   try {await provider.write(op.taskId,op.expectedStatus,op.desiredStatus,async()=>{bounded();await evidence(false);const fresh=await provider.scope(t,client);if(t!.transitions.slice(0,t!.transitions.findIndex(x=>x.taskId===op.taskId)).some(x=>fresh.statuses[x.taskId]!==x.desiredStatus)||fresh.statuses[op.taskId]!==op.expectedStatus||fresh.versions[op.taskId]!==snapshot.versions[op.taskId])throw new Error('Task precondition changed');await save(v=>v);bounded();});}catch{/* Saved prepared intent must be reconciled, never automatically rewritten. */}
   bounded();const readback=await provider.scope(t,client);bounded();await save(v=>({...v,items:v.items.map(i=>i.taskId===op.taskId?{...i,state:readback.statuses[op.taskId]===op.desiredStatus?'verified':'unknown',after:readback.statuses[op.taskId],observedAt:now().toISOString(),sourceVersion:readback.versions[op.taskId]}:i)}));
  }
  await evidence(false);const finalScope=await provider.scope(t,client);bounded();await save(v=>({...v,items:v.items.map(i=>i.state==='verified'&&finalScope.statuses[i.taskId]!==i.desiredStatus?{...i,state:'conflict',after:finalScope.statuses[i.taskId],observedAt:now().toISOString()}:i)}));
  const final=await store.get<Result>(key);return await finish(final!.value.items.length===2&&final!.value.items.every(i=>i.state==='verified')?'verified':final!.value.items.some(i=>i.state==='verified')?'partial':'unknown','Each task outcome is independently reread; unresolved values require review, not replay');
 } catch {const current=await store.get<Result>(key);if(current?.value.lease?.token===token){const state=current.value.items.some(i=>i.state==='verified')?'partial':current.value.items.length?'unknown':'rejected';const result={...current.value,state:state as Result['state'],reason:'Source, authority, deadline or provider outcome requires review; no automatic retry',lease:undefined};if(await store.cas(key,current.revision,result))return result;}throw new Error('Recipient outcome unknown; lease/reconciliation required');}
}
