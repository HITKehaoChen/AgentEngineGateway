import { createServer } from "./api/server.js";
import { loadConfig } from "./config/config.js";
import { Gateway } from "./gateway/gateway.js";
import { FakeAdapter } from "./harness/fake-adapter.js";
import { OpenCodeAdapter } from "./harness/opencode/adapter.js";
import { PiAdapter } from "./harness/pi/adapter.js";
import type { HarnessAdapter } from "./model/types.js";

const config=loadConfig();
let adapter:HarnessAdapter;
let engineConfig:{command:string;version:string};
if(config.engine==="fake") { adapter=new FakeAdapter();engineConfig={command:"fake",version:"1.0.0"}; }
else if(config.engine==="opencode") {
  const port=Number(process.env.OPENCODE_PORT??"6221");
  if(!Number.isSafeInteger(port)||port<=0)throw new Error("OPENCODE_PORT must be a positive integer");
  adapter=new OpenCodeAdapter({command:process.env.OPENCODE_COMMAND??"opencode",hostname:process.env.OPENCODE_HOST??"127.0.0.1",port,...(process.env.OPENCODE_BASE_URL?{baseUrl:process.env.OPENCODE_BASE_URL}:{}),expectedVersion:process.env.OPENCODE_VERSION??"1.18.26"});
  engineConfig={command:process.env.OPENCODE_COMMAND??"opencode",version:process.env.OPENCODE_VERSION??"1.18.26"};
}
else if(config.engine==="pi") {
  adapter=new PiAdapter({command:process.env.PI_COMMAND??"pi",expectedVersion:process.env.PI_VERSION??"0.84.4",controlTimeoutMs:config.piControlTimeoutMs??5_000,abortGraceMs:config.abortGraceMs??10_000});
  engineConfig={command:process.env.PI_COMMAND??"pi",version:process.env.PI_VERSION??"0.84.4"};
}
else throw new Error(`Unsupported adapter '${config.engine}'`);
await adapter.start({command:engineConfig.command,version:engineConfig.version,model:config.model,startupTimeoutMs:config.engineStartupTimeoutMs??60_000,healthTimeoutMs:config.engineHealthTimeoutMs??5_000});
const gateway=new Gateway(adapter,{maxSessions:config.maxSessions,runTimeoutMs:config.runTimeoutMs,heartbeatMs:config.heartbeatMs});
const server=createServer(gateway,config);
let stopping=false;
const stop=async()=>{if(stopping)return;stopping=true;server.close();await adapter.stop();};
server.on("error",(error)=>{console.error("gateway server error",error);void (async()=>{if(stopping)return;stopping=true;await adapter.stop();process.exitCode=1;})();});
server.listen(config.port,config.host,()=>console.log(`Gateway (${adapter.name}) listening on http://${config.host}:${config.port}`));
process.on("SIGINT",()=>void stop());process.on("SIGTERM",()=>void stop());
