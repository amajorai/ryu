import { describe, expect, it } from "bun:test";
import type { RnpContinuityBundleV0 } from "@ryuhq/protocol/continuity";
import { createContinuityClient } from "./continuity.ts";

const bundle: RnpContinuityBundleV0 = {
	protocol: "ryu-node-continuity",
	version: 0,
	bundleId: "bundle-1",
	createdAt: 20,
	source: { conversationId: "conversation-1", updatedAt: 10 },
	selection: {
		transcript: { mode: "recent", maxMessages: 50 },
		omittedEarlierMessages: false,
	},
	messages: [],
	context: { version: 0, items: [] },
};

describe("RNP continuity client", () => {
	it("keeps source and destination credentials on their own requests", async () => {
		const calls: Array<{
			target: { url: string; token: string | null; userJwt?: string | null };
			path: string;
		}> = [];
		const client = createContinuityClient({
			send: ({ target, path }) => {
				calls.push({ target, path });
				return Promise.resolve(
					path.endsWith("/export")
						? bundle
						: {
								version: 0,
								conversationId: "conversation-1",
								status: "created",
								imported: { messages: 0, contextItems: 0 },
								warnings: [],
							}
				);
			},
		});

		await client.transferConversation({
			conversationId: "conversation-1",
			source: {
				url: "https://source.example",
				token: "source-secret",
				userJwt: null,
			},
			destination: {
				url: "https://destination.example",
				token: "destination-secret",
				userJwt: null,
			},
		});

		expect(calls).toEqual([
			{
				target: {
					url: "https://source.example",
					token: "source-secret",
					userJwt: null,
				},
				path: "/api/rnp/v0/conversations/conversation-1/export",
			},
			{
				target: {
					url: "https://destination.example",
					token: "destination-secret",
					userJwt: null,
				},
				path: "/api/rnp/v0/conversations/conversation-1/resume",
			},
		]);
	});

	it("does not contact the destination when source validation fails", async () => {
		let calls = 0;
		const client = createContinuityClient({
			send: () => {
				calls += 1;
				return Promise.resolve({ protocol: "wrong", version: 0 });
			},
		});

		await expect(
			client.transferConversation({
				conversationId: "conversation-1",
				source: { url: "https://source.example", token: null, userJwt: null },
				destination: {
					url: "https://destination.example",
					token: null,
					userJwt: null,
				},
			})
		).rejects.toThrow("invalid continuity bundle");
		expect(calls).toBe(1);
	});

	it("rejects mismatched ids and invalid imported counts at the boundary", async () => {
		const mismatchedSource = createContinuityClient({
			send: () =>
				Promise.resolve({
					...bundle,
					source: { ...bundle.source, conversationId: "different" },
				}),
		});
		await expect(
			mismatchedSource.exportConversation(
				{ url: "https://source.example", token: null, userJwt: null },
				"conversation-1",
				{ version: 0, transcript: { mode: "recent", maxMessages: 50 } }
			)
		).rejects.toThrow("different conversation");

		const invalidResume = createContinuityClient({
			send: () =>
				Promise.resolve({
					version: 0,
					conversationId: "conversation-1",
					status: "merged",
					imported: { messages: -1, contextItems: 0 },
					warnings: [],
				}),
		});
		await expect(
			invalidResume.resumeConversation(
				{ url: "https://destination.example", token: null, userJwt: null },
				bundle
			)
		).rejects.toThrow("invalid continuity response");
	});
});

it("validates every destination field while retaining its stable public failure", async () => {
	const valid = {
		version: 0,
		conversationId: "conversation-1",
		status: "merged",
		imported: { messages: Number.MAX_SAFE_INTEGER, contextItems: 0 },
		warnings: ["agent-unavailable", "earlier-messages-omitted"],
		future: { ignored: true },
	};
	const client = createContinuityClient({ send: () => Promise.resolve(valid) });
	expect(
		await client.resumeConversation(
			{ url: "https://destination.example", token: null },
			bundle
		)
	).toEqual({
		version: 0,
		conversationId: "conversation-1",
		status: "merged",
		imported: { messages: Number.MAX_SAFE_INTEGER, contextItems: 0 },
		warnings: ["agent-unavailable", "earlier-messages-omitted"],
	});
	for (const invalid of [
		{ ...valid, version: 1 },
		{ ...valid, status: "future-status" },
		{ ...valid, conversationId: null },
		{ ...valid, imported: { messages: 1.5, contextItems: 0 } },
		{
			...valid,
			imported: { messages: Number.MAX_SAFE_INTEGER + 1, contextItems: 0 },
		},
		{ ...valid, imported: { messages: 0, contextItems: -1 } },
		{ ...valid, warnings: ["future-warning"] },
	]) {
		const badClient = createContinuityClient({
			send: () => Promise.resolve(invalid),
		});
		await expect(
			badClient.resumeConversation(
				{ url: "https://destination.example", token: null },
				bundle
			)
		).rejects.toThrow(
			"The destination returned an invalid continuity response."
		);
	}
});
