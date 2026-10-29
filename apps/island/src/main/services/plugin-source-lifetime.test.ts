import { expect, test } from "bun:test";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("mounted production host closures and RPC cannot acquire the next Core principal", async () => {
	const root = await mkdtemp(join(tmpdir(), "island-plugin-source-"));
	try {
		await symlink(
			resolve(import.meta.dirname, "../../../node_modules"),
			join(root, "node_modules")
		);
		const runner = join(root, "run.tsx");
		await writeFile(
			runner,
			`
import {mock} from "bun:test";
import {GlobalRegistrator} from ${JSON.stringify(resolve(import.meta.dirname, "../../../../desktop/node_modules/@happy-dom/global-registrator/lib/index.js"))};
const native={fetch,Response,Request,Headers,AbortController,AbortSignal};GlobalRegistrator.register();Object.assign(globalThis,native);globalThis.IS_REACT_ACT_ENVIRONMENT=true;
const {act}=await import("react");const {createRoot}=await import("react-dom/client");
const handlers=new Map();const changes=new Set();const terminal=[];let props;
mock.module(${JSON.stringify(Bun.resolveSync("electron", import.meta.dirname))},()=>({app:{getPath:()=>${JSON.stringify(root)}},ipcMain:{handle:(key,value)=>handlers.set(key,value)}}));
mock.module(${JSON.stringify(Bun.resolveSync("@ryu/app-host/ExtensionHost", import.meta.dirname))},()=>({ExtensionHost:p=>{props=p;return <iframe title={p.title} srcDoc={p.srcdoc}/>;}}));
mock.module(${JSON.stringify(Bun.resolveSync("@ryu/i18n/react", import.meta.dirname))},()=>({useI18n:()=>({getSnapshot:()=>({locale:"en",direction:"ltr"}),subscribe:()=>()=>{},t:key=>key})}));
const {saveConfig}=await import(${JSON.stringify(join(import.meta.dirname, "config.ts"))});
const {registerPluginsIpc}=await import(${JSON.stringify(join(import.meta.dirname, "../ipc/plugins.ts"))});
const {IPC}=await import(${JSON.stringify(join(import.meta.dirname, "../../shared/ipc.ts"))});
const {IslandPluginHost}=await import(${JSON.stringify(join(import.meta.dirname, "../../renderer/host/IslandPluginHost.tsx"))});
const {usePluginContributions}=await import(${JSON.stringify(join(import.meta.dirname, "../../renderer/hooks/use-plugin-contributions.ts"))});
const {dispatchRpc}=await import(${JSON.stringify(Bun.resolveSync("@ryu/app-host/rpc", import.meta.dirname))});
const owner={id:1,once(){},removeListener(){}};
const invoke=(channel,...args)=>handlers.get(channel)({sender:owner},...args);
window.island={plugins:{contributions:()=>invoke(IPC.plugins.contributions),uiBundle:(...a)=>invoke(IPC.plugins.uiBundle,...a),abortUiBundle:()=>Promise.resolve(),hostInvoke:r=>invoke(IPC.plugins.hostInvoke,r),coreHttp:r=>invoke(IPC.plugins.coreHttp,r),onSourceChanged:f=>{changes.add(f);return()=>changes.delete(f);}}};
registerPluginsIpc(()=>({isDestroyed:()=>false,webContents:{send:(channel,payload)=>{if(channel===IPC.plugins.sourceChanged)for(const f of changes)f();if(channel===IPC.plugins.hostStreamEnd)terminal.push(payload);}}}));
const requests=[];let release;let started;const ready=new Promise(r=>started=r);
const server=Bun.serve({hostname:"127.0.0.1",port:0,async fetch(req){
 const path=new URL(req.url).pathname;const token=req.headers.get("authorization");
 if(path.endsWith("/contributions"))return Response.json({companions:[{id:"p",plugin_id:"p",name:"Plugin",label:"Plugin",has_ui:true,approved_grants:["storage:kv"]}],views:[]});
 if(path.endsWith("/ui-bundle"))return Response.json({code:"window.fixture=true;"});
 requests.push({path,token});if(path.endsWith("/host/stream"))return new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('data: {"type":"text-delta","delta":"fixture"}\\n\\n'));}}));const body=await req.json();
 if(body.args?.key==="slow"){started();await new Promise(r=>release=r);}
 return Response.json({result:token});
}});
const container=document.createElement("div");document.body.append(container);const view=createRoot(container);
function Product(){const {companions}=usePluginContributions();return companions.map(c=><IslandPluginHost key={c.id+":"+c.coreGeneration} companion={c}/>);}
async function settle(){for(let i=0;i<15;i++)await act(async()=>{await Bun.sleep(5);});}
try{
 const base=server.url.toString().replace(/\\/$/,"");saveConfig({coreBaseUrl:base+"/a",coreToken:"a"});
 await act(()=>view.render(<Product/>));await settle();const a=props;
 const first=await dispatchRpc("storage.get",[{key:"private"}],a.granted,a.services);
 const pending=dispatchRpc("storage.get",[{key:"slow"}],a.granted,a.services);await ready;
 let gate;const delayed=(async()=>{await new Promise(r=>gate=r);return dispatchRpc("storage.get",[{key:"private",coreGeneration:999}],a.granted,a.services);})();
 await act(()=>saveConfig({coreBaseUrl:base+"/b",coreToken:"b"}));gate();release();
 const blocked=await Promise.allSettled([pending,delayed,dispatchRpc("storage.get",[{key:"private"}],a.granted,a.services)]);
 await settle();const b=props;const valid=await dispatchRpc("storage.get",[{key:"private"}],b.granted,b.services);
 const frame=container.querySelector("iframe")?.title;const contributions=await invoke(IPC.plugins.contributions);const epoch=contributions.companions[0].coreGeneration;
 await invoke(IPC.plugins.hostStreamStart,{pluginId:"p",input:{},coreGeneration:epoch});for(let i=0;i<30&&!requests.some(r=>r.path.endsWith("/host/stream"));i++)await Bun.sleep(5);
 saveConfig({coreBaseUrl:base+"/a",coreToken:"a"});for(let i=0;i<30&&!terminal.length;i++)await Bun.sleep(5);
 process.stdout.write(JSON.stringify({first,valid,blocked:blocked.map(x=>x.status==="rejected"?x.reason.code:x.status),requests,frame,terminal}));
}finally{await act(()=>view.unmount());server.stop(true);}
`
		);
		const child = Bun.spawn([process.execPath, runner], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const [output, errors, exit] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		expect(exit, errors.slice(0, 2000)).toBe(0);
		const result = JSON.parse(output);
		expect(result.first).toBe("Bearer a");
		expect(result.valid).toBe("Bearer b");
		expect(result.blocked).toEqual(["denied", "denied", "denied"]);
		expect(result.requests).toEqual([
			{ path: "/a/api/plugins/p/host", token: "Bearer a" },
			{ path: "/a/api/plugins/p/host", token: "Bearer a" },
			{ path: "/b/api/plugins/p/host", token: "Bearer b" },
			{ path: "/b/api/plugins/p/host/stream", token: "Bearer b" },
		]);
		expect(result.frame).toBe("App: Plugin");
		expect(result.terminal).toHaveLength(1);
		expect(result.terminal[0].reason).toBe("aborted");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}, 15_000);
