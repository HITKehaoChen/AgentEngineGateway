import path from "node:path";
import type { ResolvedModel } from "../model/types.js";
import { GatewayError } from "../model/errors.js";

export interface GatewayConfig { host:string; port:number; engine:string; defaultDirectory:string; runTimeoutMs:number; maxSessions:number; maxRequestBytes:number; heartbeatMs:number; model:ResolvedModel; engineStartupTimeoutMs?:number; engineHealthTimeoutMs?:number; abortGraceMs?:number; piControlTimeoutMs?:number }

export function loadConfig(argv=process.argv.slice(2),env=process.env):GatewayConfig{
  const args=new Map<string,string>();
  for(let i=0;i<argv.length;i+=2){const key=argv[i],value=argv[i+1];if(!key?.startsWith("--")||value===undefined)throw new Error(`Unknown or incomplete argument: ${key??""}`);if(!["--engine","--host","--port"].includes(key))throw new Error(`Unknown argument: ${key}`);args.set(key,value);}
  const positive=(name:string,value:string|undefined,fallback:number)=>{const n=value===undefined?fallback:Number(value);if(!Number.isSafeInteger(n)||n<=0)throw new Error(`${name} must be a positive integer`);return n;};
  const engine=args.get("--engine")??env.AGENT_ENGINE??"fake";if(!["fake","opencode","pi"].includes(engine))throw new Error(`Unknown engine '${engine}'. Supported: fake, opencode, pi`);
  return {host:args.get("--host")??env.GATEWAY_HOST??"localhost",port:positive("port",args.get("--port")??env.GATEWAY_PORT,6217),engine,defaultDirectory:path.resolve(env.GATEWAY_DEFAULT_DIRECTORY??process.cwd()),runTimeoutMs:positive("GATEWAY_RUN_TIMEOUT_MS",env.GATEWAY_RUN_TIMEOUT_MS,1_800_000),maxSessions:positive("GATEWAY_MAX_SESSIONS",env.GATEWAY_MAX_SESSIONS,32),maxRequestBytes:positive("GATEWAY_MAX_REQUEST_BYTES",env.GATEWAY_MAX_REQUEST_BYTES,1_048_576),heartbeatMs:positive("GATEWAY_HEARTBEAT_MS",env.GATEWAY_HEARTBEAT_MS,15_000),engineStartupTimeoutMs:positive("GATEWAY_ENGINE_STARTUP_TIMEOUT_MS",env.GATEWAY_ENGINE_STARTUP_TIMEOUT_MS,60_000),engineHealthTimeoutMs:positive("GATEWAY_ENGINE_HEALTH_TIMEOUT_MS",env.GATEWAY_ENGINE_HEALTH_TIMEOUT_MS,5_000),abortGraceMs:positive("GATEWAY_ABORT_GRACE_MS",env.GATEWAY_ABORT_GRACE_MS,10_000),piControlTimeoutMs:positive("PI_CONTROL_TIMEOUT_MS",env.PI_CONTROL_TIMEOUT_MS,5_000),model:{providerId:env.MODEL_PROVIDER_ID??"fake-provider",modelId:env.MODEL_ID??"fake-model",...(env.MODEL_BASE_URL?{baseUrl:env.MODEL_BASE_URL}:{}),credentialRef:env.MODEL_API_KEY?"env:MODEL_API_KEY":"none"}};
}

export function resolveModel(body:unknown,configured:ResolvedModel):ResolvedModel{
  if(!body||typeof body!=="object")throw new GatewayError(400,"VALIDATION_ERROR","model is required");
  const value=body as Record<string,unknown>;if(typeof value.providerID!=="string"||!value.providerID||typeof value.modelID!=="string"||!value.modelID)throw new GatewayError(400,"VALIDATION_ERROR","model.providerID and model.modelID are required");
  return configured.credentialRef!=="none"?configured:{providerId:value.providerID,modelId:value.modelID,credentialRef:"none"};
}
