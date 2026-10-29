import { z } from "zod";
// packages/client/src/spaces.test.ts
//
// Tests for SpacesAPI: the SpaceWire/MatchWire mappers via mocked list/search,
// the search request body (query always sent; limit only when provided), and a
// drift guard over the two doc blocks this package PUBLISHES.
//
// The doc guard is not style policing. `SpacesAPI.search` said "Run a KNN
// similarity search within a Space" for the whole life of Core's graph retrieval
// mode, and `SpaceMatch.distance` said "squared L2 distance from the query
// vector" for results that are frequently a hard-coded `0.0` or `1.0`. Both ship
// to npm inside `dist/index.d.ts`, so they are what a consumer's editor shows —
// a wrong sentence there is a wrong sentence in someone else's codebase.
//
// Three copies of this prose exist (here, `@ryuhq/core-client`, and the desktop's
// own `apps/desktop/src/lib/api/spaces.ts`) and they cannot be sourced from one
// module without a dependency edge between separately published packages or
// codegen. So each copy carries its own guard, and each guard also anchors the
// Rust it now describes — a doc-only assertion would keep passing if Core dropped
// the branch, at which point the corrected wording becomes the overclaim.

import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { RetrievalModeStatus } from "./index.ts";
import { SpacesAPI } from "./spaces.ts";
import { installFetch } from "./test-fetch.ts";
import type { RyuClientOptions } from "./types.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

const OPTIONS: RyuClientOptions = { baseUrl: "http://localhost:7980" };

interface CapturedRequest {
	init?: RequestInit;
	url?: string;
}

function stubJson(
	payload: z.core.util.JSONType,
	status = 200
): CapturedRequest {
	const captured: CapturedRequest = {};
	installFetch((input, init) => {
		captured.url = String(input);
		captured.init = init;
		return Promise.resolve(Response.json(payload, { status }));
	});
	return captured;
}

function statusWire(overrides: Record<string, z.core.util.JSONType> = {}) {
	return {
		job_id: "job-1",
		space_id: "space-1",
		requested_mode: "graph",
		previous_mode: "vector",
		state: "running",
		total_chunks: 4,
		processed_chunks: 2,
		graph_nodes: 3,
		graph_edges: 5,
		change: null,
		error: null,
		...overrides,
	};
}

const COMPLETED_CHANGE = {
	previous: "vector",
	mode: "graph",
	changed: true,
	graph_rebuilt: true,
	chunks_scanned: 4,
	graph_nodes: 8,
	graph_edges: 12,
};

describe("SpacesAPI.list", () => {
	test("maps snake_case spaces including document_count", async () => {
		installFetch(() =>
			Promise.resolve(
				Response.json({
					spaces: [
						{
							id: "s1",
							name: "Docs",
							created_at: 100,
							updated_at: 200,
							document_count: 5,
						},
					],
				})
			)
		);
		const list = await new SpacesAPI(OPTIONS).list();
		expect(list[0]).toEqual({
			id: "s1",
			name: "Docs",
			description: null,
			createdAt: 100,
			updatedAt: 200,
			documentCount: 5,
			retrievalMode: "vector",
		});
	});

	test("maps an explicit graph retrieval mode", async () => {
		stubJson({
			spaces: [
				{
					id: "graph-space",
					name: "Graph docs",
					created_at: 100,
					updated_at: 200,
					document_count: 2,
					retrieval_mode: "graph",
				},
			],
		});
		expect((await new SpacesAPI(OPTIONS).list())[0]?.retrievalMode).toBe(
			"graph"
		);
	});

	test("rejects a list response when spaces is absent", async () => {
		installFetch(() => Promise.resolve(new Response("{}")));
		await expect(new SpacesAPI(OPTIONS).list()).rejects.toThrow(
			"invalid spaces list response"
		);
	});
});

describe("SpacesAPI.create", () => {
	test("serializes create with and without retrieval_mode", async () => {
		const defaultRequest = stubJson({ id: "space-1" });
		expect(await new SpacesAPI(OPTIONS).create("Docs", null)).toBe("space-1");
		expect(JSON.parse(String(defaultRequest.init?.body))).toEqual({
			name: "Docs",
			description: null,
		});

		const graphRequest = stubJson({ id: "space-graph" });
		await new SpacesAPI(OPTIONS).create("Graph", "Linked docs", "graph");
		expect(JSON.parse(String(graphRequest.init?.body))).toEqual({
			name: "Graph",
			description: "Linked docs",
			retrieval_mode: "graph",
		});
	});
});

