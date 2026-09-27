import {expect,it} from 'vitest';
import {desktopToolOverrides,prepareResumeTools} from '../../../src/desktop/resume-tools';

it('wires the native first resume before it can load a task without desktop tools',async()=>{
  let finish!:(config:Record<string,unknown>)=>void;
  const waiting=new Promise<Record<string,unknown>>(r=>{finish=r;});let forwarded=false;
  const request={id:'native-resume',method:'thread/resume',params:{threadId:'bound',approvalPolicy:'on-request',approvalsReviewer:'user',config:{model:'keep'}}};
  const result=prepareResumeTools(request,new Set(['bound']),()=>waiting).then(r=>{forwarded=true;return r;});
  await Promise.resolve();expect(forwarded).toBe(false);
  const definition={command:'node',default_tools_approval_mode:'approve',tools:{create_thread:{approval_mode:'prompt'}},env:{KEEP:'yes'}};
  finish(desktopToolOverrides(definition,'verified-pipe'));
  const prepared=await result;
  expect(prepared.id).toBe(request.id);expect(prepared.params.approvalPolicy).toBe('on-request');expect(prepared.params.approvalsReviewer).toBe('user');
  expect(prepared.params.config.model).toBe('keep');
  expect(prepared.params.config['mcp_servers.codex_app']).toEqual({...definition,enabled:true,env:{KEEP:'yes',CODEX_APP_TOOLS_PIPE_PATH:'verified-pipe'}});
  expect(request.params.config).toEqual({model:'keep'});
});

it('does not change unbound tasks, new-task creation, or approval replies',async()=>{
  for(const request of [{id:1,method:'thread/resume',params:{threadId:'other'}},{id:2,method:'thread/start',params:{}},{id:3,result:{decision:'decline'}}]){
    expect(await prepareResumeTools(request,new Set(['bound']),async()=>{throw Error('must not probe');})).toBe(request);
  }
});

it('fails closed when verified wiring is unavailable',async()=>{
  await expect(prepareResumeTools({id:1,method:'thread/resume',params:{threadId:'bound'}},new Set(['bound']),async()=>{throw Error('pipe unavailable');})).rejects.toThrow('pipe unavailable');
});

it('preserves an active task resume without refreshing tools during its running turn',async()=>{
  const request={id:1,method:'thread/resume',params:{threadId:'bound',excludeTurns:true}};
  expect(await prepareResumeTools(request,new Set(['bound']),async()=>{throw Error('must not change active tools');},async()=>true)).toBe(request);
  await expect(prepareResumeTools(request,new Set(['bound']),async()=>({}),async()=>{throw Error('unknown task state');})).rejects.toThrow('unknown task state');
});
