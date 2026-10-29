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

test("transcribe honors engine, filename, and detailed options and surfaces Core errors", async () => {
	const root = await mkdtemp(join(tmpdir(), "ryu-island-transcribe-"));
	const seen: { search: string; filename: string }[] = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(req) {
			const url = new URL(req.url);
			const form = await req.formData();
			const file = form.get("file");
			seen.push({
				search: url.search,
				filename: file instanceof File ? file.name : "",
			});
			if (url.searchParams.get("engine") === "broken") {
				return Response.json(
					{ error: "Voice engine is not installed" },
					{ status: 503 }
				);
			}
			return Response.json({
				text: " hello there ",
				segments: [{ startMs: 0, endMs: 900, text: "hello there" }],
			});
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
			`export const coreHeaders = () => ({}); export const loadConfig = () => ({ coreBaseUrl: ${JSON.stringify(server.url.toString().replace(/\/$/, ""))} });`
		);
		await writeFile(
			join(root, "run.ts"),
			'import * as core from "./core.ts"; const audio = new Uint8Array([82,73,70,70]).buffer; const out = [await core.transcribe(audio, "parakeet"), await core.transcribe(audio, "", core.transcribeOptions({ detailed: true, filename: "clip.wav" })), await core.transcribe(audio, "broken"), core.transcribeOptions({ detailed: "yes", filename: "../x" }), core.transcribeOptions(null)]; process.stdout.write(JSON.stringify(out));'
		);
		const child = Bun.spawn([process.execPath, join(root, "run.ts")], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const out = z
			.array(z.json())
			.parse(await new Response(child.stdout).json());
		expect(await child.exited).toBe(0);
		expect(out[0]).toEqual({ available: true, text: " hello there " });
		expect(out[1]).toEqual({
			available: true,
			text: "hello there",
			detail: {
				text: "hello there",
				segments: [{ startMs: 0, endMs: 900, text: "hello there" }],
			},
		});
		expect(out[2]).toEqual({
			available: false,
			reason: "Voice engine is not installed",
		});
		expect(out[3]).toEqual({});
		expect(out[4]).toEqual({});
		expect(seen).toEqual([
			{ search: "?engine=parakeet", filename: "audio.wav" },
			{ search: "", filename: "clip.wav" },
			{ search: "?engine=broken", filename: "audio.wav" },
		]);
	} finally {
		server.stop(true);
		await rm(root, { recursive: true, force: true });
	}
});
