import {describe,it,expect,vi} from 'vitest';
vi.mock('../src/env.js',()=>({env:{NOTION_TOKEN:'fixture-token'}}));
vi.mock('../src/integrations/supabase.js',()=>({getSupabase:vi.fn()}));
vi.mock('../src/agents/tools/aot-notion-tools.js',()=>({updateAotTaskStatus:vi.fn()}));
vi.mock('../src/agents/action-log.js',()=>({logWrite:vi.fn()}));
vi.mock('../src/utils/logger.js',()=>({logger:{warn:vi.fn()}}));
import {createAceHandoffProvider} from '../src/slack/ace-handoff-bridge.js';
import type {Config,SendReceipt,Transition} from '../src/slack/ace-handoff-core.js';
const uid=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const now=()=>new Date('2026-10-03T19:00:00Z');
const cfg={pilot:{expiresAt:'2026-10-04T19:00:00Z'}} as Config;
const opts={agentId:'piper',text:'',userId:'UOWNER',channel:'COFFICE',messageTs:'1.1',source:'agent-mention'};
const s={briefId:uid(5),channelId:'CCLIENT',actorId:'UOWNER',messageTs:'1.1'} as SendReceipt;
function observed(text:string){const client={conversations:{replies:async()=>({ok:true,messages:[{ts:'1.1',user:'UOWNER',text}]})}};return createAceHandoffProvider({...opts,client:client as never},cfg,now).observedSend(s,[s.briefId]);}
describe('Real recipient observed send URL recognition',()=>{
 it.each([`https://app.notion.com/p/${uid(5)}`,`https://www.notion.so/title-${uid(5).replace(/-/g,'')}`,`https://notion.so/${uid(5)}`])('recognizes exact canonical Notion brief %s',async link=>expect(await observed(`<${link}|brief>`)).toBe(true));
 it.each([`https://app.notion.com.evil.test/p/${uid(5)}`,`https://evil.test/p/${uid(5)}`,`https://app.notion.com/p/other?brief=${uid(5)}`,`https://app.notion.com/p/${uid(5)}suffix`,`https://user@notion.so/${uid(5)}`,`https://app.notion.com/p/${uid(6)}`])('rejects spoofed host/path or wrong brief %s',async link=>expect(await observed(link)).toBe(false));
});
function scopeFixture(wrongClient=false,incomplete=false){
 const portal=uid(1),adsetId=uid(2),sendId=uid(3),approvalId=uid(4),briefId=uid(5),owner=uid(8),taskIds=Array.from({length:27},(_,i)=>uid(i+30));taskIds[0]=sendId;taskIds[1]=approvalId;
 const rel=(ids:string[],extra={})=>({type:'relation',relation:ids.map(id=>({id})),...extra});
 const stat=(name:string)=>({id:'vdOD',type:'status',status:{name}});
 const title=(name:string)=>({type:'title',title:[{plain_text:name}]});
 const task=(id:string,i:number)=>({object:'page',id,last_edited_time:'v1',properties:{Client:rel([portal]),'Ad Set':rel([adsetId]),'Task name ':title(i===0?'Send Brief to Client':i===1?'Approve Brief':i===2?'Sign-off Brief Internally':'Other'),'Assignee':{type:'people',people:[{id:owner}]},Status:stat(i===0?'In Progress':i===1?'Blocked':'Done')}});
 const adset={object:'page',id:adsetId,properties:{Client:rel([portal]),'EXT | Client Briefs':rel([briefId]),Tasks:rel(taskIds.slice(0,25),{id:'qaGg',has_more:true})}};
 const brief={object:'page',id:briefId,properties:{'Ad Sets':rel([adsetId]),'Clients ':rel(wrongClient?[uid(99)]:[])}};
 const c={properties:{'Client Portal':rel([portal]),Status:{type:'status',status:{name:'Active'}},'Upload Approvals':{type:'multi_select',multi_select:[{name:'Brief Approval Required'}]}}};
 const paths:string[]=[];
 const fetcher=vi.fn(async(url:any,options:any)=>{const path=new URL(String(url)).pathname;paths.push(path);let body:any;
 if(path.endsWith(`/pages/${adsetId}`))body=adset;else if(path.endsWith(`/pages/${briefId}`))body=brief;else if(path.endsWith('/properties/qaGg'))body={results:taskIds.map(id=>({type:'relation',relation:{id}})),has_more:incomplete,next_cursor:incomplete?null:null};else if(path.includes('27e1398c'))body={results:taskIds.map(task),has_more:false,next_cursor:null};else if(path.includes('2681398c'))body={results:[c],has_more:false,next_cursor:null};else throw Error(`Unexpected fixture path ${path}`);
 expect(options.method==='GET'||(options.method==='POST'&&path.endsWith('/query'))).toBe(true);return new Response(JSON.stringify(body),{status:200});});
 const transition={adSetId:adsetId,clientPortalId:portal,source:{receipts:[{briefId}]},transitions:[{taskId:sendId},{taskId:approvalId}]} as Transition;
 const client={portalId:portal,channelId:'CCLIENT',ownerNotionId:owner};
 return {provider:createAceHandoffProvider({...opts,client:{} as never},cfg,now,fetcher as never),transition,client,paths};
}
describe('Complete recipient Notion source scope',()=>{
 it('accepts reciprocal empty brief client relation and fully reads >25 companion tasks',async()=>{const f=scopeFixture();const result=await f.provider.scope(f.transition,f.client);expect(result.statuses).toEqual({[uid(3)]:'In Progress',[uid(4)]:'Blocked'});expect(f.paths.some(p=>p.endsWith('/properties/qaGg'))).toBe(true);});
 it('refuses wrong nonempty brief client relation',async()=>{const f=scopeFixture(true);await expect(f.provider.scope(f.transition,f.client)).rejects.toThrow('Brief escaped');});
 it('refuses incomplete relation instead of inventing full readiness',async()=>{const f=scopeFixture(false,true);await expect(f.provider.scope(f.transition,f.client)).rejects.toThrow('pagination incomplete');});
});
