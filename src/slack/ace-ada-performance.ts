/** Scoped stored-performance read. No model, Meta request, fallback, or mutation. */
import { createHash } from 'node:crypto';
export interface PerformanceQuery { days: 7 | 14; startDate: string; endDate: string }
export interface PerformanceClient { portalId: string; mirrorCode: 'TL' | 'ADBN'; sourceCode: 'TL' | 'AB'; sourceClientId: string; adAccountId: string; timezone: string; currency: string; dataSource: 'warehouse' }
export interface PerformanceRow { client_id: string; date: string; spend: number | null; impressions: number | null; clicks: number | null; link_clicks: number | null; purchases: number | null; purchase_value: number | null; roas: number | null; fetched_at: string | null }
export interface PerformanceArtifact {
 version: 1; kind: 'ada-account-performance'; state: 'partial'; client: PerformanceClient;
 window: PerformanceQuery & { timezone: string; requestedAt: string; dateKeys: string[] }; observedAt: string;
 source: { projectRef: 'bzhqvxknwvxhgpovrhlp'; table: 'account_daily'; readComplete: boolean; total: number | null; rowsHash: string };
 rows: PerformanceRow[]; coverage: { state: 'complete' | 'incomplete'; missingDates: string[] };
 freshness: { state: 'unverified'; reason: string };
}
export type PerformanceGuard = () => Promise<void>;
export interface PerformanceSource {
 client(pin: PerformanceClient, guard: PerformanceGuard): Promise<{ data: unknown; error?: unknown }>;
 rows(pin: PerformanceClient, query: PerformanceQuery, guard: PerformanceGuard): Promise<{ data: unknown; count: number | null; error?: unknown }>;
}
// Read-only live clients query on 2026-10-03: exact codes, count=2; IDs are UUID strings.
// Portal/mirror mappings are the independently read AM relations from 2026-10-02.
export const VERIFIED_PERFORMANCE_CLIENTS: ReadonlyArray<PerformanceClient> = [
 { portalId: '2821398c-921f-8121-987d-e773a3eb4f55', mirrorCode: 'TL', sourceCode: 'TL', sourceClientId: 'f05a7a38-0009-4404-b988-8b1ebe52f96b', adAccountId: 'act_210156414037422', timezone: 'Europe/Berlin', currency: 'EUR', dataSource: 'warehouse' },
 { portalId: '2df1398c-921f-80ad-bc89-cefbc1a57bec', mirrorCode: 'ADBN', sourceCode: 'AB', sourceClientId: 'b3cd1550-dc08-48b1-a08e-72b7bb67f95b', adAccountId: 'act_2316799408434882', timezone: 'Europe/Berlin', currency: 'EUR', dataSource: 'warehouse' },
];
export const PERFORMANCE_COLUMNS = 'client_id,date,spend,impressions,clicks,link_clicks,purchases,purchase_value,roas,fetched_at';
const CLIENT_COLUMNS = 'id,code,ad_account_id,data_source,timezone,currency,is_active';
function canonical(v: unknown): string {
 if(v===null||typeof v!=='object') return JSON.stringify(v);
 if(Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
 return `{${Object.entries(v as Record<string,unknown>).sort(([a],[b])=>a.localeCompare(b)).map(([k,x])=>`${JSON.stringify(k)}:${canonical(x)}`).join(',')}}`;
}
export const performanceRowsHash = (rows: PerformanceRow[]) => createHash('sha256').update(canonical(rows)).digest('hex');
function day(s: string): Date {
 if(typeof s!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error('Invalid explicit performance date');
 const d=new Date(`${s}T12:00:00.000Z`);
 if(!Number.isFinite(d.getTime())||d.toISOString().slice(0,10)!==s) throw new Error('Invalid explicit performance date');
 return d;
}
function dateAt(instant: string,timezone: string): string {
 const d=new Date(instant);if(!Number.isFinite(d.getTime())) throw new Error('Invalid immutable request timestamp');
 const parts=new Intl.DateTimeFormat('en-US',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(d);
 return ['year','month','day'].map(type=>parts.find(p=>p.type===type)!.value).join('-');
}
export function performanceDateKeys(query: PerformanceQuery,timezone: string,requestedAt: string): string[] {
 if(![7,14].includes(query.days)) throw new Error('Performance window must be exactly 7 or 14 days');
 const start=day(query.startDate),end=day(query.endDate);
 const yesterday=day(dateAt(requestedAt,timezone));yesterday.setUTCDate(yesterday.getUTCDate()-1);
 if(query.endDate!==yesterday.toISOString().slice(0,10)) throw new Error('Performance window must end on the last completed account-local day');
 const dates:string[]=[];
 for(let i=0;i<query.days;i++){const d=new Date(start);d.setUTCDate(d.getUTCDate()+i);dates.push(d.toISOString().slice(0,10));}
 if(dates.at(-1)!==end.toISOString().slice(0,10)) throw new Error('Performance dates disagree with reviewed day count');
 return dates;
}
function identity(data: unknown,pin: PerformanceClient): void {
 if(!Array.isArray(data)||data.length!==1) throw new Error('Exact performance client identity unavailable');
 const r=data[0];
 if(!r||r.id!==pin.sourceClientId||typeof r.id!=='string'||r.code!==pin.sourceCode||r.ad_account_id!==pin.adAccountId||r.data_source!==pin.dataSource||r.timezone!==pin.timezone||r.currency!==pin.currency||r.is_active!==true) throw new Error('Performance client/account/source identity changed; no fallback');
}
function numeric(value: unknown,integer=false): number | null {
 if(value===null) return null;
 if(typeof value!=='number'||!Number.isFinite(value)||value<0||(integer&&!Number.isInteger(value))) throw new Error('Invalid stored performance metric; missing values are not zero');
 return value;
}
function normalizeRow(raw: unknown,pin: PerformanceClient,dates: string[],observedAt: string): PerformanceRow {
 if(!raw||typeof raw!=='object'||Array.isArray(raw)) throw new Error('Invalid performance row');
 const r=raw as Record<string,unknown>;
 if(r.client_id!==pin.sourceClientId||typeof r.date!=='string'||!dates.includes(r.date)) throw new Error('Performance row escaped exact client/date scope');
 if(r.fetched_at!==null&&(typeof r.fetched_at!=='string'||!Number.isFinite(Date.parse(r.fetched_at))||Date.parse(r.fetched_at)>Date.parse(observedAt)+60000)) throw new Error('Invalid stored row timestamp');
 return {client_id:pin.sourceClientId,date:r.date,spend:numeric(r.spend),impressions:numeric(r.impressions,true),clicks:numeric(r.clicks,true),link_clicks:numeric(r.link_clicks,true),purchases:numeric(r.purchases,true),purchase_value:numeric(r.purchase_value),roas:numeric(r.roas),fetched_at:r.fetched_at as string|null};
}
export function createAdaPerformanceProvider(source: PerformanceSource,pins: readonly PerformanceClient[],now:()=>Date=()=>new Date()) {
 if(pins.length<1||pins.length>2||new Set(pins.map(p=>p.portalId)).size!==pins.length) throw new Error('Invalid explicit performance enrollment');
 // This bounded release enrolls only the two independently verified agency identities.
 const clients=pins.map(pin=>{const verified=VERIFIED_PERFORMANCE_CLIENTS.find(p=>p.portalId===pin.portalId);if(!verified||canonical(pin)!==canonical(verified))throw new Error('Unverified performance client mapping');return {...pin};});
 return { async read(portalId: string,query: PerformanceQuery,guard: PerformanceGuard,requestedAt: string): Promise<PerformanceArtifact> {
  const pin=clients.find(p=>p.portalId===portalId);if(!pin)throw new Error('Performance client is not explicitly enrolled');
  const frozenQuery={days:query.days,startDate:query.startDate,endDate:query.endDate};
  const dates=performanceDateKeys(frozenQuery,pin.timezone,requestedAt);
  if(Date.parse(requestedAt)>now().getTime())throw new Error('Performance request timestamp is in the future');
  await guard();const before=await source.client(pin,guard);await guard();if(before.error)throw new Error('Performance identity read failed');identity(before.data,pin);
  const result=await source.rows(pin,frozenQuery,guard);await guard();if(result.error||!Array.isArray(result.data)||result.data.length>frozenQuery.days+1)throw new Error('Performance bounded source read failed');
  const observedAt=now().toISOString();
  const rows=result.data.map(r=>normalizeRow(r,pin,dates,observedAt)).sort((a,b)=>a.date.localeCompare(b.date));
  if(new Set(rows.map(r=>r.date)).size!==rows.length)throw new Error('Duplicate account-local performance dates');
  if(result.count!==null&&(!Number.isInteger(result.count)||result.count<rows.length))throw new Error('Invalid exact performance source count');
  const after=await source.client(pin,guard);await guard();if(after.error)throw new Error('Performance identity reread failed');identity(after.data,pin);
  const readComplete=result.count!==null&&result.count===rows.length;
  const missingDates=dates.filter(d=>!rows.some(r=>r.date===d));
  return {version:1,kind:'ada-account-performance',state:'partial',client:{...pin},window:{...frozenQuery,timezone:pin.timezone,requestedAt,dateKeys:dates},observedAt,source:{projectRef:'bzhqvxknwvxhgpovrhlp',table:'account_daily',readComplete,total:result.count,rowsHash:performanceRowsHash(rows)},rows,coverage:{state:readComplete&&!missingDates.length?'complete':'incomplete',missingDates},freshness:{state:'unverified',reason:'Stored account_daily rows were read now. Row fetched_at is insertion metadata and does not prove a current Meta sync; no scoped sync receipt is enrolled.'}};
 } };
}
export function createProductionAdaPerformanceProvider(pins: readonly PerformanceClient[],now:()=>Date=()=>new Date()) {
 const db=async(guard:PerformanceGuard)=>{await guard();const [{getSupabase},{env}]=await Promise.all([import('../integrations/supabase.js'),import('../env.js')]);await guard();if(!env.SUPABASE_URL||new URL(env.SUPABASE_URL).hostname!=='bzhqvxknwvxhgpovrhlp.supabase.co')throw new Error('Unexpected performance source project');return getSupabase();};
 const source:PerformanceSource={
  client:async(pin,guard)=>{const client=await db(guard);await guard();const result=await client.from('clients').select(CLIENT_COLUMNS).eq('id',pin.sourceClientId).eq('code',pin.sourceCode).limit(2).abortSignal(AbortSignal.timeout(15000));await guard();return result;},
  rows:async(pin,query,guard)=>{const client=await db(guard);await guard();const result=await client.from('account_daily').select(PERFORMANCE_COLUMNS,{count:'exact'}).eq('client_id',pin.sourceClientId).gte('date',query.startDate).lte('date',query.endDate).order('date',{ascending:true}).range(0,query.days).abortSignal(AbortSignal.timeout(15000));await guard();return result;},
 };
 return createAdaPerformanceProvider(source,pins,now);
}
