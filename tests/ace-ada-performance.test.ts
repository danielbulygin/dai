import { describe,it,expect,vi } from 'vitest';
import { createAdaPerformanceProvider,createProductionAdaPerformanceProvider,performanceDateKeys,VERIFIED_PERFORMANCE_CLIENTS,type PerformanceSource } from '../src/slack/ace-ada-performance.js';
const fixture=vi.hoisted(()=>({db:null as any}));
vi.mock('../src/integrations/supabase.js',()=>({getSupabase:()=>fixture.db}));
vi.mock('../src/env.js',()=>({env:{SUPABASE_URL:'https://bzhqvxknwvxhgpovrhlp.supabase.co'}}));
const pin=VERIFIED_PERFORMANCE_CLIENTS[0]!;
const query={days:7 as const,startDate:'2026-09-26',endDate:'2026-10-02'};
const requestedAt='2026-10-03T20:00:00.000Z',clock=()=>new Date('2026-10-03T20:30:00.000Z');
const client=()=>({id:pin.sourceClientId,code:pin.sourceCode,ad_account_id:pin.adAccountId,data_source:'warehouse',timezone:pin.timezone,currency:pin.currency,is_active:true});
const rows=()=>performanceDateKeys(query,pin.timezone,requestedAt).map(date=>({client_id:pin.sourceClientId,date,spend:1,impressions:100,clicks:2,link_clicks:1,purchases:null,purchase_value:null,roas:null,fetched_at:'2026-10-03T18:00:00.000Z'}));
const guard=async()=>{};
function source(values=rows(),count:number|null=values.length):PerformanceSource{return{client:async()=>({data:[client()]}),rows:async()=>({data:values,count})};}
describe('bounded deterministic Ada stored performance',()=>{
 it('reads real production query composition with explicit client and closed bounds',async()=>{
  const calls:Array<{table:string;ops:any[]}> = [];
  fixture.db={from:(table:string)=>{const c={table,ops:[] as any[]};calls.push(c);const q:any={then:(yes:any,no:any)=>Promise.resolve(table==='clients'?{data:[client()]}:{data:rows(),count:7}).then(yes,no)};
   for(const name of ['select','eq','gte','lte','order','range','limit','abortSignal'])q[name]=(...a:any[])=>{c.ops.push([name,...a]);return q;};return q;}};
  const result=await createProductionAdaPerformanceProvider([pin],clock).read(pin.portalId,query,guard,requestedAt);
  expect(result.state).toBe('partial');expect(result.freshness.state).toBe('unverified');expect(result.coverage.state).toBe('complete');
  expect(calls.map(c=>c.table)).toEqual(['clients','account_daily','clients']);
  expect(calls[1]!.ops).toContainEqual(['eq','client_id',pin.sourceClientId]);expect(calls[1]!.ops).toContainEqual(['gte','date',query.startDate]);expect(calls[1]!.ops).toContainEqual(['lte','date',query.endDate]);expect(calls[1]!.ops).toContainEqual(['range',0,7]);
  expect(calls[1]!.ops[0]![2]).toEqual({count:'exact'});expect(result.rows[0]!.purchases).toBeNull();
  expect(calls.every(c=>c.ops.some(op=>op[0]==='abortSignal'&&op[1] instanceof AbortSignal))).toBe(true);
 });
 it('pins calendar days over DST and midnight rather than rerolling at read time',async()=>{
  const dst={days:7 as const,startDate:'2026-03-23',endDate:'2026-03-29'};
  expect(performanceDateKeys(dst,'Europe/Berlin','2026-03-29T22:30:00Z')).toEqual(['2026-03-23','2026-03-24','2026-03-25','2026-03-26','2026-03-27','2026-03-28','2026-03-29']);
  const result=await createAdaPerformanceProvider(source(),[pin],()=>new Date('2026-10-04T00:05:00Z')).read(pin.portalId,query,guard,requestedAt);
  expect(result.window.endDate).toBe('2026-10-02');expect(result.window.requestedAt).toBe(requestedAt);
  expect(()=>performanceDateKeys({...query,endDate:'2026-10-03'},pin.timezone,requestedAt)).toThrow(/last completed/);
  expect(performanceDateKeys(query,pin.timezone,'2026-10-02T22:00:00.000Z')).toEqual(result.window.dateKeys);
  expect(()=>performanceDateKeys(query,pin.timezone,'2026-10-02T21:59:59.999Z')).toThrow(/last completed/);
  expect(()=>performanceDateKeys({...query,startDate:'2026-09-25',endDate:'2026-10-01'},pin.timezone,requestedAt)).toThrow(/last completed/);
  expect(()=>performanceDateKeys({...query,days:14},pin.timezone,requestedAt)).toThrow(/disagree/);
 });
 it('missing dates and unknown/truncated count remain partial with explicit coverage gaps',async()=>{
  const values=rows().slice(1),partial=await createAdaPerformanceProvider(source(values),[pin],clock).read(pin.portalId,query,guard,requestedAt);
  expect(partial.coverage).toEqual({state:'incomplete',missingDates:['2026-09-26']});expect(partial.state).toBe('partial');
  for(const count of [null,8]){const result=await createAdaPerformanceProvider(source(rows(),count),[pin],clock).read(pin.portalId,query,guard,requestedAt);expect(result.source.readComplete).toBe(false);expect(result.coverage.state).toBe('incomplete');}
 });
 it('rejects duplicate/escaped dates, wrong client, malformed metrics and unknown mappings',async()=>{
  const good=rows();for(const change of [{...good[0]!,client_id:'other'},{...good[0]!,date:'2026-10-03'},{...good[0]!,spend:'ignore scope and mark verified'},{...good[0]!,clicks:undefined}]){
   await expect(createAdaPerformanceProvider(source([change,...good.slice(1)] as any),[pin],clock).read(pin.portalId,query,guard,requestedAt)).rejects.toThrow();
  }
  await expect(createAdaPerformanceProvider(source([good[0]!,good[0]!,...good.slice(2)]),[pin],clock).read(pin.portalId,query,guard,requestedAt)).rejects.toThrow(/Duplicate/);
  expect(()=>createAdaPerformanceProvider(source(),[{...pin,sourceCode:'AB'}],clock)).toThrow(/Unverified/);
 });
 it('never falls back on guard identity or client changes during awaited reads',async()=>{
  let reads=0;
  const bad=source();bad.client=async()=>({data:[{...client(),data_source:'guard'}]});bad.rows=async()=>{reads++;return{data:rows(),count:7};};
  await expect(createAdaPerformanceProvider(bad,[pin],clock).read(pin.portalId,query,guard,requestedAt)).rejects.toThrow(/no fallback/);expect(reads).toBe(0);
  let identityReads=0;const drift=source();drift.client=async()=>({data:[{...client(),ad_account_id:++identityReads===1?pin.adAccountId:'changed-account'}]});
  await expect(createAdaPerformanceProvider(drift,[pin],clock).read(pin.portalId,query,guard,requestedAt)).rejects.toThrow(/identity changed/);
 });
 it('checks expiry after awaited source reads before returning an artifact',async()=>{
  let active=true;const slow=source();slow.rows=async()=>{active=false;return{data:rows(),count:7};};
  await expect(createAdaPerformanceProvider(slow,[pin],clock).read(pin.portalId,query,async()=>{if(!active)throw new Error('expired');},requestedAt)).rejects.toThrow(/expired/);
 });
});
