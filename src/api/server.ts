import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { URL } from "node:url";
import type { GatewayConfig } from "../config/config.js";
import { resolveModel } from "../config/config.js";
import { GatewayError } from "../model/errors.js";
import type { GatewayEvent, PermissionDecision } from "../model/types.js";
import { Gateway } from "../gateway/gateway.js";

export function createServer(gateway:Gateway,config:GatewayConfig):http.Server{
  return http.createServer(async(req,res)=>{try{await route(req,res,gateway,config);}catch(error){writeError(res,error);}});
}

async function route(req:IncomingMessage,res:ServerResponse,gateway:Gateway,config:GatewayConfig):Promise<void>{
  const url=new URL(req.url??"/",`http://${req.headers.host??"localhost"}`);const method=req.method??"GET";const segments=url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if(method==="GET"&&url.pathname==="/event"){sse(req,res,gateway);return;}
  if(method==="POST"&&url.pathname==="/session"){
    const body=await jsonBody(req,config.maxRequestBytes) as Record<string,unknown>;const directory=url.searchParams.get("directory")??(typeof body.directory==="string"?body.directory:config.defaultDirectory);const session=await gateway.createSession(body.title as string,directory);json(res,200,{id:session.id,title:session.title,created_at:session.createdAt,status:session.status});return;
  }
  if(method==="GET"&&url.pathname==="/session/status"){json(res,200,gateway.statuses());return;}
  if(method==="GET"&&url.pathname==="/question"){json(res,200,gateway.broker.questions());return;}
  if(method==="GET"&&url.pathname==="/permission"){json(res,200,gateway.broker.permissions());return;}
  if(segments[0]==="question"&&segments[2]==="reply"&&method==="POST"){
    const body=await jsonBody(req,config.maxRequestBytes) as Record<string,unknown>;if(!Array.isArray(body.answers)||!body.answers.every((x)=>Array.isArray(x)&&x.every((y)=>typeof y==="string")))throw new GatewayError(400,"VALIDATION_ERROR","answers must be an array of string arrays");await gateway.replyQuestion(segments[1]!,body.answers as string[][]);json(res,200,{ok:true});return;
  }
  if(segments[0]==="permission"&&segments[2]==="reply"&&method==="POST"){
    const body=await jsonBody(req,config.maxRequestBytes) as Record<string,unknown>;if(!["once","always","reject"].includes(body.reply as string)||body.message!==undefined&&typeof body.message!=="string")throw new GatewayError(400,"VALIDATION_ERROR","reply must be once, always, or reject");const decision:PermissionDecision={reply:body.reply as PermissionDecision["reply"],...(typeof body.message==="string"?{message:body.message}:{})};await gateway.replyPermission(segments[1]!,decision);json(res,200,{ok:true});return;
  }
  if(segments[0]==="session"&&segments[1]){
    const id=segments[1];
    if(segments.length===2&&method==="GET"){json(res,200,gateway.session(id));return;}
    if(segments.length===2&&method==="DELETE"){await gateway.delete(id);json(res,200,{ok:true});return;}
    if(segments[2]==="message"&&method==="GET"){json(res,200,gateway.messages(id));return;}
    if((segments[2]==="abort"||segments[2]==="stop")&&method==="POST"){await gateway.abort(id);json(res,200,{ok:true});return;}
    if(segments[2]==="prompt_async"&&method==="POST"){
      const body=await jsonBody(req,config.maxRequestBytes) as Record<string,unknown>;if(!Array.isArray(body.parts)||body.parts.length===0||!body.parts.every((x)=>x&&typeof x==="object"&&(x as Record<string,unknown>).type==="text"&&typeof (x as Record<string,unknown>).text==="string"))throw new GatewayError(400,"VALIDATION_ERROR","parts must contain valid text parts");const text=(body.parts as Array<{text:string}>).map(x=>x.text).join("");if(!text)throw new GatewayError(400,"VALIDATION_ERROR","text must not be empty");await gateway.prompt(id,text,resolveModel(body.model,config.model));res.writeHead(204).end();return;
    }
  }
  throw new GatewayError(404,"NOT_FOUND","Resource not found");
}

function sse(req:IncomingMessage,res:ServerResponse,gateway:Gateway):void{
  res.writeHead(200,{"Content-Type":"text/event-stream; charset=utf-8","Cache-Control":"no-cache","Connection":"keep-alive","X-Accel-Buffering":"no"});res.flushHeaders();
  const write=(event:GatewayEvent)=>res.write(`data: ${JSON.stringify(event)}\n\n`);write({type:"server.connected",properties:{}});const unsubscribe=gateway.hub.subscribe((event)=>{const writable=write(event);if(!writable)res.end();return writable;});const heartbeat=setInterval(()=>{if(!write({type:"server.heartbeat",properties:{}}))res.end();},gateway.hub.heartbeatMs);heartbeat.unref();req.on("close",()=>{clearInterval(heartbeat);unsubscribe();});
}
async function jsonBody(req:IncomingMessage,limit:number):Promise<unknown>{let size=0;const chunks:Buffer[]=[];for await(const chunk of req){const value=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);size+=value.length;if(size>limit)throw new GatewayError(400,"VALIDATION_ERROR","Request body is too large");chunks.push(value);}if(chunks.length===0)return {};try{return JSON.parse(Buffer.concat(chunks).toString("utf8"));}catch{throw new GatewayError(400,"VALIDATION_ERROR","Request body must be valid JSON");}}
function json(res:ServerResponse,status:number,body:unknown):void{const data=JSON.stringify(body);res.writeHead(status,{"Content-Type":"application/json; charset=utf-8","Content-Length":Buffer.byteLength(data)}).end(data);}
function writeError(res:ServerResponse,error:unknown):void{if(res.headersSent){res.destroy();return;}const value=error instanceof GatewayError?error:new GatewayError(500,"INTERNAL_ERROR",error instanceof Error?error.message:"Internal error");json(res,value.status,{code:value.code,message:value.message});}
