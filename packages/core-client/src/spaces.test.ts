import type { HttpFixtureBody } from "./test-support/http-fixture.ts";
// packages/core-client/src/spaces.test.ts
//
// Drift guard for the ONE sentence in this package that a language model reads.
//
// `searchSpace` here is what `apps/mcp/src/tools.ts` calls for the
// `ryu_search_space` MCP tool, so its doc block is not internal prose — it is the
// text a maintainer copies into a tool description, and therefore the text an
// agent uses to decide whether this tool can answer a multi-hop question. It said
// "Run a KNN similarity search within a Space" for the whole life of the graph
// retrieval mode: a model told KNN concludes the tool cannot follow a chain of
// entities, and stops asking. An under-claiming doc is a capability that ships
// dark.
//
// The same prose exists in three independently published places — here, in
// `@ryuhq/client` (`packages/client/src/spaces.ts`, a class API with its own
// bundled `dist/`), and in `apps/desktop/src/lib/api/spaces.ts` (coupled to the
// desktop's `ApiTarget`/`GlyphValue`). There is no way to source them from one
// module without adding a dependency edge between separately published packages
// or generating code — both build-system changes. So each copy carries this
// guard instead, and the guard has TWO halves on purpose:
//
//  1. A doc assertion. Fails if the copy regresses to calling this a KNN search.
//  2. A Rust anchor. Fails if Core stops branching on the mode — at which point
//     the *new* wording becomes the overclaim, and a doc-only test would happily
//     keep passing while the docs lied in the other direction.

import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ApiTarget } from "./client.ts";
import {
	cancelSpaceRetrievalModeChange,
	createSpace,
	fetchDocuments,
	fetchSpaceRetrievalModeStatus,
	fetchSpaces,
	type RetrievalModeStatus,
	searchSpace,
	startSpaceRetrievalModeChange,
} from "./spaces.ts";

const realFetch = globalThis.fetch;
const realPreconnect = globalThis.fetch.preconnect;
afterEach(() => {
	globalThis.fetch = realFetch;
});

const TARGET: ApiTarget = {
	url: "http://127.0.0.1:7980",
	token: "node",
	userJwt: null,
};

interface CapturedRequest {
	init?: RequestInit;
	url?: string;
}

function stubJson(payload: HttpFixtureBody, status = 200): CapturedRequest {
	const captured: CapturedRequest = {};
	globalThis.fetch = Object.assign(
		(input: RequestInfo | URL, init?: RequestInit) => {
			captured.url = String(input);
			captured.init = init;
			return Promise.resolve(Response.json(payload, { status }));
		},
		{ preconnect: realPreconnect }
	);
	return captured;
}

