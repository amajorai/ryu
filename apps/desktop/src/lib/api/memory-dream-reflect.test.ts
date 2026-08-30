import { afterEach, describe, expect, it } from "bun:test";
import {
	acceptMemoryProposal,
	getDreamReview,
	getMemoryGraph,
	getMemorySettings,
	getReflectDashboard,
	rejectMemoryProposal,
	runDreamReview,
	setMemorySettings,
} from "./memory.ts";

const target = { token: null, url: "http://node.test" };
const nativeFetch = globalThis.fetch;

function jsonResponse(body: unknown): Response {
	return new Response(JSON.stringify(body), {
		headers: { "content-type": "application/json" },
		status: 200,
	});
}

describe("Dream and Reflect memory clients", () => {
	afterEach(() => {
		globalThis.fetch = nativeFetch;
	});

	it("maps Dream proposals into the UI diff shape", async () => {
		globalThis.fetch = Object.assign(
			async () =>
				jsonResponse({
					proposals: [
						{
							created_at: 1,
							current: null,
							id: "proposal-1",
							proposed: {
								content: "Prefers short answers",
								id: "memory-1",
								tags: [],
							},
							reason: "Repeated preference",
							source: "chat",
						},
					],
				}),
			{ preconnect: nativeFetch.preconnect }
		);

		const review = await getDreamReview(target);
		expect(review.proposals[0]).toMatchObject({
			current: null,
			id: "proposal-1",
			proposed: {
				content: "Prefers short answers",
				category: "other",
				importance: 1,
			},
			status: "pending",
		});
	});

	it("uses the expected Dream mutation routes and request bodies", async () => {
		const calls: Array<{ body: string; method: string; url: string }> = [];
		globalThis.fetch = Object.assign(
			async (
				input: Parameters<typeof fetch>[0],
				init?: Parameters<typeof fetch>[1]
			) => {
				calls.push({
					body: String(init?.body ?? ""),
					method: init?.method ?? "GET",
					url: String(input),
				});
				return jsonResponse({ memory: { content: "saved", id: "memory-1" } });
			},
			{ preconnect: nativeFetch.preconnect }
		);

		await runDreamReview(target, "manual");
		await acceptMemoryProposal(target, "proposal/1");
		await rejectMemoryProposal(target, "proposal/2");

		expect(calls.map((call) => call.url)).toEqual([
			"http://node.test/api/memory/dream/review",
			"http://node.test/api/memory/dream/review/proposals/proposal%2F1/accept",
			"http://node.test/api/memory/dream/review/proposals/proposal%2F2/reject",
		]);
		expect(JSON.parse(calls[0].body)).toEqual({ mode: "manual" });
	});

	it("maps Reflect activity, topics, and insights", async () => {
		globalThis.fetch = Object.assign(
			async () =>
				jsonResponse({
					activity: [{ count: 12, label: "Conversations", trend: 25 }],
					insights: [
						{
							body: "You made progress",
							id: "i1",
							title: "A good week",
							tone: "positive",
						},
					],
					period: "30d",
					topics: [{ count: 4, name: "Writing", summary: "Drafts and edits" }],
				}),
			{ preconnect: nativeFetch.preconnect }
		);

		const dashboard = await getReflectDashboard(target, "7d");
		expect(dashboard.period).toBe("30d");
		expect(dashboard.activity[0]).toEqual({
			count: 12,
			label: "Conversations",
			trend: 25,
		});
		expect(dashboard.insights[0].tone).toBe("positive");
		expect(dashboard.topics[0].name).toBe("Writing");
	});

	it("uses the dedicated sensitive-memory settings and graph routes", async () => {
		const calls: Array<{ body: string; method: string; url: string }> = [];
		globalThis.fetch = Object.assign(
			async (
				input: Parameters<typeof fetch>[0],
				init?: Parameters<typeof fetch>[1]
			) => {
				calls.push({
					body: String(init?.body ?? ""),
					method: init?.method ?? "GET",
					url: String(input),
				});
				if (
					String(input).endsWith("/api/memory/settings") &&
					init?.method === "PUT"
				) {
					return jsonResponse({ include_sensitive_topics: false });
				}
				if (String(input).endsWith("/api/memory/settings")) {
					return jsonResponse({ include_sensitive_topics: true });
				}
				return jsonResponse({
					edges: [],
					memory_count: 2,
					nodes: [],
					truncated: false,
				});
			},
			{ preconnect: nativeFetch.preconnect }
		);

		await expect(getMemorySettings(target)).resolves.toEqual({
			includeSensitiveTopics: true,
		});
		await expect(
			setMemorySettings(target, { includeSensitiveTopics: false })
		).resolves.toEqual({ includeSensitiveTopics: false });
		await expect(getMemoryGraph(target)).resolves.toMatchObject({
			memoryCount: 2,
			truncated: false,
		});

		expect(calls.map((call) => call.url)).toEqual([
			"http://node.test/api/memory/settings",
			"http://node.test/api/memory/settings",
			"http://node.test/api/memory/graph",
		]);
		expect(JSON.parse(calls[1].body)).toEqual({
			include_sensitive_topics: false,
		});
	});

	it("falls back to the privacy-gated usage review route on older nodes", async () => {
		globalThis.fetch = Object.assign(
			async (input: Parameters<typeof fetch>[0]) => {
				const url = String(input);
				if (url.includes("/api/memory/reflect?")) {
					return new Response(JSON.stringify({ error: "not_found" }), {
						status: 404,
					});
				}
				return jsonResponse({
					metrics: { active_days: 3, conversation_count: 2, message_count: 8 },
					period: { to: 100 },
					topics: [
						{ conversation_count: 2, label: "Planning", message_count: 8 },
					],
				});
			},
			{ preconnect: nativeFetch.preconnect }
		);

		const dashboard = await getReflectDashboard(target, "7d");
		expect(dashboard.activity.map((item) => item.label)).toEqual([
			"Conversations",
			"Messages",
			"Active days",
		]);
		expect(dashboard.topics[0].name).toBe("Planning");
	});
});
