// apps/desktop/src/lib/api/import-archive.test.ts
//
// The archive client against a real HTTP server: the zip goes up as raw
// bytes, Core's preview comes back typed, and a refusal carries Core's reason.

import { afterAll, describe, expect, test } from "bun:test";
import {
	ArchiveRefusedError,
	archiveTotals,
	discardImportArchive,
	stageImportArchive,
} from "./import-archive.ts";

interface Upload {
	bytes: number;
	contentType: string | null;
}

const uploads: Upload[] = [];
const discards: unknown[] = [];
let reply: { status: number; body: unknown } = { status: 200, body: {} };

const STAGED = {
	archive: {
		bots: [
			{
				conversations: 1,
				description: "Finds and sums up papers.",
				files: 2,
				has_instructions: true,
				key: "research",
				memories: 2,
				name: "Research helper",
				not_exported: ["older conversations"],
				routines: [{ name: "Morning digest", schedule: "every day 08:00" }],
				skills: 1,
			},
			{ key: "writer", name: "Writer", has_instructions: true },
		],
		exported_at: "2026-11-17T10:00:00Z",
		format: "ryu-bot-export",
		ignored_entries: 2,
		left_out_entries: 1,
		source_app: "Grok Bot",
		version: 1,
	},
	items: [
		{
			id: "agent/bots/research/SOUL.md",
			kind: "agent",
			title: "Agent 'Research helper' from Grok Bot",
		},
		{
			detail: "Becomes a project folder. Adds 2 knowledge files.",
			id: "conversations/bots/research",
			kind: "conversations",
			title: "Project 'Research helper' from Grok Bot (1 chat)",
		},
	],
	root: "/data/tmp/import-staging/0123456789abcdef",
	source: "grok-bot",
	warnings: ["Routines of Research helper are not imported."],
};

const core = Bun.serve({
	port: 0,
	async fetch(request) {
		const url = new URL(request.url);
		if (request.method !== "POST") {
			return new Response("not found", { status: 404 });
		}
		if (url.pathname === "/api/import/archive/stage") {
			uploads.push({
				bytes: (await request.arrayBuffer()).byteLength,
				contentType: request.headers.get("content-type"),
			});
			return Response.json(reply.body, { status: reply.status });
		}
		if (url.pathname === "/api/import/archive/discard") {
			discards.push(await request.json());
			return Response.json(reply.body, { status: reply.status });
		}
		return new Response("not found", { status: 404 });
	},
});

const target = { token: "synthetic", url: core.url.origin, userJwt: null };

afterAll(() => {
	core.stop(true);
});

describe("stageImportArchive", () => {
	test("uploads the zip as raw bytes and types Core's preview", async () => {
		uploads.length = 0;
		reply = { status: 200, body: STAGED };
		const staged = await stageImportArchive(
			target,
			new Blob([new Uint8Array(1234)])
		);

		expect(uploads).toEqual([{ bytes: 1234, contentType: "application/zip" }]);
		expect(staged.scan.root).toBe("/data/tmp/import-staging/0123456789abcdef");
		expect(staged.scan.source).toBe("grok-bot");
		expect(staged.scan.items.map((item) => item.kind)).toEqual([
			"agent",
			"conversations",
		]);
		expect(staged.scan.warnings).toEqual([
			"Routines of Research helper are not imported.",
		]);
		expect(staged.archive.sourceApp).toBe("Grok Bot");
		expect(staged.archive.bots[0]).toEqual({
			conversations: 1,
			description: "Finds and sums up papers.",
			files: 2,
			hasInstructions: true,
			key: "research",
			memories: 2,
			name: "Research helper",
			notExported: ["older conversations"],
			routines: 1,
			skills: 1,
		});
		// A bot with only a key and a name: every count reads as 0.
		expect(staged.archive.bots[1]).toMatchObject({
			conversations: 0,
			description: "",
			files: 0,
			memories: 0,
			routines: 0,
			skills: 0,
		});
		expect(archiveTotals(staged.archive)).toEqual({
			bots: 2,
			conversations: 1,
			files: 2,
			memories: 2,
			skills: 1,
		});
	});

	test("throws Core's reason when the zip is refused", async () => {
		reply = {
			status: 400,
			body: {
				error:
					"the zip holds an entry that points outside the archive: ../x.txt",
			},
		};
		const refusal = await stageImportArchive(target, new Blob(["x"])).catch(
			(error: unknown) => error
		);
		expect(refusal).toBeInstanceOf(ArchiveRefusedError);
		expect(refusal).toMatchObject({
			reason:
				"the zip holds an entry that points outside the archive: ../x.txt",
			status: 400,
		});
	});

	test("keeps the status when Core sends no reason", async () => {
		reply = { status: 413, body: "too large" };
		const refusal = await stageImportArchive(target, new Blob(["x"])).catch(
			(error: unknown) => error
		);
		expect(refusal).toMatchObject({ reason: undefined, status: 413 });
	});

	test("rejects a preview without a bot list", async () => {
		reply = { status: 200, body: { ...STAGED, archive: { source_app: "x" } } };
		await expect(stageImportArchive(target, new Blob(["x"]))).rejects.toThrow();
	});
});

describe("discardImportArchive", () => {
	test("names the staging folder and reports what Core did", async () => {
		discards.length = 0;
		reply = { status: 200, body: { discarded: true } };
		expect(await discardImportArchive(target, "/data/staging/abc")).toBe(true);
		expect(discards).toEqual([{ path: "/data/staging/abc" }]);

		reply = { status: 200, body: { discarded: false } };
		expect(await discardImportArchive(target, "/elsewhere")).toBe(false);
		reply = { status: 403, body: { error: "forbidden" } };
		expect(await discardImportArchive(target, "/data/staging/abc")).toBe(false);
	});
});
