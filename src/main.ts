import { createServer } from "./api/server.js";
import { loadConfig } from "./config/config.js";
import { Gateway } from "./gateway/gateway.js";
import { FakeAdapter } from "./harness/fake-adapter.js";
import type { HarnessAdapter } from "./model/types.js";

const config=loadConfig();
if(config.engine!=="fake")throw new Error(`Adapter '${config.engine}' is scheduled for a later phase; use --engine fake for Phase 1`);
const adapter:HarnessAdapter=new FakeAdapter();
await adapter.start({command:"fake",version:"1.0.0",model:config.model,startupTimeoutMs:60_000,healthTimeoutMs:5_000});
const gateway=new Gateway(adapter,{maxSessions:config.maxSessions,runTimeoutMs:config.runTimeoutMs,heartbeatMs:config.heartbeatMs});
const server=createServer(gateway,config);
server.listen(config.port,config.host,()=>console.log(`Gateway (${adapter.name}) listening on http://${config.host}:${config.port}`));
let stopping=false;const stop=async()=>{if(stopping)return;stopping=true;server.close();await adapter.stop();};process.on("SIGINT",()=>void stop());process.on("SIGTERM",()=>void stop());
