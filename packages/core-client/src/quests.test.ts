import {
	createFetchFixture,
	parseJsonRequestBody,
} from "./test-support/http-fixture.ts";
// packages/core-client/src/quests.test.ts
//
// Tests for the quests (auto-detecting todo) client. Every write endpoint follows
// the same envelope: return `json.quest` when present, else throw `json.error`
// (or a per-call default). Covered: listQuests `?? []`, create/update body +
// throw, the shared mutateQuest path used by complete/dismiss/accept/dismiss-
// suggestion (correct URL + throw on absent quest), deleteQuest DELETE, and
// judgeQuest passing the raw JudgeResult through.

import { afterEach, describe, expect, test } from "bun:test";
import type { ApiTarget } from "./client.ts";
import {
	acceptSuggestion,
	completeQuest,
	createQuest,
	deleteQuest,
	dismissQuest,
	dismissSuggestion,
	judgeQuest,
	listQuests,
	updateQuest,
} from "./quests.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

const target: ApiTarget = {
	url: "http://127.0.0.1:7980",
	token: "t",
	userJwt: null,
};

interface Captured {
	init?: RequestInit;
	url?: string;
}

function stub(bodyText: string, status = 200): Captured {
	const cap: Captured = {};
	globalThis.fetch = createFetchFixture((url: string, init: RequestInit) => {
		cap.url = url;
		cap.init = init;
		return Promise.resolve(new Response(bodyText, { status }));
	});
	return cap;
}

const quest = {
	completion_condition: "merged",
	created_at: "2026-01-01T00:00:00Z",
	id: "q1",
	status: "open" as const,
	title: "Ship",
	updated_at: "2026-01-01T00:00:00Z",
};

describe("listQuests", () => {
	test("returns the quests array", async () => {
		stub(JSON.stringify({ quests: [quest] }));
		expect(await listQuests(target)).toEqual([quest]);
	});

	test("falls back to [] when absent", async () => {
		stub("{}");
		expect(await listQuests(target)).toEqual([]);
	});
});

describe("createQuest / updateQuest", () => {
	test("createQuest POSTs the input and returns the quest", async () => {
		const cap = stub(JSON.stringify({ quest }));
		await createQuest(target, {
			title: "Ship",
			completion_condition: "merged",
		});
		expect(cap.url).toBe("http://127.0.0.1:7980/api/quests");
		expect(cap.init?.method).toBe("POST");
		expect(parseJsonRequestBody(cap.init?.body)).toEqual({
			title: "Ship",
			completion_condition: "merged",
		});
	});

	test("createQuest throws the server error on an absent quest", async () => {
		stub(JSON.stringify({ error: "duplicate" }));
		await expect(
			createQuest(target, { title: "x", completion_condition: "c" })
		).rejects.toThrow("duplicate");
	});

	test("updateQuest PUTs to the id path", async () => {
		const cap = stub(JSON.stringify({ quest }));
		await updateQuest(target, "q1", {
			title: "Ship v2",
			completion_condition: "merged",
		});
		expect(cap.url).toBe("http://127.0.0.1:7980/api/quests/q1");
		expect(cap.init?.method).toBe("PUT");
	});

	test("updateQuest throws a default when neither field present", async () => {
		stub("{}");
		await expect(
			updateQuest(target, "q1", { title: "x", completion_condition: "c" })
		).rejects.toThrow("failed to update quest");
	});
});

describe("deleteQuest", () => {
	test("issues a DELETE against the id path", async () => {
		const cap = stub(JSON.stringify({ ok: true }));
		await deleteQuest(target, "q1");
		expect(cap.init?.method).toBe("DELETE");
		expect(cap.url).toBe("http://127.0.0.1:7980/api/quests/q1");
	});
});

describe("mutateQuest-backed actions", () => {
	const cases: [
		(t: ApiTarget, id: string) => ReturnType<typeof completeQuest>,
		string,
	][] = [
		[completeQuest, "complete"],
		[dismissQuest, "dismiss"],
		[acceptSuggestion, "suggestion/accept"],
		[dismissSuggestion, "suggestion/dismiss"],
	];

	test("each POSTs to its sub-path and returns the quest", async () => {
		for (const [fn, suffix] of cases) {
			const cap = stub(JSON.stringify({ quest }));
			const out = await fn(target, "q1");
			expect(out).toEqual(quest);
			expect(cap.url).toBe(`http://127.0.0.1:7980/api/quests/q1/${suffix}`);
			expect(cap.init?.method).toBe("POST");
		}
	});

	test("each throws the shared default when the quest is absent", async () => {
		for (const [fn] of cases) {
			stub("{}");
			await expect(fn(target, "q1")).rejects.toThrow("quest update failed");
		}
	});

	test("propagates the server error message when present", async () => {
		stub(JSON.stringify({ error: "already done" }));
		await expect(completeQuest(target, "q1")).rejects.toThrow("already done");
	});
});

