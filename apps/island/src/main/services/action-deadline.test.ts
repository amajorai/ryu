import { expect, test } from "bun:test";
import { copyFile, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

test("meeting and task actions preserve outcomes and bound stalled bodies", async () => {
	const root = await mkdtemp(join(tmpdir(), "ryu-island-actions-"));
	let closed = 0;
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(req) {
			const path = new URL(req.url).pathname;
			if (path.includes("slow")) {
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
				return Response.json({});
			}
			if (path.includes("error")) {
				return new Response("unavailable", { status: 503 });
			}
			return Response.json(
				path.startsWith("/api/meetings")
					? {
							meeting: { id: "fixture", status: "recording", title: "Fixture" },
						}
					: { quest: { id: "fixture", status: "active", title: "Task" } }
			);
		},
	});
	try {
		await symlink(
			join(import.meta.dirname, "../../../node_modules"),
			join(root, "node_modules"),
			"dir"
		);
		for (const name of [
			"meetings.ts",
			"activity-contract.ts",
			"quests.ts",
			"response-deadline.ts",
			"reconnect-delay.ts",
			"sse-reader.ts",
		]) {
			await copyFile(join(import.meta.dirname, name), join(root, name));
		}
		await writeFile(
			join(root, "config.ts"),
			`export const coreHeaders = () => ({}); export const loadConfig = () => ({ coreBaseUrl: ${JSON.stringify(server.url.toString().replace(/\/$/, ""))} });`
		);
		await writeFile(
			join(root, "run.ts"),
			'import * as meetings from "./meetings.ts"; import * as quests from "./quests.ts"; const results = await Promise.all([meetings.startMeeting({ title: "Fixture" }), meetings.finalizeMeeting("missing"), quests.acceptQuest("fixture"), quests.dismissQuest("error"), meetings.finalizeMeeting("slow"), quests.acceptQuest("slow")]); process.stdout.write(JSON.stringify(results));'
		);
		const child = Bun.spawn([process.execPath, join(root, "run.ts")], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const results = z
			.array(z.json())
			.parse(await new Response(child.stdout).json());
		expect(await child.exited).toBe(0);
		expect(results[0]).toEqual({
			available: true,
			meeting: { id: "fixture", status: "recording", title: "Fixture" },
		});
		expect(results[1]).toEqual({
			available: false,
			reason: "no meeting returned",
		});
		expect(results[2]).toEqual({
			available: true,
			quest: { id: "fixture", status: "active", title: "Task" },
		});
		expect(results[3]).toEqual({
			available: false,
			reason: "core responded 503",
		});
		for (const index of [4, 5]) {
			expect(results[index]).toMatchObject({ available: false });
		}
		const deadline = Date.now() + 1000;
		while (closed < 2 && Date.now() < deadline) {
			await Bun.sleep(5);
		}
		expect(closed).toBe(2);
	} finally {
		server.stop(true);
		await rm(root, { recursive: true, force: true });
	}
}, 18_000);
