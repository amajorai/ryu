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

const cancelBodySchema = z.object({ conversation_id: z.string() });

// Core drives a persisted chat turn independently of the request that started
// it, so Island's Stop must cancel the turn on Core, not only abort the fetch.
test("aborting a persisted chat stream cancels its turn on Core", async () => {
	const root = await mkdtemp(join(tmpdir(), "ryu-island-chat-cancel-"));
	const cancelled: string[] = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(req) {
			const url = new URL(req.url);
			if (url.pathname === "/api/chat/cancel") {
				cancelled.push(
					cancelBodySchema.parse(await req.json()).conversation_id
				);
				return Response.json({ cancelled: true });
			}
			// A turn that keeps streaming until the client goes away.
			return new Response(
				new ReadableStream({
					start(controller) {
						controller.enqueue(
							new TextEncoder().encode(
								'data: {"type":"text-delta","delta":"hi"}\n\n'
							)
						);
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
			`export const coreHeaders=(extra={})=>({...extra}); export const loadConfig=()=>({coreBaseUrl:${JSON.stringify(server.url.toString().replace(/\/$/, ""))}});`
		);
		await writeFile(
			join(root, "run.ts"),
			[
				'import {abortStream,chatStream} from "./core.ts";',
				"const run=(req)=>new Promise(resolve=>{const handle=chatStream(req,{part:()=>{abortStream(handle.streamId);abortStream(handle.streamId);},end:event=>resolve(event.reason)});});",
				'const reasons=[await run({conversation_id:"conv-persisted",messages:[]}),await run({conversation_id:"conv-ephemeral",persist:false,messages:[]})];',
				"await Bun.sleep(200);",
				"process.stdout.write(JSON.stringify(reasons));",
			].join("\n")
		);
		const child = Bun.spawn([process.execPath, join(root, "run.ts")], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const output = await new Response(child.stdout).text();
		expect(await child.exited).toBe(0);
		expect(JSON.parse(output)).toEqual(["aborted", "aborted"]);
		// Once for the persisted turn, even though Stop was pressed twice; never
		// for a turn Core does not persist.
		expect(cancelled).toEqual(["conv-persisted"]);
	} finally {
		server.stop(true);
		await rm(root, { recursive: true, force: true });
	}
}, 10_000);
