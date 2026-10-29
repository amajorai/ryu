import { afterEach, describe, expect, test } from "bun:test";
import type { ApiTarget } from "./client.ts";
import { indexChunk, searchRetrievalDetailed } from "./retrieval.ts";
import {
	fetchSpaceChunking,
	searchSpaceWith,
	setSpaceChunking,
} from "./space-retrieval.ts";
import type { HttpFixtureBody } from "./test-support/http-fixture.ts";

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

interface Captured {
	body?: unknown;
	method?: string;
	url?: string;
}

function stubJson(payload: HttpFixtureBody, status = 200): Captured {
	const captured: Captured = {};
	globalThis.fetch = Object.assign(
		(input: RequestInfo | URL, init?: RequestInit) => {
			captured.url = String(input);
			captured.method = init?.method;
			captured.body =
				typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
			return Promise.resolve(Response.json(payload, { status }));
		},
		{ preconnect: realPreconnect }
	);
	return captured;
}

describe("advanced Space search", () => {
	test("sends hybrid, filter, parent, and expansion knobs in Core's wire shape", async () => {
		const captured = stubJson({
			space_id: "s1",
			matches: [
				{
					chunk_id: "c1",
					document_id: "d1",
					content: "Install steps",
					distance: 0,
					score: 0.0164,
					metadata: { ordinal: 1, header_path: ["Guide", "Install"] },
					parent_content: "Overview\n\nInstall steps",
				},
				{ chunk_id: "c2", document_id: "d2", content: "Other", distance: 0.4 },
			],
			queries: ["install", "setup guide"],
			warning: "HyDE expansion failed: gateway unreachable",
		});
		const result = await searchSpaceWith(TARGET, "s1", {
			query: "install",
			limit: 3,
			hybrid: true,
			filter: { header_path: "Install" },
			parent: { mode: "window", window: 1 },
			rerank: false,
			multiQuery: 1,
			hyde: true,
		});
		expect(captured.url).toBe("http://127.0.0.1:7980/api/spaces/s1/search");
		expect(captured.body).toEqual({
			query: "install",
			limit: 3,
			hybrid: {},
			filter: { header_path: "Install" },
			parent: { mode: "window", window: 1 },
			rerank: false,
			multi_query: 1,
			hyde: true,
		});
		expect(result.matches).toEqual([
			{
				chunkId: "c1",
				documentId: "d1",
				content: "Install steps",
				distance: 0,
				score: 0.0164,
				metadata: { ordinal: 1, header_path: ["Guide", "Install"] },
				parentContent: "Overview\n\nInstall steps",
			},
			{
				chunkId: "c2",
				documentId: "d2",
				content: "Other",
				distance: 0.4,
				score: null,
				metadata: null,
				parentContent: null,
			},
		]);
		expect(result.queries).toEqual(["install", "setup guide"]);
		expect(result.hypotheticalDocument).toBeNull();
		expect(result.warning).toContain("HyDE");
	});

	test("rejects malformed hits", async () => {
		stubJson({
			matches: [{ chunk_id: "c", document_id: "d", content: 1, distance: 0 }],
		});
		await expect(
			searchSpaceWith(TARGET, "s1", { query: "q" })
		).rejects.toThrow();
	});
});

describe("Space chunking", () => {
	test("reads and writes the strategy", async () => {
		const read = stubJson({
			space_id: "s1",
			chunking: { strategy: "default" },
		});
		expect(await fetchSpaceChunking(TARGET, "s1")).toEqual({
			strategy: "default",
		});
		expect(read.url).toBe("http://127.0.0.1:7980/api/spaces/s1/chunking");

		const strategy = {
			strategy: "markdown",
			chunk_size: 800,
			chunk_overlap: 100,
			include_header_path: true,
		} as const;
		const write = stubJson({ space_id: "s1", chunking: strategy });
		expect(await setSpaceChunking(TARGET, "s1", strategy)).toEqual(strategy);
		expect(write.method).toBe("PUT");
		expect(write.body).toEqual({ chunking: strategy });

		const reset = stubJson({
			space_id: "s1",
			chunking: { strategy: "default" },
		});
		await setSpaceChunking(TARGET, "s1", null);
		expect(reset.body).toEqual({ chunking: null });
	});
});

describe("retrieval search and index", () => {
	test("forwards filter, hybrid, and expansion and reports expansion output", async () => {
		const captured = stubJson({
			chunks: [
				{ id: "a", source: "space", space_id: "kb", content: "x", score: 0.5 },
			],
			queries: ["q", "q2"],
			hypothetical_document: "A passage.",
		});
		const result = await searchRetrievalDetailed(TARGET, {
			query: "q",
			filter: { lang: { $in: ["en"] } },
			hybrid: { alpha: 0.7 },
			multiQuery: 1,
			hyde: true,
			expansionModel: "small-model",
		});
		expect(captured.body).toMatchObject({
			query: "q",
			filter: { lang: { $in: ["en"] } },
			hybrid: { alpha: 0.7 },
			multi_query: 1,
			hyde: true,
			expansion_model: "small-model",
		});
		expect(result).toEqual({
			chunks: [
				{ id: "a", source: "space", spaceId: "kb", content: "x", score: 0.5 },
			],
			queries: ["q", "q2"],
			hypotheticalDocument: "A passage.",
			warning: null,
		});
	});

	test("index sends chunk metadata", async () => {
		const captured = stubJson({ success: true, id: "a" });
		await indexChunk(TARGET, {
			id: "a",
			content: "text",
			source: "space",
			spaceId: "kb",
			metadata: { lang: "en" },
		});
		expect(captured.body).toEqual({
			id: "a",
			content: "text",
			source: "space",
			space_id: "kb",
			metadata: { lang: "en" },
		});
	});
});
