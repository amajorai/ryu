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

test("chat and proactive terminal responses release held HTTP bodies", async () => {
	const root = await mkdtemp(join(tmpdir(), "ryu-island-chat-stream-"));
	let closed = 0;
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(req) {
			const body = z
				.object({ agent_id: z.string().optional() })
				.parse(await req.json());
			const rejected = body.agent_id === "rejected";
			const frame =
				'data: {"type":"text-delta","delta":"hello"}\n\ndata: [DONE]\n\n';
			return new Response(
				new ReadableStream({
					start(controller) {
						controller.enqueue(new TextEncoder().encode(frame));
					},
					cancel() {
						closed++;
					},
				}),
				{ status: rejected ? 403 : 200 }
			);
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
			coreSource.replaceAll("../../shared/acp.ts", "./acp.ts")
		);
		await writeFile(
			join(root, "config.ts"),
			`export const coreHeaders=()=>({}); export const loadConfig=()=>({coreBaseUrl:${JSON.stringify(server.url.toString().replace(/\/$/, ""))}});`
		);
		await writeFile(
			join(root, "run.ts"),
			'import {chatStream,runAgentText} from "./core.ts"; const results=await Promise.all([...["done","rejected"].map(id=>new Promise(resolve=>{const chunks=[];chatStream({agent_id:id,messages:[]}, {part:event=>chunks.push(event.part.delta),end:event=>resolve({chunks,reason:event.reason})});})),runAgentText("done",[]),runAgentText("rejected",[])]); process.stdout.write(JSON.stringify(results)); await Bun.sleep(2000);'
		);
		const child = Bun.spawn([process.execPath, join(root, "run.ts")], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const reader = child.stdout.getReader();
		const first = await reader.read();
		const results = JSON.parse(new TextDecoder().decode(first.value));
		expect(results).toEqual([
			{ chunks: ["hello"], reason: "done" },
			{ chunks: [], reason: "error" },
			{ available: true, text: "hello" },
			{ available: false, reason: "core responded 403" },
		]);
		const deadline = Date.now() + 1000;
		while (closed < 4 && Date.now() < deadline) {
			await Bun.sleep(5);
		}
		expect(closed).toBe(4);
		expect(await child.exited).toBe(0);
		reader.releaseLock();
	} finally {
		server.stop(true);
		await rm(root, { recursive: true, force: true });
	}
}, 10_000);
