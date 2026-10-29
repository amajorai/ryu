import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("actual Core configuration isolates cached code and refuses stale in-flight bundles", async () => {
	const root = await mkdtemp(join(tmpdir(), "island-ui-generation-"));
	try {
		const runner = join(root, "run.ts");
		await writeFile(
			runner,
			`
import {mock} from "bun:test";
import {EventEmitter} from "node:events";
mock.module(${JSON.stringify(Bun.resolveSync("electron", import.meta.dirname))},()=>({app:{getPath:()=>${JSON.stringify(root)}}}));
const {saveConfig,coreConfigGeneration}=await import(${JSON.stringify(join(import.meta.dirname, "config.ts"))});
const {readUiBundle}=await import(${JSON.stringify(join(import.meta.dirname, "ui-bundle-reads.ts"))});
const owner=Object.assign(new EventEmitter(),{id:1});
const calls=[];let release;let started;let ready=new Promise(r=>started=r);
const server=Bun.serve({hostname:"127.0.0.1",port:0,async fetch(req){
 calls.push({path:new URL(req.url).pathname,token:req.headers.get("authorization")});
 if(req.url.includes("slow")){started();await new Promise(r=>release=r);}
 return Response.json({code:req.headers.get("authorization")});
}});
try{
 const base=server.url.toString().replace(/\\/$/,"");
 saveConfig({coreBaseUrl:base+"/a",coreToken:"token-a"});
 const a=await readUiBundle(owner,"p");const cached=await readUiBundle(owner,"p","cached");
 const g=coreConfigGeneration();saveConfig({engine:{pollIntervalSeconds:20,cooldownSeconds:100}});
 const engineKeepsGeneration=coreConfigGeneration()===g;
 saveConfig({coreBaseUrl:base+"/b",coreToken:"token-b"});const b=await readUiBundle(owner,"p","b");
 const slow=readUiBundle(owner,"slow","slow");await ready;
 saveConfig({coreBaseUrl:base+"/a",coreToken:"token-a"});release();
 const stale=await slow;const returned=await readUiBundle(owner,"p");
 saveConfig({coreToken:"token-c"});const tokenChanged=await readUiBundle(owner,"p");
 process.stdout.write(JSON.stringify({a,cached,b,stale,returned,tokenChanged,calls,engineKeepsGeneration,listeners:owner.listenerCount("destroyed")}));
}finally{server.stop(true);}
`
		);
		const child = Bun.spawn([process.execPath, runner], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const [output, error, exit] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		expect(exit, error).toBe(0);
		const result = JSON.parse(output);
		expect(result.a.code).toBe("Bearer token-a");
		expect(result.cached).toEqual(result.a);
		expect(result.b.code).toBe("Bearer token-b");
		expect(result.stale).toEqual({
			available: false,
			reason: "Core configuration changed",
		});
		expect(result.returned.code).toBe("Bearer token-a");
		expect(result.tokenChanged.code).toBe("Bearer token-c");
		expect(result.calls).toHaveLength(5);
		expect(result.engineKeepsGeneration).toBe(true);
		expect(result.listeners).toBe(0);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}, 15_000);
