import {describe,it,expect,vi} from 'vitest';
vi.mock('../src/integrations/notion.js',()=>({getNotion:()=>{throw Error('Legacy identity forbidden in this fixture');}}));
vi.mock('../src/integrations/supabase.js',()=>({getSupabase:()=>{throw Error('Network prohibited');}}));
vi.mock('../src/env.js',()=>({env:{}}));
vi.mock('../src/utils/logger.js',()=>({logger:{error:vi.fn()}}));
import {updateAotTaskStatus} from '../src/agents/tools/aot-notion-tools.js';
const task='00000000-0000-4000-8000-000000000003';
function fixture(){let state='In Progress';const sequence:string[]=[];const pages={retrieve:vi.fn(async()=>{sequence.push('read');return {properties:{RenamedStatus:{id:'vdOD',type:'status',status:{name:state}},'Task name ':{title:[{plain_text:'Send Brief to Client'}]}}};}),update:vi.fn(async(input:any)=>{sequence.push('write');expect(input.properties).toEqual({vdOD:{status:{name:'Done'}}});state='Done';return {};})};const guard=vi.fn(async()=>{sequence.push('guard');});return {pages,sequence,guard,options:{expectedStatus:'In Progress',beforeWrite:guard,notion:{pages} as never,propertyId:'vdOD' as const}};}
describe('Designated Piper writer trusted options',()=>{
 it('uses stable operational property, guards immediately before exactly one write, and independently rereads',async()=>{const f=fixture();expect(await updateAotTaskStatus({task_id:task,new_status:'Done'},f.options)).toMatchObject({ok:true,task_id:task.replace(/-/g,''),verified:true,before:'In Progress',after:'Done'});expect(f.sequence).toEqual(['read','guard','write','read']);expect(f.pages.update).toHaveBeenCalledOnce();});
 it('refuses precondition mismatch before guard or update',async()=>{const f=fixture();f.options.expectedStatus='Blocked';expect(await updateAotTaskStatus({task_id:task,new_status:'Done'},f.options)).toMatchObject({ok:false,verified:false});expect(f.guard).not.toHaveBeenCalled();expect(f.pages.update).not.toHaveBeenCalled();});
 it('never calls update if final authority guard fails',async()=>{const f=fixture();f.guard.mockRejectedValue(Error('Stale authority'));expect(await updateAotTaskStatus({task_id:task,new_status:'Done'},f.options)).toMatchObject({ok:false});expect(f.pages.update).not.toHaveBeenCalled();});
 it('does not retry a lost write response or fabricate readback',async()=>{const f=fixture();f.pages.update.mockRejectedValue(Error('Lost response'));expect(await updateAotTaskStatus({task_id:task,new_status:'Done'},f.options)).toMatchObject({ok:false});expect(f.pages.update).toHaveBeenCalledOnce();expect(f.pages.retrieve).toHaveBeenCalledOnce();});
});
