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

test("shortcut refresh bursts preserve bindings until a fresh parallel snapshot is ready", async () => {
	const root = await mkdtemp(join(tmpdir(), "ryu-shortcuts-"));
	const reads: Record<string, number> = {};
	const held: Array<() => void> = [];
	let child: Bun.Subprocess<"ignore", "pipe", "pipe"> | null = null;
	let childTimer: ReturnType<typeof setTimeout> | null = null;
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(req) {
			const path = new URL(req.url).pathname;
			if (path === "/stats") {
				return Response.json(reads);
			}
			if (path === "/release") {
				for (const release of held) {
					release();
				}
				return new Response(null, { status: 204 });
			}
			reads[path] = (reads[path] ?? 0) + 1;
			const round = reads[path];
			if (round === 1) {
				await new Promise<void>((resolve) => held.push(resolve));
			}
			return Response.json(
				path.endsWith("keybindings")
					? { value: JSON.stringify({ "plugin:fixture": String(round) }) }
					: { companions: [], views: [] }
			);
		},
	});
	try {
		// This detached runtime uses the owning app's authentic locked closure.
		// Bun must not auto-install missing packages from a temporary directory.
		await symlink(
			join(import.meta.dirname, "../../../node_modules"),
			join(root, "node_modules"),
			"dir"
		);
		const services = join(root, "main/services");
		await mkdir(services, { recursive: true });
		await mkdir(join(root, "shared"));
		for (const name of [
			"plugin-shortcuts",
			"plugin-host",
			"plugin-host-contract",
			"preferences",
			"preference-stream",
			"sse-reader",
			"response-deadline",
			"reconnect-delay",
			"sse",
		]) {
			await copyFile(
				join(import.meta.dirname, `${name}.ts`),
				join(services, `${name}.ts`)
			);
		}
		for (const name of ["keybindings.ts", "host-json.ts"]) {
			await copyFile(
				join(import.meta.dirname, "../../shared", name),
				join(root, "shared", name)
			);
		}
		const base = server.url.toString().replace(/\/$/, "");
		await writeFile(
			join(services, "config.ts"),
			`export const coreHeaders=()=>({});export const loadConfig=()=>({coreBaseUrl:${JSON.stringify(base)}});`
		);
		await writeFile(
			join(root, "run.ts"),
			`
import {createPluginShortcutRefresh} from "./main/services/plugin-shortcuts.ts";
const applied=[];const refresh=createPluginShortcutRefresh((result,overrides)=>applied.push({available:result.available,overrides}));
const pending=refresh();const base=${JSON.stringify(base)};const end=Date.now()+2000;
while(Object.keys(await fetch(base+"/stats").then(r=>r.json())).length<2){if(Date.now()>end)throw Error("reads did not start together");await Bun.sleep(5);}
const before=applied.length;const burst=Array.from({length:20},()=>refresh());await fetch(base+"/release");await Promise.all([pending,...burst]);process.stdout.write(JSON.stringify({before,applied}));
`
		);
		child = Bun.spawn([process.execPath, join(root, "run.ts")], {
			stdout: "pipe",
			stderr: "pipe",
		});
		childTimer = setTimeout(() => child?.kill("SIGKILL"), 8000);
		const [output, errors, exit] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		if (exit !== 0) {
			throw new Error(`Shortcut runtime exited ${exit}: ${errors}`);
		}
		expect(errors).toBe("");
		const result: unknown = JSON.parse(output);
		expect(result).toEqual({
			before: 0,
			applied: [{ available: true, overrides: { "plugin:fixture": "2" } }],
		});
		expect(reads).toEqual({
			"/api/plugins/contributions": 2,
			"/api/preferences/keybindings": 2,
		});
	} finally {
		if (childTimer) {
			clearTimeout(childTimer);
		}
		if (child?.exitCode === null) {
			child.kill("SIGKILL");
		}
		if (child) {
			await child.exited;
		}
		server.stop(true);
		await rm(root, { recursive: true, force: true });
	}
}, 10_000);
