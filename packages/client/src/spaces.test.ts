// packages/client/src/spaces.test.ts
//
// Tests for SpacesAPI: the SpaceWire/MatchWire mappers via mocked list/search,
// and the search request body (query always sent; limit only when provided).

import { afterEach, describe, expect, test } from "bun:test";
import { SpacesAPI } from "./spaces.ts";
import type { RyuClientOptions } from "./types.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

const OPTIONS: RyuClientOptions = { baseUrl: "http://localhost:7980" };

describe("SpacesAPI.list", () => {
	test("maps snake_case spaces including document_count", async () => {
		globalThis.fetch = (() =>
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
			)) as typeof fetch;
		const list = await new SpacesAPI(OPTIONS).list();
		expect(list[0]).toEqual({
			id: "s1",
			name: "Docs",
			description: null,
			createdAt: 100,
			updatedAt: 200,
			documentCount: 5,
		});
	});

	test("returns [] when spaces is absent", async () => {
		globalThis.fetch = (() =>
			Promise.resolve(new Response("{}"))) as typeof fetch;
		expect(await new SpacesAPI(OPTIONS).list()).toEqual([]);
	});
});

describe("SpacesAPI.search", () => {
	test("maps matches and sends only query when limit is omitted", async () => {
		let capturedBody: string | undefined;
		globalThis.fetch = ((_url: string, init: RequestInit) => {
			capturedBody = init.body as string;
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
		}) as typeof fetch;
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
		globalThis.fetch = ((_url: string, init: RequestInit) => {
			capturedBody = init.body as string;
			return Promise.resolve(Response.json({ matches: [] }));
		}) as typeof fetch;
		await new SpacesAPI(OPTIONS).search("s1", "hi", 3);
		expect(JSON.parse(capturedBody ?? "{}")).toEqual({ query: "hi", limit: 3 });
	});

	test("returns [] when matches is absent", async () => {
		globalThis.fetch = (() =>
			Promise.resolve(new Response("{}"))) as typeof fetch;
		expect(await new SpacesAPI(OPTIONS).search("s1", "q")).toEqual([]);
	});
});
