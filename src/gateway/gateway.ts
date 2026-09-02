import fs from "node:fs";
import path from "node:path";
import { GatewayError } from "../model/errors.js";
import type { HarnessAdapter, PermissionDecision, ResolvedModel } from "../model/types.js";
import { EventHub } from "./event-hub.js";
import { InteractionBroker } from "./interaction-broker.js";
import { MessageProjector } from "./message-projector.js";
import { RunCoordinator } from "./run-coordinator.js";
import { SessionRegistry } from "./session-registry.js";

export class Gateway {
  readonly registry:SessionRegistry; readonly hub:EventHub; readonly broker:InteractionBroker; readonly coordinator:RunCoordinator;
  constructor(readonly adapter:HarnessAdapter,options:{maxSessions:number;runTimeoutMs:number;heartbeatMs:number}){this.registry=new SessionRegistry(options.maxSessions);this.hub=new EventHub(options.heartbeatMs);const projector=new MessageProjector((event)=>this.hub.emit(event));this.broker=new InteractionBroker(adapter);this.coordinator=new RunCoordinator(this.registry,adapter,this.hub,projector,this.broker,options.runTimeoutMs);}
  async createSession(title:string,directory:string){if(typeof title!=="string"||!title.trim())throw new GatewayError(400,"VALIDATION_ERROR","title is required");this.validateDirectory(directory);this.registry.assertCapacity();const id=this.registry.newId();let engineSession;try{engineSession=await this.adapter.createSession({gatewaySessionId:id,title:title.trim(),directory});}catch{throw new GatewayError(503,"SERVICE_UNAVAILABLE","Engine is unavailable");}try{return this.registry.register(title.trim(),directory,this.adapter.name,engineSession,id);}catch(error){await this.adapter.deleteSession(engineSession);throw error;}}
  session(id:string){const s=this.registry.get(id);return {id:s.id,title:s.title,created_at:s.createdAt,status:s.status,message_count:s.messages.length};}
  statuses(){return Object.fromEntries(this.registry.all().map((s)=>[s.id,{type:s.status}]));}
  messages(id:string){return this.registry.get(id).messages.map((m)=>({id:m.id,role:m.role,content:m.content,...(m.toolCalls?.length?{tool_calls:m.toolCalls.map(x=>({id:x.id,name:x.name,arguments:x.arguments}))}:{}),...(m.toolCallId?{tool_call_id:m.toolCallId,tool_name:m.toolName}:{}),created_at:m.createdAt,...(m.info?{info:m.info}:{}),...(m.parts?{parts:m.parts.map((p)=>p.type==="tool"?{type:p.type,tool:p.tool,state:p.state}:p)}:{})}));}
  async prompt(id:string,text:string,model:ResolvedModel){await this.coordinator.prompt(id,text,model);}
  async abort(id:string){await this.coordinator.abort(id);}
  async delete(id:string){const s=this.registry.markDeleting(id);let firstError:unknown;try{await this.coordinator.delete(s);}catch(error){firstError=error;}try{await this.adapter.deleteSession(s.engineSession);}catch(error){firstError??=error;}finally{this.registry.remove(id);}if(firstError)throw firstError;}
  async replyQuestion(id:string,answers:string[][]){const x=this.broker.get(id);const session=this.registry.get(x.sessionId);await this.broker.replyQuestion(id,answers,session);this.coordinator.resume(x.runId);}
  async replyPermission(id:string,decision:PermissionDecision){const x=this.broker.get(id);const session=this.registry.get(x.sessionId);await this.broker.replyPermission(id,decision,session);this.coordinator.resume(x.runId);}
  private validateDirectory(directory:string){if(typeof directory!=="string"||!directory)throw new GatewayError(400,"VALIDATION_ERROR","directory is required");if(!path.isAbsolute(directory))throw new GatewayError(400,"VALIDATION_ERROR","directory must be an absolute path");try{if(!fs.statSync(directory).isDirectory())throw new Error();fs.accessSync(directory);}catch{throw new GatewayError(400,"VALIDATION_ERROR","directory must exist and be accessible");}}
}
