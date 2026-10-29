import { expect, test } from "bun:test";
import { copyFile, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

test("catalog entrypoints retain mapping and time out a stalled skill response", async () => {
	const root = await mkdtemp(join(tmpdir(), "ryu-island-catalog-"));
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(req) {
			const path = new URL(req.url).pathname;
			if (path === "/api/skills/catalog") {
				return new Response(
					new ReadableStream({
						start(controller) {
							controller.enqueue(new TextEncoder().encode('{"skills":'));
						},
					})
				);
			}
			if (path === "/api/catalog/sources") {
				return Response.json({
					active: "fixture",
					sources: [{ id: "fixture", display_name: "Fixture" }],
				});
			}
			if (path === "/api/catalog/sources/select") {
				return new Response(null, { status: 204 });
			}
			if (path === "/api/mcp/catalog") {
				return Response.json({ servers: [{ id: "fixture" }] });
			}
			if (path === "/api/mcp/servers") {
				return Response.json({ servers: [{ name: "fixture" }] });
			}
			return Response.json({ success: true, result: {}, server: {} });
		},
	});
	try {
		await symlink(
			join(import.meta.dirname, "../../../../../node_modules"),
			join(root, "node_modules"),
			"dir"
		);
		for (const name of ["catalog.ts", "response-deadline.ts"]) {
			await copyFile(join(import.meta.dirname, name), join(root, name));
		}
		await writeFile(
			join(root, "config.ts"),
			`export const coreHeaders = () => ({}); export const loadConfig = () => ({ coreBaseUrl: ${JSON.stringify(server.url.toString().replace(/\/$/, ""))} });`
		);
		await writeFile(
			join(root, "run.ts"),
			'import * as catalog from "./catalog.ts"; const results = [await catalog.sources("mcp"), await catalog.list("mcp", ""), await catalog.selectSource("mcp", "fixture"), await catalog.install("skill", "fixture"), await catalog.install("mcp", "fixture"), await catalog.list("skill", "")]; process.stdout.write(JSON.stringify(results));'
		);
		const child = Bun.spawn([process.execPath, join(root, "run.ts")], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const result = z
			.array(z.json())
			.parse(await new Response(child.stdout).json());
		expect(await child.exited).toBe(0);
		expect(result[0]).toMatchObject({ sources: [{ displayName: "Fixture" }] });
		expect(result[1]).toMatchObject({ items: [{ installed: true }] });
		for (const index of [2, 3, 4]) {
			expect(result[index]).toEqual({ available: true, ok: true });
		}
		expect(result[5]).toEqual({ available: false, reason: "timeout" });
	} finally {
		server.stop(true);
		await rm(root, { recursive: true, force: true });
	}
}, 15_000);
