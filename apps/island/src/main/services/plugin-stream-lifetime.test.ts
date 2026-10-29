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

test("plugin terminal frames release held HTTP bodies", async () => {
	const root = await mkdtemp(join(tmpdir(), "ryu-island-stream-"));
	let closed = 0;
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(req) {
			const failed = new URL(req.url).pathname.includes("/error/");
			const rejected = new URL(req.url).pathname.includes("/rejected/");
			const frame = failed
				? 'data: {"type":"error","errorText":"fixture error"}\n\n'
				: 'data: {"type":"text-delta","delta":"hello"}\n\ndata: [DONE]\n\n';
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
			join(import.meta.dirname, "../../shared/host-json.ts"),
			join(root, "host-json.ts")
		);
		for (const name of [
			"plugin-host.ts",
			"plugin-host-contract.ts",
			"response-deadline.ts",
			"sse.ts",
		]) {
			await copyFile(join(import.meta.dirname, name), join(root, name));
		}
		const hostSource = await readFile(join(root, "plugin-host.ts"), "utf8");
		await writeFile(
			join(root, "plugin-host.ts"),
			hostSource.replaceAll("../../shared/host-json.ts", "./host-json.ts")
		);
		await writeFile(
			join(root, "config.ts"),
			`export const coreHeaders=()=>({}); export const loadConfig=()=>({coreBaseUrl:${JSON.stringify(server.url.toString().replace(/\/$/, ""))}});`
		);
		await writeFile(
			join(root, "run.ts"),
			'import {startPluginHostStream} from "./plugin-host.ts"; const results=await Promise.all(["done","error","rejected"].map(id=>new Promise(resolve=>{const chunks=[];startPluginHostStream(id,{}, {chunk:delta=>chunks.push(delta),end:event=>resolve({chunks,reason:event.reason})});}))); process.stdout.write(JSON.stringify(results)); await Bun.sleep(2000);'
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
			{ chunks: [], reason: "error" },
		]);
		const deadline = Date.now() + 1000;
		while (closed < 3 && Date.now() < deadline) {
			await Bun.sleep(5);
		}
		expect(closed).toBe(3);
		expect(await child.exited).toBe(0);
		reader.releaseLock();
	} finally {
		server.stop(true);
		await rm(root, { recursive: true, force: true });
	}
}, 10_000);