describe("SpacesAPI retrieval-mode jobs", () => {
	test("parses an accepted 202 job and encodes the Space id", async () => {
		const captured = stubJson(
			{
				success: true,
				job_id: "job-1",
				space_id: "space/alpha",
				retrieval_mode: "graph",
				status: "/api/spaces/space/alpha/retrieval-mode/status",
				cancel: "/api/spaces/space/alpha/retrieval-mode/cancel",
			},
			202
		);
		expect(
			await new SpacesAPI(OPTIONS).startRetrievalModeChange(
				"space/alpha",
				"graph"
			)
		).toEqual({
			jobId: "job-1",
			spaceId: "space/alpha",
			retrievalMode: "graph",
			statusPath:
				"/api/spaces/space%2Falpha/retrieval-mode/status?job_id=job-1",
			cancelPath: "/api/spaces/space%2Falpha/retrieval-mode/cancel",
		});
		expect(captured.url).toBe(
			"http://localhost:7980/api/spaces/space%2Falpha/retrieval-mode"
		);
		expect(JSON.parse(String(captured.init?.body))).toEqual({
			retrieval_mode: "graph",
		});
	});

	test("parses running and cancelling progress", async () => {
		const activeStates: readonly ("cancelling" | "running")[] = [
			"running",
			"cancelling",
		];
		for (const state of activeStates) {
			stubJson(statusWire({ state }));
			const status: RetrievalModeStatus = await new SpacesAPI(
				OPTIONS
			).getRetrievalModeStatus("space-1", "job-1");
			expect(status.state).toBe(state);
			expect(status.change).toBeNull();
			expect(status.error).toBeNull();
			expect(status.processedChunks).toBe(2);
		}
	});

	test("parses completed, failed, and cancelled states", async () => {
		stubJson(
			statusWire({
				state: "completed",
				processed_chunks: 4,
				graph_nodes: 8,
				graph_edges: 12,
				change: COMPLETED_CHANGE,
			})
		);
		const completed = await new SpacesAPI(OPTIONS).getRetrievalModeStatus(
			"space-1",
			"job-1"
		);
		expect(completed.change).toEqual({
			previous: "vector",
			mode: "graph",
			changed: true,
			graphRebuilt: true,
			chunksScanned: 4,
			graphNodes: 8,
			graphEdges: 12,
		});

		stubJson(statusWire({ state: "failed", error: "disk full" }));
		const failed = await new SpacesAPI(OPTIONS).getRetrievalModeStatus(
			"space-1",
			"job-1"
		);
		expect(failed.state).toBe("failed");
		expect(failed.error).toBe("disk full");

		stubJson(statusWire({ state: "cancelled" }));
		const cancelled = await new SpacesAPI(OPTIONS).getRetrievalModeStatus(
			"space-1",
			"job-1"
		);
		expect(cancelled.state).toBe("cancelled");
		expect(cancelled.error).toBeNull();
	});

	test("encodes status ids and parses cancellation", async () => {
		const statusRequest = stubJson(
			statusWire({ space_id: "space/alpha", job_id: "job?one" })
		);
		await new SpacesAPI(OPTIONS).getRetrievalModeStatus(
			"space/alpha",
			"job?one"
		);
		expect(statusRequest.url).toBe(
			"http://localhost:7980/api/spaces/space%2Falpha/retrieval-mode/status?job_id=job%3Fone"
		);

		const cancelRequest = stubJson({ cancelled: true });
		expect(
			await new SpacesAPI(OPTIONS).cancelRetrievalModeChange(
				"space/alpha",
				"job?one"
			)
		).toEqual({ cancelled: true });
		expect(cancelRequest.url).toBe(
			"http://localhost:7980/api/spaces/space%2Falpha/retrieval-mode/cancel"
		);
		expect(JSON.parse(String(cancelRequest.init?.body))).toEqual({
			job_id: "job?one",
		});
	});

	test("rejects invalid wire responses", async () => {
		const api = new SpacesAPI(OPTIONS);
		stubJson({ id: 7 });
		await expect(api.create("Docs")).rejects.toThrow(
			"invalid create-space response"
		);

		stubJson({
			success: false,
			job_id: "job-1",
			space_id: "space-1",
			retrieval_mode: "graph",
			status: "/status",
			cancel: "/cancel",
		});
		await expect(
			api.startRetrievalModeChange("space-1", "graph")
		).rejects.toThrow("invalid retrieval-mode job response");

		stubJson({
			success: true,
			job_id: "job-1",
			space_id: "wrong-space",
			retrieval_mode: "graph",
			status: "/untrusted/status",
			cancel: "/untrusted/cancel",
		});
		await expect(
			api.startRetrievalModeChange("space-1", "graph")
		).rejects.toThrow("invalid retrieval-mode job response");

		stubJson(statusWire({ total_chunks: -1 }));
		await expect(
			api.getRetrievalModeStatus("space-1", "job-1")
		).rejects.toThrow("invalid retrieval-mode status response");

		stubJson(statusWire({ job_id: "wrong-job" }));
		await expect(
			api.getRetrievalModeStatus("space-1", "job-1")
		).rejects.toThrow("invalid retrieval-mode status response");

		stubJson(statusWire({ state: "completed", change: null }));
		await expect(
			api.getRetrievalModeStatus("space-1", "job-1")
		).rejects.toThrow("invalid retrieval-mode status response");

		stubJson({ cancelled: "yes" });
		await expect(
			api.cancelRetrievalModeChange("space-1", "job-1")
		).rejects.toThrow("invalid retrieval-mode cancellation response");

		stubJson({
			spaces: [
				{
					id: "space-1",
					name: "Docs",
					created_at: 1,
					updated_at: 1,
					document_count: 0,
					retrieval_mode: "hybrid",
				},
			],
		});
		await expect(api.list()).rejects.toThrow("invalid space response");
	});
});

