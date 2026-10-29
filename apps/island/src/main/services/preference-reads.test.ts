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
import { z } from "zod";

test("preference reads coalesce in flight without caching or crossing credentials and writes", async () => {
	const root = await mkdtemp(join(tmpdir(), "ryu-shared-prefs-"));
	let reads = 0;
	let failOnce = true;
	let value = "initial";
	let holdNext = false;
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(req) {
			const path = new URL(req.url).pathname;
			if (path === "/stats") {
				return Response.json({ reads });
			}
			if (path === "/hold") {
				holdNext = true;
				return new Response(null, { status: 204 });
			}
			if (req.method === "PUT") {
				value = z.object({ value: z.string() }).parse(await req.json()).value;
				return new Response(null, { status: 204 });
			}
			reads++;
			if (path.endsWith("/error") && failOnce) {
				failOnce = false;
				return new Response(null, { status: 503 });
			}
			const snapshot = value;
			const delay = holdNext ? 250 : 30;
			holdNext = false;
			await Bun.sleep(delay);
			return Response.json({ value: snapshot });
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
import {getPreferenceRaw as get,setPreferenceRaw as put} from "./main/services/preferences.ts";
import {getThemePrefsRaw} from "./main/services/theme.ts";
import {getVoicePrefsRaw} from "./main/services/voice.ts";
import {getAppearanceRaw} from "./main/services/appearance.ts";
import {getAutoJumpRaw} from "./main/services/auto-jump.ts";
import {getEdgeOffsetRaw} from "./main/services/edge-offset.ts";
import {rotate} from "./main/services/config.ts";
const base=${JSON.stringify(base)}; const stats=()=>fetch(base+"/stats").then(r=>r.json());
const batch=await Promise.all([...Array.from({length:10},()=>get("custom")),getThemePrefsRaw(),get("theme"),getVoicePrefsRaw(),get("voice-input"),getAppearanceRaw(),getAutoJumpRaw(),getEdgeOffsetRaw(),getVoicePrefsRaw()]);
const cold=await stats();await getThemePrefsRaw();const fresh=await stats();
const scopedFirst=get("theme");rotate();const scopedSecond=get("theme");await Promise.all([scopedFirst,scopedSecond]);const scoped=await stats();
await fetch(base+"/hold");const oldRead=get("theme");const deadline=Date.now()+5000;while((await stats()).reads<10 && Date.now()<deadline)await Bun.sleep(5);await put("theme","updated");const newValue=await get("theme");const oldValue=await oldRead;
const failed=await get("error");const recovered=await get("error");process.stdout.write(JSON.stringify({batch,cold,fresh,scoped,newValue,oldValue,failed,recovered,final:await stats()}));
`
		);

		const child = Bun.spawn([process.execPath, join(root, "run.ts")], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const result = await new Response(child.stdout).json();
		expect(await child.exited).toBe(0);
		expect(result.batch).toEqual(Array.from({ length: 18 }, () => "initial"));
		expect(result.cold).toEqual({ reads: 6 });
		expect(result.fresh).toEqual({ reads: 7 });
		expect(result.scoped).toEqual({ reads: 9 });
		expect(result.oldValue).toBe("initial");
		expect(result.newValue).toBe("updated");
		expect(result.failed).toBeNull();
		expect(result.recovered).toBe("updated");
		expect(result.final).toEqual({ reads: 13 });
	} finally {
		server.stop(true);
		await rm(root, { recursive: true, force: true });
	}
}, 30_000);
