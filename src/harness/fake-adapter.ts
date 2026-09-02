import { randomUUID } from "node:crypto";
import type { EngineConfig, EngineEvent, EngineEventSink, EngineInteractionRef, EngineSessionRef, HarnessAdapter, PermissionDecision, RunInput, RunResult, SessionContext } from "../model/types.js";

export type FakeStep = EngineEvent | { type:"delay"; ms:number } | { type:"wait.question"; ref:string } | { type:"wait.permission"; ref:string } | { type:"wait.abort" };

export class FakeAdapter implements HarnessAdapter {
  readonly name="fake"; private started=false; private stopped=false; private failCreate=false; private scripts: FakeStep[][]=[]; private readonly gates=new Map<string,()=>void>(); private readonly controllers=new Map<string,AbortSignal>();
  enqueue(script:FakeStep[]):void { this.scripts.push(script); }
  failNextCreate():void { this.failCreate=true; }
  async start(_config:EngineConfig):Promise<void>{this.started=true;this.stopped=false;}
  async health(){return {ok:this.started&&!this.stopped,version:"1.0.0"};}
  async createSession(_context:SessionContext):Promise<EngineSessionRef>{if(this.failCreate){this.failCreate=false;throw new Error("Fake adapter unavailable");}if(!this.started||this.stopped)throw new Error("Fake adapter unavailable");return {opaqueId:`fake_${randomUUID()}`};}
  async run(session:EngineSessionRef,_input:RunInput,sink:EngineEventSink,signal:AbortSignal):Promise<RunResult>{
    const script=this.scripts.shift()??[{type:"run.started"},{type:"text.delta",messageRef:"main",delta:"ok"},{type:"step.finished",finish:"stop"},{type:"run.settled"}]; this.controllers.set(session.opaqueId,signal);
    for(const step of script){
      if(signal.aborted){await sink({type:"run.aborted"});return {state:"aborted"};}
      if(step.type==="delay") await new Promise<void>((resolve)=>setTimeout(resolve,step.ms));
      else if(step.type==="wait.question"||step.type==="wait.permission") await this.wait(step.ref,signal);
      else if(step.type==="wait.abort") await this.wait(`abort:${session.opaqueId}`,signal);
      else await sink(step);
    }
    this.controllers.delete(session.opaqueId); const terminal=[...script].reverse().find((x):x is EngineEvent=>!x.type.startsWith("wait.")&&x.type!=="delay"&&["run.settled","run.failed","run.aborted"].includes(x.type));
    if(terminal?.type==="run.settled")return {state:"completed"}; if(terminal?.type==="run.failed")return {state:"failed",error:terminal.error}; return {state:"aborted"};
  }
  async replyQuestion(_session:EngineSessionRef,interaction:EngineInteractionRef,_answers:string[][]){this.release(interaction.opaqueId);}
  async replyPermission(_session:EngineSessionRef,interaction:EngineInteractionRef,_decision:PermissionDecision){this.release(interaction.opaqueId);}
  async abort(session:EngineSessionRef){this.release(`abort:${session.opaqueId}`);}
  async deleteSession(_session:EngineSessionRef){}
  async stop(){this.stopped=true; for(const release of this.gates.values())release(); this.gates.clear();}
  private wait(ref:string,signal:AbortSignal):Promise<void>{return new Promise((resolve)=>{const done=()=>{this.gates.delete(ref);resolve();};this.gates.set(ref,done);signal.addEventListener("abort",done,{once:true});});}
  private release(ref:string){this.gates.get(ref)?.();}
}
