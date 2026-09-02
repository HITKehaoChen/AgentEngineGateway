import { randomUUID } from "node:crypto";
import { GatewayError, fromEngineError } from "../model/errors.js";
import { isEngineEvent, type EngineError, type EngineEvent, type GatewayEvent, type GatewayRun, type GatewaySession, type HarnessAdapter, type ResolvedModel, type RunResult } from "../model/types.js";
import { EventHub } from "./event-hub.js";
import { InteractionBroker } from "./interaction-broker.js";
import { MessageProjector } from "./message-projector.js";
import { SessionRegistry } from "./session-registry.js";

interface Active { run: GatewayRun; session: GatewaySession; controller: AbortController; terminal?: RunResult; finalized: boolean }

export class RunCoordinator {
  private readonly active = new Map<string, Active>();
  constructor(private readonly registry: SessionRegistry, private readonly adapter: HarnessAdapter, private readonly hub: EventHub, private readonly projector: MessageProjector, readonly broker: InteractionBroker, private readonly timeoutMs: number) {}

  async prompt(sessionId: string, text: string, model: ResolvedModel): Promise<void> {
    const session=this.registry.get(sessionId);
    if(session.status==="busy" || session.activeRunId) throw new GatewayError(409,"SESSION_BUSY","Session is busy");
    const run: GatewayRun={id:`run_${randomUUID()}`,sessionId,state:"accepted",startedAt:new Date().toISOString()};
    const active: Active={run,session,controller:new AbortController(),finalized:false}; this.active.set(run.id,active);
    session.activeRunId=run.id; session.status="busy"; this.projector.addUser(session,run.id,text); this.status(session,"busy");
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<RunResult>((resolve)=>{ timer=setTimeout(()=>{ const error:EngineError={code:"TIMEOUT",message:"Run timed out",retryable:true}; this.commit(active,{state:"failed",error}); active.controller.abort(); void this.adapter.abort(session.engineSession); resolve({state:"failed",error}); },this.timeoutMs); });
    const execution = this.adapter.run(session.engineSession,{gatewayRunId:run.id,text,model},(event)=>this.onEvent(active,event),active.controller.signal)
      .catch((cause:unknown):RunResult=>{ const error:EngineError={code:"UPSTREAM_ERROR",message:cause instanceof Error?cause.message:"Engine run failed",retryable:true,cause}; this.commit(active,{state:"failed",error}); return {state:"failed",error}; });
    let result: RunResult;
    try {
      result=await Promise.race([execution,timeout]);
      if(!active.terminal) this.commit(active,{state:"failed",error:{code:"INTERNAL",message:"Adapter returned before a terminal event",retryable:false}});
      if(!this.same(active.terminal!,result) && !(active.terminal?.state==="failed"&&active.terminal.error.code==="TIMEOUT")) this.commit(active,{state:"failed",error:{code:"INTERNAL",message:"Adapter result did not match terminal event",retryable:false}},true);
    } finally { if(timer) clearTimeout(timer); this.finalize(active); }
    const terminal=active.terminal!; if(terminal.state==="failed") throw fromEngineError(terminal.error);
  }

  async abort(sessionId: string): Promise<void> {
    const session=this.registry.get(sessionId); if(!session.activeRunId) return;
    const active=this.active.get(session.activeRunId); if(!active) return;
    this.commit(active,{state:"aborted"}); active.controller.abort();
    try { await this.adapter.abort(session.engineSession); } finally { this.finalize(active); }
  }

  async delete(session: GatewaySession): Promise<void> { if(session.activeRunId){ const active=this.active.get(session.activeRunId); if(active){ this.commit(active,{state:"aborted"}); active.controller.abort(); try { await this.adapter.abort(session.engineSession); } finally { this.finalize(active); } } } this.broker.removeSession(session.id); }
  resume(runId:string):void { const active=this.active.get(runId); if(active&&!active.terminal&&(active.run.state==="waiting_question"||active.run.state==="waiting_permission")) active.run.state="running"; }

  private async onEvent(active: Active,event: EngineEvent): Promise<void> {
    if(active.terminal) return;
    if(!isEngineEvent(event)){const error:EngineError={code:"INTERNAL",message:"Adapter emitted an invalid canonical event",retryable:false};this.commit(active,{state:"failed",error});active.controller.abort();void this.adapter.abort(active.session.engineSession);throw new Error(error.message);}
    const {run,session}=active;
    switch(event.type){
      case "run.started": run.state="running"; break;
      case "text.delta": case "tool.started": case "tool.updated": case "tool.completed": case "step.finished": this.projector.apply(session,run.id,event); break;
      case "question.requested": { const x=this.broker.create(session,run.id,event); run.state="waiting_question"; this.hub.emit({type:"question.asked",properties:{sessionID:session.id,id:x.id,questions:x.payload}}); break; }
      case "permission.requested": { const x=this.broker.create(session,run.id,event); run.state="waiting_permission"; const payload=x.payload as {permission:string;patterns:string[]}; this.hub.emit({type:"permission.asked",properties:{sessionID:session.id,id:x.id,...payload}}); break; }
      case "run.settled": this.projector.settle(session,run.id); this.commit(active,{state:"completed"}); break;
      case "run.failed": this.commit(active,{state:"failed",error:event.error}); break;
      case "run.aborted": this.commit(active,{state:"aborted"}); break;
    }
  }
  private commit(active:Active,result:RunResult,force=false):void { if(active.terminal&&!force)return; active.terminal=result; active.run.state=result.state; active.run.finishedAt=new Date().toISOString(); if(result.state==="failed") active.run.error={code:result.error.code,message:result.error.message}; }
  private finalize(active:Active):void { if(active.finalized)return; active.finalized=true; this.broker.expireRun(active.run.id); active.session.pendingInteractionIds=[]; if(active.session.activeRunId===active.run.id) delete active.session.activeRunId; if(!active.session.deleting){ active.session.status="idle"; if(active.terminal?.state==="failed") this.hub.emit({type:"session.error",properties:{sessionID:active.session.id,error:{message:active.terminal.error.message}}}); this.status(active.session,"idle"); this.hub.emit({type:"session.idle",properties:{sessionID:active.session.id}}); } this.projector.finish(active.run.id); this.active.delete(active.run.id); }
  private status(session:GatewaySession,type:"idle"|"busy"):void { this.hub.emit({type:"session.status",properties:{sessionID:session.id,status:{type}}}); }
  private same(a:RunResult,b:RunResult):boolean { return a.state===b.state && (a.state!=="failed" || (b.state==="failed"&&a.error.code===b.error.code)); }
}
