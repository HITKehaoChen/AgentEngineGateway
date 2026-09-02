import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import type { AddressInfo } from "node:net";
import type http from "node:http";
import { createServer } from "../src/api/server.js";
import type { GatewayConfig } from "../src/config/config.js";
import { Gateway } from "../src/gateway/gateway.js";
import { FakeAdapter, type FakeStep } from "../src/harness/fake-adapter.js";

let adapter:FakeAdapter;let gateway:Gateway;let server:http.Server;let base:string;let config:GatewayConfig;

beforeEach(async()=>{
  adapter=new FakeAdapter();config={host:"127.0.0.1",port:6217,engine:"fake",defaultDirectory:process.cwd(),runTimeoutMs:500,maxSessions:4,maxRequestBytes:1_048_576,heartbeatMs:25,model:{providerId:"fake",modelId:"fake",credentialRef:"none"}};
  await adapter.start({command:"fake",version:"1.0.0",model:config.model,startupTimeoutMs:100,healthTimeoutMs:100});gateway=new Gateway(adapter,{maxSessions:config.maxSessions,runTimeoutMs:config.runTimeoutMs,heartbeatMs:config.heartbeatMs});server=createServer(gateway,config);await new Promise<void>((resolve)=>server.listen(0,"127.0.0.1",resolve));base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async()=>{await new Promise<void>((resolve,reject)=>server.close((e)=>e?reject(e):resolve()));await adapter.stop();});

async function request(path:string,init?:RequestInit){return fetch(base+path,{...init,headers:{"content-type":"application/json",...init?.headers}});}
async function session(title="测试会话"){const r=await request(`/session?directory=${encodeURIComponent(process.cwd())}`,{method:"POST",body:JSON.stringify({title})});assert.equal(r.status,200);return r.json() as Promise<{id:string}>;}
const promptBody=JSON.stringify({parts:[{type:"text",text:"你好，C:\\中文路径"}],model:{providerID:"test",modelID:"model"},agent:"assistant"});
async function waitFor(path:string,predicate:(value:any)=>boolean){for(let i=0;i<50;i++){const value=await (await request(path)).json();if(predicate(value))return value;await new Promise(r=>setTimeout(r,5));}throw new Error(`Timed out waiting for ${path}`);}

test("FR-003/004 session API keeps stable Gateway IDs and validates input",async()=>{
  const created=await session();assert.match(created.id,/^ses_/);const got=await (await request(`/session/${created.id}`)).json() as any;assert.equal(got.id,created.id);assert.equal(got.status,"idle");
  const statuses=await (await request("/session/status")).json() as any;assert.equal(statuses[created.id].type,"idle");assert.equal((await request("/session",{method:"POST",body:"{}"})).status,400);
  assert.equal((await request(`/session/${created.id}`,{method:"DELETE"})).status,200);assert.equal((await request(`/session/${created.id}`)).status,404);
});

test("FR-005 allows one active run per session but isolates sessions",async()=>{
  const a=await session("A"),b=await session("B");const slow:FakeStep[]=[{type:"run.started"},{type:"delay",ms:80},{type:"run.settled"}];adapter.enqueue(slow);adapter.enqueue([{type:"run.started"},{type:"run.settled"}]);
  const first=request(`/session/${a.id}/prompt_async`,{method:"POST",body:promptBody});await waitFor("/session/status",x=>x[a.id]?.type==="busy");const conflict=await request(`/session/${a.id}/prompt_async`,{method:"POST",body:promptBody});assert.equal(conflict.status,409);assert.equal((await request(`/session/${b.id}/prompt_async`,{method:"POST",body:promptBody})).status,204);assert.equal((await first).status,204);
});

test("FR-006 projects text snapshots, multiple tool steps and final completion",async()=>{
  const s=await session();adapter.enqueue([{type:"run.started"},{type:"text.delta",messageRef:"m",delta:"你"},{type:"text.delta",messageRef:"m",delta:"好"},{type:"tool.started",callRef:"c1",name:"read",title:"读取",args:{path:"a"}},{type:"tool.completed",callRef:"c1",title:"完成",output:"内容",isError:false},{type:"step.finished",finish:"tool-calls"},{type:"tool.started",callRef:"c2",name:"write",args:{}},{type:"tool.completed",callRef:"c2",output:{ok:true},isError:false},{type:"step.finished",finish:"stop"},{type:"run.settled"}]);
  assert.equal((await request(`/session/${s.id}/prompt_async`,{method:"POST",body:promptBody})).status,204);const messages=await (await request(`/session/${s.id}/message`)).json() as any[];assert.equal(messages[0].content,"你好，C:\\中文路径");const assistant=messages.find(x=>x.role==="assistant");assert.equal(assistant.content,"你好");assert.equal(assistant.tool_calls.length,2);assert.equal(assistant.info.finish,"stop");assert.ok(assistant.parts.some((x:any)=>x.type==="step-finish"));assert.equal(messages.filter(x=>x.role==="tool").length,2);
});

test("FR-006 tolerates out-of-order and duplicate tool events without duplicating results",async()=>{
  const s=await session();const completed={type:"tool.completed",callRef:"late",title:"完成",output:"once",isError:false} as const;adapter.enqueue([{type:"run.started"},{type:"tool.updated",callRef:"late",title:"先更新",output:"partial"},completed,completed,{type:"tool.updated",callRef:"late",title:"冲突更新",output:"twice"},{type:"run.settled"}]);assert.equal((await request(`/session/${s.id}/prompt_async`,{method:"POST",body:promptBody})).status,204);const messages=await (await request(`/session/${s.id}/message`)).json() as any[];assert.equal(messages.filter(x=>x.role==="tool").length,1);assert.equal(messages.find(x=>x.role==="tool").content,"once");
});

test("FR-007 question remains pending while busy and resumes after idempotent reply",async()=>{
  const s=await session();const ref={opaqueId:"q1"};adapter.enqueue([{type:"run.started"},{type:"question.requested",interactionRef:ref,questions:[{question:"选择？",options:[{label:"A"}]}]},{type:"wait.question",ref:"q1"},{type:"text.delta",messageRef:"m",delta:"完成"},{type:"run.settled"}]);const running=request(`/session/${s.id}/prompt_async`,{method:"POST",body:promptBody});const questions=await waitFor("/question",x=>x.length===1) as any[];assert.equal((await (await request("/session/status")).json() as any)[s.id].type,"busy");const body=JSON.stringify({answers:[["A"]]});assert.equal((await request(`/question/${questions[0].id}/reply`,{method:"POST",body})).status,200);assert.equal((await request(`/question/${questions[0].id}/reply`,{method:"POST",body})).status,200);assert.equal((await running).status,204);assert.deepEqual(await (await request("/question")).json(),[]);
});

test("resolved interactions reject a conflicting second reply",async()=>{
  const s=await session();adapter.enqueue([{type:"run.started"},{type:"question.requested",interactionRef:{opaqueId:"q-conflict"},questions:[{question:"选择？",options:[]}]},{type:"wait.question",ref:"q-conflict"},{type:"delay",ms:30},{type:"run.settled"}]);const running=request(`/session/${s.id}/prompt_async`,{method:"POST",body:promptBody});const questions=await waitFor("/question",x=>x.length===1) as any[];const url=`/question/${questions[0].id}/reply`;assert.equal((await request(url,{method:"POST",body:JSON.stringify({answers:[["A"]]})})).status,200);const conflict=await request(url,{method:"POST",body:JSON.stringify({answers:[["B"]]})});assert.equal(conflict.status,409);assert.equal((await conflict.json() as any).code,"INTERACTION_RESOLVED");await running;
});

test("FR-008 permission query/reply resumes run",async()=>{
  const s=await session();adapter.enqueue([{type:"run.started"},{type:"permission.requested",interactionRef:{opaqueId:"p1"},permission:"file.write",patterns:["C:\\测试.txt"]},{type:"wait.permission",ref:"p1"},{type:"run.settled"}]);const running=request(`/session/${s.id}/prompt_async`,{method:"POST",body:promptBody});const permissions=await waitFor("/permission",x=>x.length===1) as any[];assert.equal(permissions[0].permission,"file.write");assert.equal((await request(`/permission/${permissions[0].id}/reply`,{method:"POST",body:JSON.stringify({reply:"once"})})).status,200);assert.equal((await running).status,204);
});

test("FR-009 abort and stop are idempotent, restore idle, and ignore late events",async()=>{
  const s=await session();adapter.enqueue([{type:"run.started"},{type:"text.delta",messageRef:"m",delta:"部分"},{type:"wait.abort"},{type:"text.delta",messageRef:"m",delta:"迟到"},{type:"run.settled"}]);const running=request(`/session/${s.id}/prompt_async`,{method:"POST",body:promptBody});await waitFor("/session/status",x=>x[s.id]?.type==="busy");assert.equal((await request(`/session/${s.id}/abort`,{method:"POST"})).status,200);assert.equal((await running).status,204);assert.equal((await request(`/session/${s.id}/stop`,{method:"POST"})).status,200);const messages=await (await request(`/session/${s.id}/message`)).json() as any[];assert.equal(messages.find(x=>x.role==="assistant").content,"部分");assert.equal((await (await request("/session/status")).json() as any)[s.id].type,"idle");
});

test("FR-010 SSE sends connected, event snapshots, and heartbeat",async()=>{
  const response=await fetch(base+"/event",{headers:{accept:"text/event-stream"}});assert.equal(response.status,200);assert.match(response.headers.get("content-type")??"",/text\/event-stream/);const s=await session();adapter.enqueue([{type:"run.started"},{type:"text.delta",messageRef:"m",delta:"流式"},{type:"run.settled"}]);const running=request(`/session/${s.id}/prompt_async`,{method:"POST",body:promptBody});const reader=response.body!.getReader();const decoder=new TextDecoder();let text="";const deadline=Date.now()+500;while(Date.now()<deadline&&(!text.includes("server.heartbeat")||!text.includes("session.idle"))){const result=await reader.read();if(result.done)break;text+=decoder.decode(result.value);}await running;await reader.cancel();assert.match(text,/server.connected/);assert.match(text,/server.heartbeat/);assert.match(text,/session.status/);assert.match(text,/message.part.updated/);assert.match(text,/session.idle/);assert.match(text,/流式/);
});

test("error, timeout, capacity, malformed JSON, and not-found mappings are canonical",async()=>{
  const s=await session();adapter.enqueue([{type:"run.started"},{type:"run.failed",error:{code:"UPSTREAM_ERROR",message:"upstream failed",retryable:true}}]);let r=await request(`/session/${s.id}/prompt_async`,{method:"POST",body:promptBody});assert.equal(r.status,502);assert.equal((await r.json() as any).code,"BAD_GATEWAY");r=await request("/missing");assert.equal(r.status,404);r=await request("/session",{method:"POST",body:"{"});assert.equal(r.status,400);
  await session("2");await session("3");await session("4");r=await request("/session",{method:"POST",body:JSON.stringify({title:"5"})});assert.equal(r.status,503);assert.equal((await r.json() as any).code,"CAPACITY_EXCEEDED");
});

test("engine unavailability maps to 503 for create and run",async()=>{
  adapter.failNextCreate();let response=await request("/session",{method:"POST",body:JSON.stringify({title:"unavailable"})});assert.equal(response.status,503);assert.equal((await response.json() as any).code,"SERVICE_UNAVAILABLE");const s=await session();adapter.enqueue([{type:"run.started"},{type:"run.failed",error:{code:"UNAVAILABLE",message:"engine exited",retryable:true}}]);response=await request(`/session/${s.id}/prompt_async`,{method:"POST",body:promptBody});assert.equal(response.status,503);assert.equal((await response.json() as any).code,"SERVICE_UNAVAILABLE");assert.equal((await (await request("/session/status")).json() as any)[s.id].type,"idle");
});

test("Phase 4 fault injection isolates a failed session from a healthy session",async()=>{
  const failed=await session("故障会话"),healthy=await session("健康会话");
  adapter.enqueue([{type:"run.started"},{type:"run.failed",error:{code:"UNAVAILABLE",message:"injected engine exit",retryable:true}}]);
  adapter.enqueue([{type:"run.started"},{type:"text.delta",messageRef:"healthy",delta:"仍可用"},{type:"run.settled"}]);
  const failedRun=request(`/session/${failed.id}/prompt_async`,{method:"POST",body:promptBody});
  assert.equal((await failedRun).status,503);
  const healthyRun=request(`/session/${healthy.id}/prompt_async`,{method:"POST",body:promptBody});
  assert.equal((await healthyRun).status,204);
  const statuses=await (await request("/session/status")).json() as any;
  assert.equal(statuses[failed.id].type,"idle");assert.equal(statuses[healthy.id].type,"idle");
  const messages=await (await request(`/session/${healthy.id}/message`)).json() as any[];
  assert.equal(messages.find((message)=>message.role==="assistant").content,"仍可用");
});

test("malformed canonical engine events fail internally instead of being ignored",async()=>{
  const s=await session();adapter.enqueue([{type:"run.started"},{type:"text.delta",messageRef:42,delta:"invalid"} as unknown as FakeStep,{type:"run.settled"}]);const response=await request(`/session/${s.id}/prompt_async`,{method:"POST",body:promptBody});assert.equal(response.status,500);assert.equal((await response.json() as any).code,"INTERNAL_ERROR");assert.equal((await (await request("/session/status")).json() as any)[s.id].type,"idle");
});

test("run timeout emits canonical error and always releases busy",async()=>{
  config.runTimeoutMs=20;const timeoutGateway=new Gateway(adapter,{maxSessions:4,runTimeoutMs:20,heartbeatMs:25});await new Promise<void>((resolve)=>server.close(()=>resolve()));server=createServer(timeoutGateway,config);gateway=timeoutGateway;await new Promise<void>((resolve)=>server.listen(0,"127.0.0.1",resolve));base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const s=await session();adapter.enqueue([{type:"run.started"},{type:"delay",ms:100},{type:"run.settled"}]);const response=await request(`/session/${s.id}/prompt_async`,{method:"POST",body:promptBody});assert.equal(response.status,504);assert.equal((await response.json() as any).code,"RUN_TIMEOUT");assert.equal((await (await request("/session/status")).json() as any)[s.id].type,"idle");
});
