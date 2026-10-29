import { expect, test } from "bun:test";
import {
	copyFile,
	mkdtemp,
	readFile,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

test("Core one-shot clients preserve JSON/binary results and their complete-body deadlines", async () => {
	const root = await mkdtemp(join(tmpdir(), "ryu-island-core-"));
	let closed = 0;
	const replies = z.record(z.string(), z.json()).parse({
		"/v1/chat/completions": { choices: [{ message: { content: "fixture" } }] },
		"/api/voice/transcribe": { text: "transcribed" },
		"/api/voice/speech-processing": { text: "cleaned" },
		"/api/mcp/tools/call": { ok: true, output: "tool-result" },
		"/api/sidecar/status": { sidecars: [{ name: "fixture", running: true }] },
		"/api/sidecar/fixture/start": { success: true },
		"/api/agents": {
			agents: [{ id: "fixture", name: "Fixture", built_in: true }],
		},
		"/api/agents/fixture/acp-config": {},
		"/api/engines/models": {
			models: { fixture: [{ id: "small", name: "Small" }] },
		},
		"/api/conversations": { conversations: [{ id: "thread", title: "" }] },
	});
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		idleTimeout: 150,
		fetch(req) {
			const path = new URL(req.url).pathname;
			if (path.startsWith("/slow/")) {
				return new Response(
					new ReadableStream({
						start(controller) {
							controller.enqueue(new TextEncoder().encode("{"));
						},
						cancel() {
							closed++;
						},
					})
				);
			}
			if (path === "/api/health") {
				return new Response(null, { status: 204 });
			}
			if (path === "/api/voice/speak") {
				return new Response(new Uint8Array([82, 73, 70, 70]), {
					headers: { "Content-Type": "audio/wav" },
				});
			}
			return Response.json(replies[path] ?? {});
		},
	});
	try {
		await symlink(
			join(import.meta.dirname, "../../../node_modules"),
			join(root, "node_modules"),
			"dir"
		);
		await copyFile(
			join(import.meta.dirname, "../../shared/acp.ts"),
			join(root, "acp.ts")
		);
		for (const name of ["core.ts", "response-deadline.ts", "sse.ts"]) {
			await copyFile(join(import.meta.dirname, name), join(root, name));
		}
		const coreSource = await readFile(join(root, "core.ts"), "utf8");
		await writeFile(
			join(root, "core.ts"),
			coreSource.replace("../../shared/acp.ts", "./acp.ts")
		);
		await writeFile(
			join(root, "config.ts"),
			`let slow = false; export const stall = () => { slow = true; }; export const coreHeaders = () => ({}); export const loadConfig = () => ({ coreBaseUrl: ${JSON.stringify(server.url.toString().replace(/\/$/, ""))} + (slow ? "/slow" : "") });`
		);
		await writeFile(
			join(root, "run.ts"),
			'import * as core from "./core.ts"; import { stall } from "./config.ts"; const audio = new Uint8Array([82,73,70,70]).buffer; const calls = () => [core.completions({messages:[]}), core.speak({text:"fixture"}), core.transcribe(audio,"fixture"), core.processSpeechText({text:"fixture",engine:"fixture"}), core.callTool({tool:"fixture",arguments:{},agent_id:"fixture"}), core.sidecarStatus()]; const normal = await Promise.all([core.health(), ...calls(), core.sidecarStart("fixture"), core.agents(), core.acpConfig("fixture"), core.engineModels(), core.conversations()]); normal[2].audio = Array.from(new Uint8Array(normal[2].audio)); stall(); const began = performance.now(); const stalled = await Promise.all(calls()); process.stdout.write(JSON.stringify({normal, stalled, elapsedMs:performance.now()-began}));'
		);
		const child = Bun.spawn([process.execPath, join(root, "run.ts")], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const result = z
			.object({
				normal: z.array(z.json()),
				stalled: z.array(z.json()),
				elapsedMs: z.number(),
			})
			.parse(await new Response(child.stdout).json());
		expect(await child.exited).toBe(0);
		expect(result.normal[0]).toEqual({ available: true });
		expect(result.normal[1]).toEqual({ available: true, text: "fixture" });
		expect(result.normal[2]).toEqual({
			available: true,
			audio: [82, 73, 70, 70],
			mime: "audio/wav",
		});
		expect(result.normal[3]).toEqual({ available: true, text: "transcribed" });
		expect(result.normal[4]).toEqual({ available: true, text: "cleaned" });
		expect(result.normal[5]).toEqual({
			available: true,
			ok: true,
			output: "tool-result",
		});
		expect(result.normal[6]).toMatchObject({
			available: true,
			sidecars: [{ name: "fixture", running: true }],
		});
		expect(result.normal[7]).toEqual({ available: true, success: true });
		expect(result.normal[8]).toMatchObject({
			available: true,
			agents: [{ id: "fixture", builtIn: true }],
		});
		expect(result.normal[9]).toEqual({
			available: true,
			config: { configOptions: null, models: null, modes: null },
		});
		expect(result.normal[10]).toMatchObject({
			available: true,
			models: { fixture: [{ id: "small" }] },
		});
		expect(result.normal[11]).toEqual({
			available: true,
			conversations: [{ id: "thread", title: "Untitled" }],
		});
		for (const outcome of result.stalled) {
			expect(outcome).toEqual({ available: false, reason: "timeout" });
		}
		expect(result.elapsedMs).toBeGreaterThanOrEqual(119_000);
		const deadline = Date.now() + 1000;
		while (closed < 6 && Date.now() < deadline) {
			await Bun.sleep(5);
		}
		expect(closed).toBe(6);
	} finally {
		server.stop(true);
		await rm(root, { recursive: true, force: true });
	}
}, 150_000);
