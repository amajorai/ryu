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

const target: ApiTarget = { url: "http://127.0.0.1:7980", token: "t" };

interface Captured {
	init?: RequestInit;
	url?: string;
}

function stub(bodyText: string, status = 200): Captured {
	const cap: Captured = {};
	globalThis.fetch = ((url: string, init: RequestInit) => {
		cap.url = url;
		cap.init = init;
		return Promise.resolve(new Response(bodyText, { status }));
	}) as typeof fetch;
	return cap;
}

const quest = { id: "q1", title: "Ship" };

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
		expect(JSON.parse(cap.init?.body as string)).toEqual({
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
		const cap = stub("");
		await deleteQuest(target, "q1");
		expect(cap.init?.method).toBe("DELETE");
		expect(cap.url).toBe("http://127.0.0.1:7980/api/quests/q1");
	});
});

describe("mutateQuest-backed actions", () => {
	const cases: Array<[
		(t: ApiTarget, id: string) => Promise<unknown>,
		string,
	]> = [
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
		stub(JSON.stringify({ skipped: true }));
		expect(await judgeQuest(target, "q1")).toEqual({ skipped: true });
	});
});