describe("judgeQuest", () => {
	test("POSTs to the judge path and returns the raw result", async () => {
		const cap = stub(
			JSON.stringify({ met: true, confidence: 0.9, reason: "PR merged" })
		);
		const out = await judgeQuest(target, "q1");
		expect(cap.url).toBe("http://127.0.0.1:7980/api/quests/q1/judge");
		expect(cap.init?.method).toBe("POST");
		expect(out).toEqual({ met: true, confidence: 0.9, reason: "PR merged" });
	});

	test("passes a skipped verdict through unchanged", async () => {
		stub(
			JSON.stringify({
				skipped: true,
				reason: "not open, snoozed, detection off, or no context available",
			})
		);
		expect(await judgeQuest(target, "q1")).toEqual({
			skipped: true,
			reason: "not open, snoozed, detection off, or no context available",
		});
	});
});

describe("manual judge evidence", () => {
	test("reads authenticated capture evidence and posts bounded actual context", async () => {
		const requests: Array<{ url: string; init: RequestInit }> = [];
		globalThis.fetch = createFetchFixture((url, init) => {
			requests.push({ url, init });
			if (url.endsWith("/api/quests/q1")) {
				return Promise.resolve(Response.json({ quest }));
			}
			if (url.includes("/context/recent?")) {
				return Promise.resolve(
					Response.json({ entries: [{ text: "PR was merged" }] })
				);
			}
			if (url.includes("/search/semantic?")) {
				return Promise.resolve(
					Response.json({ results: [{ text: "x".repeat(30_000) }] })
				);
			}
			return Promise.resolve(
				Response.json({ met: true, confidence: 90, reason: "merged" })
			);
		});
		await judgeQuest(target, "q1");
		expect(requests.map((read) => read.url)).toContain(
			"http://127.0.0.1:7980/api/shadow/search/semantic?q=merged&limit=5"
		);
		const post = requests.find((read) => read.init.method === "POST");
		const body = parseJsonRequestBody(post?.init.body);
		expect(body).toHaveProperty("context");
		expect(JSON.stringify(body)).toContain("PR was merged");
		expect(JSON.stringify(body).length).toBeLessThan(16_100);
		for (const read of requests) {
			expect(new Headers(read.init.headers).get("Authorization")).toBe(
				"Bearer t"
			);
		}
	});

	test("denied and empty Shadow reads never become invented evidence", async () => {
		let posted: ReturnType<typeof parseJsonRequestBody> | undefined;
		globalThis.fetch = createFetchFixture((url, init) => {
			if (url.endsWith("/api/quests/q1")) {
				return Promise.resolve(Response.json({ quest }));
			}
			if (url.includes("/context/recent?")) {
				return Promise.resolve(
					Response.json({ error: "denied" }, { status: 403 })
				);
			}
			if (url.includes("/search/semantic?")) {
				return Promise.resolve(Response.json({ results: [] }));
			}
			posted = parseJsonRequestBody(init.body);
			return Promise.resolve(
				Response.json({ skipped: true, reason: "no context available" })
			);
		});
		expect(await judgeQuest(target, "q1")).toEqual({
			skipped: true,
			reason: "no context available",
		});
		expect(posted).toEqual({});
	});
});

test("manual judge aborts a hung quest read at the evidence deadline", async () => {
	let posted = false;
	globalThis.fetch = createFetchFixture((_url, init) => {
		posted = init.method === "POST";
		return new Promise<Response>((_resolve, reject) => {
			init.signal?.addEventListener(
				"abort",
				() => reject(new DOMException("Quest read timed out", "AbortError")),
				{ once: true }
			);
		});
	});
	await expect(judgeQuest(target, "q1")).rejects.toThrow(
		"Quest read timed out"
	);
	expect(posted).toBe(false);
}, 15_000);
