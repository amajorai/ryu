import { afterAll, describe, expect, test } from "bun:test";
import { z } from "zod";
import {
	querySpaceDatabase,
	setSpaceRetrievalMode,
	setSpaceVisibility,
	updateDocument,
} from "./spaces.ts";

const bodies: string[] = [];
let databaseReply =
	'{"columns":["value"],"rows":[[{"__proto__":{"future":true},"extra":[1,null]}]],"schema":[{"id":"value","label":"Value","name":"value","future":true}],"truncated":false,"future":true}';
let statusState = "completed";
let runningReads = 0;
const server = Bun.serve({
	port: 0,
	async fetch(request) {
		const url = new URL(request.url);
		if (request.method !== "GET") {
			bodies.push(await request.text());
		}
		if (url.pathname.endsWith("/query")) {
			return new Response(databaseReply, {
				headers: { "content-type": "application/json" },
			});
		}
		if (url.pathname.endsWith("/retrieval-mode")) {
			return Response.json({
				job_id: "job",
				space_id: "space",
				requested_mode: "graph",
			});
		}
		if (url.pathname.endsWith("/retrieval-mode/status")) {
			if (runningReads > 0) {
				runningReads -= 1;
				return Response.json({
					job_id: "job",
					space_id: "space",
					state: "running",
					change: null,
					error: null,
				});
			}
			return Response.json({
				job_id: "job",
				space_id: "space",
				state: statusState,
				error: null,
				change: {
					changed: true,
					graph_rebuilt: true,
					mode: "graph",
					previous: "vector",
					chunks_scanned: 4,
				},
			});
		}
		return Response.json({ result: { revision: 7, changed: true } });
	},
});
const target = { token: null, url: server.url.origin };
afterAll(() => server.stop(true));

describe("Spaces HTTP wire boundaries", () => {
	test("keeps nested future JSON data while projecting database schema fields", async () => {
		const result = await querySpaceDatabase(
			target,
			"space",
			"db",
			"SELECT value FROM data"
		);
		expect(result.rows[0]?.[0]).toEqual(
			JSON.parse('{"__proto__":{"future":true},"extra":[1,null]}')
		);
		expect(result.schema).toEqual([
			{ id: "value", label: "Value", name: "value" },
		]);
	});
	test("distinguishes malformed rows and malformed column metadata", async () => {
		const original = databaseReply;
		try {
			databaseReply =
				'{"columns":["value"],"rows":[1],"schema":[],"truncated":false}';
			await expect(
				querySpaceDatabase(target, "space", "db", "SELECT 1")
			).rejects.toThrow("invalid database query response");
			databaseReply =
				'{"columns":["value"],"rows":[[1]],"schema":[{"id":1}],"truncated":false}';
			await expect(
				querySpaceDatabase(target, "space", "db", "SELECT 1")
			).rejects.toThrow("invalid database query schema");
		} finally {
			databaseReply = original;
		}
	});
	test("observes only a completed matching retrieval job", async () => {
		runningReads = 1;
		expect(await setSpaceRetrievalMode(target, "space", "graph")).toMatchObject(
			{
				mode: "graph",
				previous: "vector",
				changed: true,
				graphRebuilt: true,
				chunksScanned: 4,
			}
		);
		try {
			statusState = "future-state";
			await expect(
				setSpaceRetrievalMode(target, "space", "graph")
			).rejects.toThrow("unknown retrieval-mode job state");
		} finally {
			statusState = "completed";
		}
	});
	test("omits inactive team and revision fields and includes explicit guards", async () => {
		await setSpaceVisibility(target, "space", "org", "team");
		expect(JSON.parse(bodies.at(-1) ?? "null")).toEqual({ visibility: "org" });
		await setSpaceVisibility(target, "space", "team", "team");
		expect(JSON.parse(bodies.at(-1) ?? "null")).toEqual({
			visibility: "team",
			team_id: "team",
		});
		await updateDocument(target, "space", "doc", "Title", "Source");
		expect(JSON.parse(bodies.at(-1) ?? "null")).toEqual({
			title: "Title",
			source: "Source",
		});
		await updateDocument(target, "space", "doc", "Title", "Source", {
			expectedRevision: 6,
			operationId: "op",
		});
		expect(
			z
				.object({ expected_revision: z.number(), operation_id: z.string() })
				.parse(JSON.parse(bodies.at(-1) ?? "null"))
		).toEqual({ expected_revision: 6, operation_id: "op" });
	});
});
