import { randomUUID } from "node:crypto";
import { GatewayError } from "../model/errors.js";
import type { EngineEvent, GatewayInteraction, GatewaySession, HarnessAdapter, PermissionDecision } from "../model/types.js";

export class InteractionBroker {
  private readonly interactions = new Map<string, GatewayInteraction>();
  constructor(private readonly adapter: HarnessAdapter) {}

  create(session: GatewaySession, runId: string, event: Extract<EngineEvent,{type:"question.requested"|"permission.requested"}>): GatewayInteraction {
    const interaction: GatewayInteraction = { id: `${event.type.startsWith("question") ? "req" : "perm"}_${randomUUID()}`, sessionId: session.id, runId, kind: event.type.startsWith("question") ? "question" : "permission", engineRef: event.interactionRef, state: "pending", payload: event.type === "question.requested" ? event.questions : { permission: event.permission, patterns: event.patterns }, createdAt: new Date().toISOString() };
    this.interactions.set(interaction.id, interaction); session.pendingInteractionIds.push(interaction.id); return interaction;
  }

  questions(): unknown[] { return [...this.interactions.values()].filter((x)=>x.kind==="question"&&x.state==="pending").map((x)=>({ id:x.id, sessionID:x.sessionId, questions:x.payload, created_at:x.createdAt })); }
  permissions(): unknown[] { return [...this.interactions.values()].filter((x)=>x.kind==="permission"&&x.state==="pending").map((x)=>({ id:x.id, sessionID:x.sessionId, ...(x.payload as object), created_at:x.createdAt })); }

  async replyQuestion(id: string, answers: string[][], session: GatewaySession): Promise<void> {
    const interaction = this.requireKind(id, "question"); const fingerprint=JSON.stringify(answers); if(!this.claim(interaction, fingerprint, "answered")) return;
    await this.adapter.replyQuestion(session.engineSession, interaction.engineRef, answers);
  }
  async replyPermission(id: string, decision: PermissionDecision, session: GatewaySession): Promise<void> {
    const interaction = this.requireKind(id, "permission"); const fingerprint=JSON.stringify(decision); if(!this.claim(interaction, fingerprint, decision.reply === "reject" ? "rejected" : "answered")) return;
    await this.adapter.replyPermission(session.engineSession, interaction.engineRef, decision);
  }
  get(id: string): GatewayInteraction { const value=this.interactions.get(id); if(!value) throw new GatewayError(404,"NOT_FOUND","Interaction not found"); return value; }
  expireRun(runId: string): void { for(const x of this.interactions.values()) if(x.runId===runId&&x.state==="pending") x.state="expired"; }
  removeSession(sessionId: string): void { for(const [id,x] of this.interactions) if(x.sessionId===sessionId) this.interactions.delete(id); }

  private requireKind(id: string, kind: "question"|"permission"): GatewayInteraction { const x=this.get(id); if(x.kind!==kind) throw new GatewayError(404,"NOT_FOUND","Interaction not found"); return x; }
  private claim(x: GatewayInteraction, fingerprint: string, state: "answered"|"rejected"): boolean {
    if (x.state !== "pending") { if (x.responseFingerprint === fingerprint) return false; throw new GatewayError(409,"INTERACTION_RESOLVED","Interaction already resolved"); }
    x.responseFingerprint=fingerprint; x.state=state; return true;
  }
}