describe("SpacesAPI.search", () => {
	test("maps matches and sends only query when limit is omitted", async () => {
		let capturedBody: string | undefined;
		installFetch((_input: RequestInfo | URL, init?: RequestInit) => {
			capturedBody = z.string().parse(init?.body);
			return Promise.resolve(
				Response.json({
					matches: [
						{
							chunk_id: "ch1",
							document_id: "d1",
							content: "text",
							distance: 0.42,
						},
					],
				})
			);
		});
		const matches = await new SpacesAPI(OPTIONS).search("s1", "hello");
		expect(matches[0]).toEqual({
			chunkId: "ch1",
			documentId: "d1",
			content: "text",
			distance: 0.42,
		});
		expect(JSON.parse(capturedBody ?? "{}")).toEqual({ query: "hello" });
	});

	test("includes limit in the body when provided", async () => {
		let capturedBody: string | undefined;
		installFetch((_input: RequestInfo | URL, init?: RequestInit) => {
			capturedBody = z.string().parse(init?.body);
			return Promise.resolve(Response.json({ matches: [] }));
		});
		await new SpacesAPI(OPTIONS).search("s1", "hi", 3);
		expect(JSON.parse(capturedBody ?? "{}")).toEqual({ query: "hi", limit: 3 });
	});

	test("returns [] when matches is absent", async () => {
		installFetch(() => Promise.resolve(new Response("{}")));
		expect(await new SpacesAPI(OPTIONS).search("s1", "q")).toEqual([]);
	});
});

// ── Drift guard over the published prose ─────────────────────────────────────

// src → packages/client → packages → repo root.
const REPO_ROOT = join(import.meta.dir, "../../..");

/**
 * Read a file for a mirror assertion, throwing with the resolved path when it is
 * missing. Never returns "" on failure: a silent empty string passes every
 * `not.toContain` below, which would turn this guard into a no-op the day someone
 * moves a file or gets the `..` depth wrong.
 */
function sourceFile(relative: string): string {
	const path = join(REPO_ROOT, relative);
	try {
		return readFileSync(path, "utf8");
	} catch (e) {
		throw new Error(
			`spaces drift test cannot read ${relative} (resolved ${path}): ${
				e instanceof Error ? e.message : e
			}`
		);
	}
}

const SPACES_TS = "packages/client/src/spaces.ts";
const TYPES_TS = "packages/client/src/types.ts";
const SPACES_RS = "crates/core/spaces/src/lib.rs";
const SPACES_RETRIEVAL_RS = "crates/core/spaces/src/retrieval.rs";

/**
 * Body of one Rust fn, brace-matched from its header line. Brace-matched rather
 * than sliced by character count so an assertion can never silently read a
 * NEIGHBOURING function's code and pass on it.
 */
function rustFnBody(source: string, file: string, header: string): string {
	const start = source.indexOf(header);
	if (start === -1) {
		throw new Error(`${file} no longer contains \`${header}\` — anchor lost`);
	}
	const open = source.indexOf("{", start);
	if (open === -1) {
		throw new Error(`${file}: \`${header}\` has no body`);
	}
	let depth = 0;
	for (let i = open; i < source.length; i++) {
		if (source[i] === "{") {
			depth++;
		} else if (source[i] === "}") {
			depth--;
			if (depth === 0) {
				return source.slice(start, i + 1);
			}
		}
	}
	throw new Error(`${file}: unbalanced braces after \`${header}\``);
}

/** The doc block immediately above a declaration, by its exact header line. */
function docAbove(source: string, file: string, declaration: string): string {
	const decl = source.indexOf(declaration);
	if (decl === -1) {
		throw new Error(
			`${file} no longer contains \`${declaration}\` — this guard lost its target`
		);
	}
	const open = source.lastIndexOf("/**", decl);
	const close = source.lastIndexOf("*/", decl);
	if (open === -1 || close === -1 || close < open) {
		throw new Error(
			`\`${declaration}\` in ${file} has no JSDoc block — the published description is gone`
		);
	}
	return source.slice(open, close);
}

