import { expect, test } from "bun:test";
import { join } from "node:path";
import { runIsolatedIslandScenario } from "../island-isolated-runtime.ts";

// Each case runs the shipping IPC reader (`ui-bundle-reads.ts`) over the real
// `plugin-host.ts` and `config.ts` in its own Bun runtime, against an owned
// native HTTP Core fixture. Only Electron's `app.getPath` is replaced (to give
// the real config a private userData directory), and that replacement never
// leaks into the rest of `bun test src`.
const READS = join(import.meta.dirname, "ui-bundle-reads.ts");
const ELECTRON = Bun.resolveSync("electron", import.meta.dirname);
const TOKEN = "island-bundle-token";

interface BundleRun {
	/** Owner `destroyed` listeners still attached after every read settled. */
	listeners: number;
	/** Authenticated Core reads, in order. */
	requests: { authorization: string | null; path: string }[];
	/** One `readUiBundle` result per `read(label, …)` in the scenario. */
	seen: Record<string, unknown>;
	stderr: string;
}

async function bundleScenario(body: string): Promise<BundleRun> {
	const { result, stderr } = await runIsolatedIslandScenario(
		(root) => `
import {mock} from "bun:test";
import {EventEmitter} from "node:events";
import {writeFileSync} from "node:fs";
const enabled=new Set(["cached"]);
const requests=[];
const server=Bun.serve({hostname:"127.0.0.1",port:0,fetch(req){
 const path=new URL(req.url).pathname;
 requests.push({path,authorization:req.headers.get("authorization")});
 const id=path.split("/")[3];
 // Core answers 404 "plugin not enabled" for an installed-but-disabled app.
 return enabled.has(id)?Response.json({code:"bundle:"+id}):Response.json({error:"plugin not enabled"},{status:404});
}});
const base=server.url.toString().replace(/\\/$/,"");
writeFileSync(${JSON.stringify(join(root, "island-services.json"))},JSON.stringify({coreBaseUrl:base,coreToken:${JSON.stringify(TOKEN)}}));
mock.module(${JSON.stringify(ELECTRON)},()=>({app:{getPath:()=>${JSON.stringify(root)}}}));
try{
 const {readUiBundle}=await import(${JSON.stringify(READS)});
 const owners=[];
 const owner=(id)=>{const target=Object.assign(new EventEmitter(),{id});owners.push(target);return target;};
 const seen={};
 const read=async(label,target,pluginId,requestId)=>{seen[label]={result:await readUiBundle(target,pluginId,requestId),requests:requests.length};};
 ${body}
 process.stdout.write(JSON.stringify({seen,requests,listeners:owners.reduce((sum,target)=>sum+target.listenerCount("destroyed"),0)}));
}finally{server.stop(true);}
`
	);
	return { ...(result as Omit<BundleRun, "stderr">), stderr };
}

const bundleRead = (pluginId: string) => ({
	authorization: `Bearer ${TOKEN}`,
	path: `/api/plugins/${pluginId}/ui-bundle`,
});

test("settled bundle bodies are reused by the Island IPC reader", async () => {
	const { seen, requests, listeners, stderr } = await bundleScenario(`
const target=owner(1);
await read("first",target,"cached","first");
await read("second",target,"cached","second");
`);
	expect(stderr).toBe("");
	const first = { available: true, code: "bundle:cached" };
	expect(seen.first).toEqual({ result: first, requests: 1 });
	// The second read is served from the settled body: Core is not asked again.
	expect(seen.second).toEqual({ result: first, requests: 1 });
	expect(requests).toEqual([bundleRead("cached")]);
	expect(listeners).toBe(0);
});

test("missing Island bundles are retried after an app is enabled", async () => {
	const { seen, requests, listeners, stderr } = await bundleScenario(`
const target=owner(2);
await read("first",target,"missing","first");
await read("second",target,"missing","second");
enabled.add("missing");
await read("enabled",target,"missing","enabled");
await read("cachedAfterEnable",target,"missing","again");
`);
	expect(stderr).toBe("");
	const missing = { available: true, code: null };
	expect(seen.first).toEqual({ result: missing, requests: 1 });
	// A missing body is never cached: each read asks Core again, so the bundle
	// appears as soon as the app is enabled.
	expect(seen.second).toEqual({ result: missing, requests: 2 });
	expect(seen.enabled).toEqual({
		result: { available: true, code: "bundle:missing" },
		requests: 3,
	});
	expect(seen.cachedAfterEnable).toEqual({
		result: { available: true, code: "bundle:missing" },
		requests: 3,
	});
	expect(requests).toEqual([
		bundleRead("missing"),
		bundleRead("missing"),
		bundleRead("missing"),
	]);
	expect(listeners).toBe(0);
});
