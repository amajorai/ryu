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

test("preference consumers share one reconnecting stream and release it after the final stop", async () => {
	const root = await mkdtemp(join(tmpdir(), "ryu-shared-prefs-"));
	const streams = new Set<ReadableStreamDefaultController<Uint8Array>>();
	let opened = 0;
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(req) {
			const path = new URL(req.url).pathname;
			if (path === "/stats") {
				return Response.json({ opened, active: streams.size });
			}
			if (path === "/emit") {
				const frame =
					'data: {"key":"theme","value":"dark"}\r\n\r\ndata: {"key":"voice-input","value":"voice"}\n\ndata: {"key":"custom","value":"custom"}\n\n';
				for (const controller of streams) {
					controller.enqueue(new TextEncoder().encode(frame));
				}
				return new Response(null, { status: 204 });
			}
			if (path === "/drop") {
				for (const controller of streams) {
					controller.close();
				}
				streams.clear();
				return new Response(null, { status: 204 });
			}
			opened++;
			let source: ReadableStreamDefaultController<Uint8Array>;
			return new Response(
				new ReadableStream<Uint8Array>({
					start(controller) {
						source = controller;
						streams.add(controller);
						controller.enqueue(new TextEncoder().encode(": connected\n\n"));
					},
					cancel() {
						streams.delete(source);
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
		const shared = join(root, "shared");
		await mkdir(services, { recursive: true });
		await mkdir(shared);
		for (const name of [
			"preferences",
			"preference-stream",
			"sse-reader",
			"reconnect-delay",
			"response-deadline",
			"theme",
			"voice",
			"appearance",
			"auto-jump",
			"edge-offset",
		]) {
			await copyFile(
				join(import.meta.dirname, `${name}.ts`),
				join(services, `${name}.ts`)
			);
		}
		for (const name of ["voice", "appearance", "auto-jump", "edge-offset"]) {
			await copyFile(
				join(import.meta.dirname, "../../shared", `${name}.ts`),
				join(shared, `${name}.ts`)
			);
		}
		const base = server.url.toString().replace(/\/$/, "");
		await writeFile(
			join(services, "config.ts"),
			`let identity="one";export const rotate=()=>{identity="two";};export const coreHeaders=()=>({"x-fixture-identity":identity});export const loadConfig=()=>({coreBaseUrl:${JSON.stringify(base)}});`
		);
		await writeFile(
			join(root, "run.ts"),
			`
import {subscribePreferenceChanges as subscribe} from "./main/services/preferences.ts";
import {subscribeThemeChanges} from "./main/services/theme.ts";
import {subscribeVoiceChanges} from "./main/services/voice.ts";
import {subscribeAppearanceChanges} from "./main/services/appearance.ts";
import {subscribeAutoJumpChanges} from "./main/services/auto-jump.ts";
import {subscribeEdgeOffsetChanges} from "./main/services/edge-offset.ts";
import {rotate} from "./main/services/config.ts";
const base=${JSON.stringify(base)}; const stats=()=>fetch(base+"/stats").then(r=>r.json());
async function until(predicate){const end=Date.now()+5000;while(!predicate(await stats())){if(Date.now()>end)throw Error("fixture timed out");await Bun.sleep(10);}}
const values=[];const stops=[];
for(let i=0;i<10;i++)stops.push(subscribe("custom",v=>values.push(v)));
stops.push(subscribeThemeChanges(v=>values.push(v)),subscribeVoiceChanges(v=>values.push(v)),subscribeAppearanceChanges(()=>{}),subscribeAutoJumpChanges(()=>{}),subscribeEdgeOffsetChanges(()=>{}));
stops.push(subscribe("theme",()=>{throw Error("fixture consumer");}),subscribeThemeChanges(v=>values.push(v)),subscribeVoiceChanges(v=>values.push(v)));
await until(s=>s.active>0);await Bun.sleep(30);const initial=await stats();await fetch(base+"/emit");const deliveryDeadline=Date.now()+5000;while(values.length<14 && Date.now()<deliveryDeadline)await Bun.sleep(10);
for(const stop of stops.slice(0,-1))stop();const partial=await stats();await fetch(base+"/drop");await until(s=>s.opened>initial.opened);const reconnected=await stats();
rotate();const stopRotated=subscribe("custom",()=>{});await until(s=>s.opened===3 && s.active===1);const rotated=await stats();stopRotated();stops.at(-1)();await until(s=>s.active===0);const stopped=await stats();const stopNew=subscribe("custom",()=>{});await until(s=>s.active===1);stopNew();await until(s=>s.active===0);
process.stdout.write(JSON.stringify({initial,values,partial,reconnected,rotated,stopped,final:await stats()}));
`
		);
		const child = Bun.spawn([process.execPath, join(root, "run.ts")], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const result = await new Response(child.stdout).json();
		expect(await child.exited).toBe(0);
		expect(result.initial).toEqual({ opened: 1, active: 1 });
		expect(result.values.sort()).toEqual(
			[
				...Array.from({ length: 10 }, () => "custom"),
				"dark",
				"dark",
				"voice",
				"voice",
			].sort()
		);
		expect(result.partial).toEqual({ opened: 1, active: 1 });
		expect(result.reconnected).toEqual({ opened: 2, active: 1 });
		expect(result.rotated).toEqual({ opened: 3, active: 1 });
		expect(result.stopped).toEqual({ opened: 3, active: 0 });
		expect(result.final).toEqual({ opened: 4, active: 0 });
	} finally {
		server.stop(true);
		await rm(root, { recursive: true, force: true });
	}
}, 30_000);