describe("the search description this package publishes", () => {
	const doc = docAbove(sourceFile(SPACES_TS), SPACES_TS, "async search(");

	test("names the graph branch, not just vector search", () => {
		expect(doc).toContain("retrieval_mode");
		expect(doc).toContain("graph");
		expect(doc.toLowerCase()).toContain("traversal");
	});

	test("does not describe the call as a KNN search", () => {
		// The word may appear (the vector branch really is a KNN), but not as the
		// unqualified description of the whole call. Both historic spellings.
		expect(doc).not.toContain("Run a KNN similarity search");
		expect(doc).not.toContain("Run a KNN search");
	});

	test("warns that graph results are bounded rather than exhaustive", () => {
		expect(doc.toLowerCase()).toContain("bounded");
		expect(doc.toLowerCase()).toContain("exhaustive");
	});
});

describe("the SpaceMatch.distance description this package publishes", () => {
	const doc = docAbove(sourceFile(TYPES_TS), TYPES_TS, "distance: number;");

	test("no longer claims every distance is a query-vector metric", () => {
		expect(doc).not.toContain("Squared L2 distance from the query vector");
	});

	test("names the two synthetic values and the rerank reorder", () => {
		expect(doc).toContain("0.0");
		expect(doc).toContain("1.0");
		expect(doc.toLowerCase()).toContain("rerank");
	});
});

describe("the Core behaviour those docs now claim", () => {
	const spacesRs = sourceFile(SPACES_RS);

	test("Space search still branches on the Space's retrieval mode", () => {
		// Without this half the doc tests are a spellcheck: someone could collapse
		// Core back to a single branch and every assertion above would still pass
		// while the published description promised a capability that was gone.
		// `search_ext` is `search_with` with default options; the per-query
		// candidate collection in `retrieval.rs` is where the mode is read.
		const body = rustFnBody(
			sourceFile(SPACES_RETRIEVAL_RS),
			SPACES_RETRIEVAL_RS,
			"async fn collect_candidates("
		);
		expect(body).toContain("let mode = self.space_mode(space_id).await?;");
		expect(body).toContain("RetrievalMode::Graph => {");
		expect(body).toContain("self.graph_search(");
		expect(body).toContain("RetrievalMode::Vector => {");
		expect(body).toContain("self.vector_search(");
	});

	test("distance is still a metric in one branch and a constant in the others", () => {
		expect(spacesRs).toContain(
			"// Synthetic distance: 0.0 = direct entity hit."
		);
		expect(spacesRs).toContain(
			"// Synthetic: link-reached chunks re-scored by the reranker."
		);
	});

	test("the reranker reorders without rewriting distance", () => {
		// The doc tells callers that array order, not `distance`, is the ranking.
		// That is only true while `apply_reranking` clones candidates through
		// unchanged; a version that stamped the cross-encoder score onto `distance`
		// would make sorting by it correct again.
		const body = rustFnBody(spacesRs, SPACES_RS, "async fn apply_reranking(");
		// The proof is positive and specific: the cross-encoder score is bound to
		// `_score` and thrown away, and the surviving chunk is pushed through as a
		// clone. A `not.toContain("distance =")` here would be theatre — the
		// realistic mutation is a struct literal (`ChunkMatch { .., distance: score
		// }`), which that string never matches.
		expect(body).toContain(
			"for (idx, _score) in ranked.into_iter().take(limit)"
		);
		expect(body).toContain("reordered.push(chunk.clone());");
	});
});

describe("SpacesAPI.queryDatabase", () => {
	test("encodes the database path and binds JSON parameters", async () => {
		const captured = stubJson({
			columns: ["name", "total"],
			rows: [["Ryu", 3]],
			schema: [{ id: "name", label: "Name", name: "name" }],
			truncated: false,
		});
		const result = await new SpacesAPI(OPTIONS).queryDatabase(
			"space/one",
			"database two",
			{
				query: "SELECT name, COUNT(*) AS total FROM data WHERE name = ?",
				parameters: ["Ryu"],
			}
		);
		expect(captured.url).toBe(
			"http://localhost:7980/api/spaces/space%2Fone/databases/database%20two/query"
		);
		expect(JSON.parse(String(captured.init?.body))).toEqual({
			query: "SELECT name, COUNT(*) AS total FROM data WHERE name = ?",
			parameters: ["Ryu"],
		});
		expect(result.rows).toEqual([["Ryu", 3]]);
		expect(result.schema[0]?.name).toBe("name");
	});

	test("rejects a malformed query result", async () => {
		stubJson({ columns: [], rows: [[]], schema: [], truncated: "false" });
		await expect(
			new SpacesAPI(OPTIONS).queryDatabase("space-1", "database-1", {
				query: "SELECT * FROM data",
			})
		).rejects.toThrow("invalid database query response");
	});
});
