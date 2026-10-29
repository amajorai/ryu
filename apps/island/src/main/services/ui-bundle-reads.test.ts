import { expect, test } from "bun:test";
import {
	copyFile,
	mkdir,
	mkdtemp,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("IPC bundle request owners cancel independently and release destruction listeners", async () => {
	const root = await mkdtemp(join(tmpdir(), "ryu-island-bundle-owners-"));
	const opened = new Set<string>();
	const closed = new Set<string>();
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(req) {
			const path = new URL(req.url).pathname;
			if (path === "/stats") {
				return Response.json({ opened: [...opened], closed: [...closed] });
			}
			if (path.includes("/fast/")) {
				return Response.json({ code: "fixture" });
			}
			opened.add(path);
			return new Response(
				new ReadableStream({
					start(controller) {
						controller.enqueue(new TextEncoder().encode('{"code":"'));
					},
					cancel() {
						closed.add(path);
					},
				})
			);
		},
	});
	try {
		await symlink(
			join(import.meta.dirname, "../../../node_modules"),
			join(root, "node_modules"),
			"dir"
		);
		const services = join(root, "main/services");
		await mkdir(services, { recursive: true });
		await mkdir(join(root, "main/ipc"));
		await mkdir(join(root, "shared"));
		await copyFile(
			join(import.meta.dirname, "../ipc/plugins.ts"),
			join(root, "main/ipc/plugins.ts")
		);
		for (const name of ["ipc.ts", "host-json.ts"]) {
			await copyFile(
				join(import.meta.dirname, "../../shared", name),
				join(root, "shared", name)
			);
		}
		for (const name of [
			"ui-bundle-reads.ts",
			"plugin-host.ts",
			"plugin-host-contract.ts",
			"response-deadline.ts",
			"sse.ts",
		]) {
			await copyFile(join(import.meta.dirname, name), join(services, name));
		}
		const base = server.url.toString().replace(/\/$/, "");
		await writeFile(
			join(services, "config.ts"),
			`export const onCoreConfigChange=()=>()=>{};export const coreConfigGeneration=()=>0;export const coreHeaders=()=>({});export const loadConfig=()=>({coreBaseUrl:${JSON.stringify(base)}});`
		);
		await writeFile(
			join(root, "run.ts"),
			`
import {EventEmitter} from "node:events";
import {mock} from "bun:test";
const handlers=new Map();mock.module("electron",()=>({ipcMain:{handle:(name,handler)=>handlers.set(name,handler)}}));
const {registerPluginsIpc}=await import("./main/ipc/plugins.ts");const {IPC}=await import("./shared/ipc.ts");registerPluginsIpc(()=>null);
const readUiBundle=(owner,pluginId,requestId)=>handlers.get(IPC.plugins.uiBundle)({sender:owner},pluginId,requestId);
const abortUiBundleRead=(ownerId,requestId)=>handlers.get(IPC.plugins.uiBundleAbort)({sender:ownerId===1?a:b},requestId);
const a=Object.assign(new EventEmitter(),{id:1});const b=Object.assign(new EventEmitter(),{id:2});
const stats=()=>fetch(${JSON.stringify(base)}+"/stats").then(r=>r.json());
async function until(check){const end=Date.now()+2000;while(!check(await stats())){if(Date.now()>end)throw Error("fixture timed out");await Bun.sleep(5);}}
const first=readUiBundle(a,"a","same");const second=readUiBundle(b,"b","same");await until(s=>s.opened.length===2);
const duplicate=await readUiBundle(a,"a","same");abortUiBundleRead(1,"same");const firstResult=await first;await until(s=>s.closed.length===1);const afterFirst=await stats();const bListeners=b.listenerCount("destroyed");
b.emit("destroyed");const secondResult=await second;await until(s=>s.closed.length===2);
const normal=await readUiBundle(a,"fast","normal");const legacy=await readUiBundle(a,"fast");
process.stdout.write(JSON.stringify({duplicate,firstResult,secondResult,afterFirst,bListeners,normal,legacy,listeners:a.listenerCount("destroyed")+b.listenerCount("destroyed")}));
`
		);
		const child = Bun.spawn([process.execPath, join(root, "run.ts")], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const result = await new Response(child.stdout).json();
		expect(await child.exited).toBe(0);
		expect(result.duplicate).toEqual({
			available: false,
			reason: "duplicate request id",
		});
		expect(result.firstResult.available).toBe(false);
		expect(result.secondResult.available).toBe(false);
		expect(result.afterFirst.closed).toEqual(["/api/plugins/a/ui-bundle"]);
		expect(result.bListeners).toBe(1);
		expect(result.normal).toEqual({
			available: true,
			code: "fixture",
			coreGeneration: 0,
		});
		expect(result.legacy).toEqual({
			available: true,
			code: "fixture",
			coreGeneration: 0,
		});
		expect(result.listeners).toBe(0);
	} finally {
		server.stop(true);
		await rm(root, { recursive: true, force: true });
	}
}, 10_000);