function statusWire(
	overrides: Record<string, HttpFixtureBody | undefined> = {}
) {
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

describe("Spaces native response contracts", () => {
	test("preserves native nullable search distances and result order", async () => {
		stubJson({
			space_id: "space-1",
			matches: [
				{
					chunk_id: "null-distance",
					document_id: "doc-1",
					content: "Unmeasured",
					distance: null,
					future: { source: "native" },
				},
				{
					chunk_id: "measured",
					document_id: "doc-2",
					content: "Measured",
					distance: 0.25,
				},
			],
		});
		expect(await searchSpace(TARGET, "space-1", "query")).toEqual([
			{
				chunkId: "null-distance",
				documentId: "doc-1",
				content: "Unmeasured",
				distance: null,
			},
			{
				chunkId: "measured",
				documentId: "doc-2",
				content: "Measured",
				distance: 0.25,
			},
		]);
	});

	test("rejects malformed search rows instead of trusting their declared type", async () => {
		stubJson({
			matches: [
				{
					chunk_id: "chunk",
					document_id: "doc",
					content: "Text",
					distance: "0.25",
				},
			],
		});
		await expect(searchSpace(TARGET, "space-1", "query")).rejects.toThrow();
	});

	test("keeps legacy document defaults while accepting future metadata", async () => {
		stubJson({
			documents: [
				{
					id: "doc",
					space_id: "space-1",
					title: "Legacy",
					created_at: 10,
					chunk_count: 2,
					future: { enabled: true },
				},
			],
		});
		expect(await fetchDocuments(TARGET, "space-1")).toEqual([
			{
				id: "doc",
				spaceId: "space-1",
				title: "Legacy",
				createdAt: 10,
				updatedAt: 10,
				chunkCount: 2,
				icon: null,
			},
		]);
	});
});

describe("Spaces retrieval-mode client", () => {
	test("maps explicit modes and defaults legacy rows to vector", async () => {
		stubJson({
			spaces: [
				{
					id: "graph-space",
					name: "Graph docs",
					created_at: 1,
					updated_at: 2,
					document_count: 3,
					retrieval_mode: "graph",
				},
				{
					id: "legacy-space",
					name: "Legacy docs",
					created_at: 1,
					updated_at: 2,
					document_count: 0,
				},
			],
		});
		expect(
			(await fetchSpaces(TARGET)).map((space) => space.retrievalMode)
		).toEqual(["graph", "vector"]);
	});

	test("serializes create with and without retrieval_mode", async () => {
		const defaultRequest = stubJson({ id: "space-default" });
		expect(await createSpace(TARGET, "Docs", null)).toBe("space-default");
		expect(JSON.parse(String(defaultRequest.init?.body))).toEqual({
			name: "Docs",
			description: null,
		});

		const graphRequest = stubJson({ id: "space-graph" });
		await createSpace(TARGET, "Graph", "Linked docs", "graph");
		expect(JSON.parse(String(graphRequest.init?.body))).toEqual({
			name: "Graph",
			description: "Linked docs",
			retrieval_mode: "graph",
		});
	});

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
			await startSpaceRetrievalModeChange(TARGET, "space/alpha", "graph")
		).toEqual({
			jobId: "job-1",
			spaceId: "space/alpha",
			retrievalMode: "graph",
			statusPath:
				"/api/spaces/space%2Falpha/retrieval-mode/status?job_id=job-1",
			cancelPath: "/api/spaces/space%2Falpha/retrieval-mode/cancel",
		});
		expect(captured.url).toBe(
			"http://127.0.0.1:7980/api/spaces/space%2Falpha/retrieval-mode"
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
			const status: RetrievalModeStatus = await fetchSpaceRetrievalModeStatus(
				TARGET,
				"space-1",
				"job-1"
			);
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
		const completed = await fetchSpaceRetrievalModeStatus(
			TARGET,
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
		const failed = await fetchSpaceRetrievalModeStatus(
			TARGET,
			"space-1",
			"job-1"
		);
		expect(failed.state).toBe("failed");
		expect(failed.error).toBe("disk full");

		stubJson(statusWire({ state: "cancelled" }));
		const cancelled = await fetchSpaceRetrievalModeStatus(
			TARGET,
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
		await fetchSpaceRetrievalModeStatus(TARGET, "space/alpha", "job?one");
		expect(statusRequest.url).toBe(
			"http://127.0.0.1:7980/api/spaces/space%2Falpha/retrieval-mode/status?job_id=job%3Fone"
		);

		const cancelRequest = stubJson({ cancelled: true });
		expect(
			await cancelSpaceRetrievalModeChange(TARGET, "space/alpha", "job?one")
		).toEqual({ cancelled: true });
		expect(cancelRequest.url).toBe(
			"http://127.0.0.1:7980/api/spaces/space%2Falpha/retrieval-mode/cancel"
		);
		expect(JSON.parse(String(cancelRequest.init?.body))).toEqual({
			job_id: "job?one",
		});
	});

	test("rejects invalid wire responses", async () => {
		stubJson({ id: 7 });
		await expect(createSpace(TARGET, "Docs", null)).rejects.toThrow(
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
			startSpaceRetrievalModeChange(TARGET, "space-1", "graph")
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
			startSpaceRetrievalModeChange(TARGET, "space-1", "graph")
		).rejects.toThrow("invalid retrieval-mode job response");

		stubJson(statusWire({ total_chunks: -1 }));
		await expect(
			fetchSpaceRetrievalModeStatus(TARGET, "space-1", "job-1")
		).rejects.toThrow("invalid retrieval-mode status response");

		stubJson(statusWire({ job_id: "wrong-job" }));
		await expect(
			fetchSpaceRetrievalModeStatus(TARGET, "space-1", "job-1")
		).rejects.toThrow("invalid retrieval-mode status response");

		stubJson(statusWire({ state: "completed", change: null }));
		await expect(
			fetchSpaceRetrievalModeStatus(TARGET, "space-1", "job-1")
		).rejects.toThrow("invalid retrieval-mode status response");

		stubJson({ cancelled: "yes" });
		await expect(
			cancelSpaceRetrievalModeChange(TARGET, "space-1", "job-1")
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
		await expect(fetchSpaces(TARGET)).rejects.toThrow("invalid space response");
	});
});

// src → packages/core-client → packages → repo root.
const REPO_ROOT = join(import.meta.dir, "../../..");

/**
 * Read a file for a mirror assertion, throwing with the resolved path when it is
 * missing. Never returns "" on failure: a silent empty string passes every
 * `not.toContain` below, which would turn this whole file into a no-op the day
 * someone moves a file or gets the `..` depth wrong.
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

const SPACES_TS = "packages/core-client/src/spaces.ts";
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

/** The doc block immediately above `export async function searchSpace(`. */
function searchSpaceDoc(source: string): string {
	const decl = source.indexOf("export async function searchSpace(");
	if (decl === -1) {
		throw new Error(
			`${SPACES_TS} no longer exports searchSpace — this guard lost its target`
		);
	}
	const open = source.lastIndexOf("/**", decl);
	const close = source.lastIndexOf("*/", decl);
	if (open === -1 || close === -1 || close < open) {
		throw new Error(
			`searchSpace in ${SPACES_TS} has no JSDoc block — the description an agent reads is gone`
		);
	}
	return source.slice(open, close);
}

describe("the searchSpace description an MCP client reads", () => {
	const doc = searchSpaceDoc(sourceFile(SPACES_TS));

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
		// The bound is lossy: `graph_search` truncates each hop's frontier, and a
		// chunk reachable only through a truncated entity drops out. A caller that
		// reads an empty result as "nothing about X" is wrong, and only this doc
		// says so.
		expect(doc.toLowerCase()).toContain("bounded");
		expect(doc.toLowerCase()).toContain("exhaustive");
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
		// `SpaceMatch.distance` is documented here as un-rankable because graph hits
		// and link-expanded chunks carry placeholders. If Core ever starts writing a
		// real score in those paths, that warning becomes the false statement.
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
