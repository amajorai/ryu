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

test("plugin probes and invokes keep their deadlines through response consumption", async () => {
	const root = await mkdtemp(join(tmpdir(), "ryu-island-plugin-"));
	let contributionCalls = 0;
	let closed = 0;
	const server = Bun.serve({
		hostname: "127.0.0.1",
		idleTimeout: 150,
		port: 0,
		fetch(req) {
			const path = new URL(req.url).pathname;
			if (
				path.includes("slow") ||
				(path.endsWith("contributions") && ++contributionCalls > 1)
			) {
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
			if (path.includes("missing")) {
				return new Response("missing", { status: 404 });
			}
			if (path.includes("denied")) {
				return Response.json(
					{ error: { code: "denied", message: "fixture denied" } },
					{ status: 403 }
				);
			}
			if (path.endsWith("contributions")) {
				return Response.json({ companions: [], views: [] });
			}
			if (path.endsWith("ui-bundle")) {
				return Response.json({ code: "fixture-code" });
			}
			if (path.endsWith("host")) {
				return Response.json({ result: { value: 2 } });
			}
			return Response.json({ value: 1 });
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
			`export const coreHeaders = () => ({}); export const loadConfig = () => ({ coreBaseUrl: ${JSON.stringify(server.url.toString().replace(/\/$/, ""))} });`
		);
		await writeFile(
			join(root, "run.ts"),
			'import * as host from "./plugin-host.ts"; const normal = await Promise.all([host.pluginContributions(), host.pluginUiBundle("fixture"), host.pluginUiBundle("missing"), host.pluginHostInvoke("fixture", "storage.get", {}), host.pluginHostInvoke("denied", "storage.get", {}), host.pluginCoreHttp({ method: "GET", path: "/api/okay" })]); const began = performance.now(); const stalled = await Promise.all([host.pluginContributions(), host.pluginUiBundle("slow"), host.pluginHostInvoke("slow", "storage.get", {}), host.pluginCoreHttp({ method: "GET", path: "/api/slow" })]); process.stdout.write(JSON.stringify({ normal, stalled, elapsedMs: performance.now() - began }));'
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
		expect(result.normal).toEqual([
			{ available: true, companions: [], views: [] },
			{ available: true, code: "fixture-code" },
			{ available: true, code: null },
			{ ok: true, result: { value: 2 } },
			{ ok: false, code: "denied", message: "fixture denied" },
			{ ok: true, status: 200, data: { value: 1 } },
		]);
		expect(result.stalled).toEqual([
			{ available: false, reason: "timeout" },
			{ available: false, reason: "timeout" },
			{ ok: false, code: "server_error", message: "timeout" },
			{ ok: false, code: "server_error", message: "timeout" },
		]);
		expect(result.elapsedMs).toBeGreaterThanOrEqual(119_000);
		const deadline = Date.now() + 1000;
		while (closed < 4 && Date.now() < deadline) {
			await Bun.sleep(5);
		}
		expect(closed).toBe(4);
	} finally {
		server.stop(true);
		await rm(root, { recursive: true, force: true });
	}
}, 150_000);
