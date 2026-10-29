import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";
// apps/desktop/src/lib/api/skills-packs.test.ts
//
// Wire tests for the skill-pack client functions: they must POST/GET the exact
// Core endpoints with the exact bodies Core's server routes read, and parse the
// exact response shapes those routes return. A mock `fetch` stands in for the
// network (the `request` helper in client.ts calls the global fetch).

import { afterEach, describe, expect, it, mock } from "bun:test";
import type { ApiTarget } from "./client.ts";
import {
	addSkillPack,
	fetchSkillPackDetail,
	fetchSkillPacks,
	installSkillPack,
	removeSkillPack,
} from "./skills.ts";

const TARGET: ApiTarget = {
	url: "http://127.0.0.1:7980",
	token: null,
	userJwt: null,
};

function jsonResponse<TFixture>(body: TFixture, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

interface CapturedCall {
	body?: unknown;
	method: string;
	url: string;
}

/** Install a mock fetch that records every call and returns `body`. */
function mockFetch<TFixture>(body: TFixture): CapturedCall[] {
	const calls: CapturedCall[] = [];
	globalThis.fetch = Object.assign(
		mock(async (input: RequestInfo | URL, init?: RequestInit) => {
			let parsed: unknown;
			if (init?.body && isNativeText(init.body)) {
				parsed = JSON.parse(init.body);
			}
			calls.push({
				method: init?.method ?? "GET",
				url: String(input),
				body: parsed,
			});
			return jsonResponse(body);
		}),
		{ preconnect: globalThis.fetch.preconnect }
	);
	return calls;
}

describe("skill pack API client", () => {
	afterEach(() => {
		mock.restore();
	});

	it("fetchSkillPacks GETs /api/skills/packs", async () => {
		const calls = mockFetch({ packs: [] });
		const packs = await fetchSkillPacks(TARGET);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.method).toBe("GET");
		expect(calls[0]?.url).toContain("/api/skills/packs");
		expect(packs).toEqual([]);
	});

	it("fetchSkillPacks maps member_count to memberCount", async () => {
		mockFetch({
			packs: [
				{
					id: "mattpocock/skills",
					name: "Mattpocock Skills",
					description: "A pack",
					builtin: true,
					member_count: 3,
				},
			],
		});
		const packs = await fetchSkillPacks(TARGET);
		expect(packs[0]).toMatchObject({
			id: "mattpocock/skills",
			memberCount: 3,
			builtin: true,
		});
	});

	it("installSkillPack POSTs the id and returns installed slugs", async () => {
		const calls = mockFetch({ success: true, installed: ["caveman", "tdd"] });
		const installed = await installSkillPack(TARGET, "mattpocock/skills");
		expect(installed).toEqual(["caveman", "tdd"]);
		expect(calls[0]?.method).toBe("POST");
		expect(calls[0]?.body).toEqual({ id: "mattpocock/skills" });
	});

	it("installSkillPack throws on a failed response", async () => {
		mockFetch({ success: false, error: "unknown pack" });
		expect(installSkillPack(TARGET, "nope")).rejects.toThrow("unknown pack");
	});

	it("fetchSkillPackDetail GETs the detail route with the id", async () => {
		const calls = mockFetch({
			id: "mattpocock/skills",
			name: "Mattpocock Skills",
			description: "A pack",
			builtin: true,
			members: [
				{ id: "mattpocock/skills/caveman", installed: true, name: "Caveman" },
			],
		});
		const detail = await fetchSkillPackDetail(TARGET, "mattpocock/skills");
		expect(calls[0]?.url).toContain(
			"/api/skills/packs/detail?id=mattpocock%2Fskills"
		);
		expect(detail.members).toHaveLength(1);
		expect(detail.memberCount).toBe(1);
	});

	it("addSkillPack POSTs the pack spec", async () => {
		const calls = mockFetch({ success: true });
		await addSkillPack(TARGET, {
			id: "my-pack",
			name: "My Pack",
			description: "A custom pack",
			source: "https://github.com/owner/repo",
		});
		expect(calls[0]?.method).toBe("POST");
		expect(calls[0]?.body).toEqual({
			id: "my-pack",
			name: "My Pack",
			description: "A custom pack",
			source: "https://github.com/owner/repo",
		});
	});

	it("removeSkillPack POSTs the id", async () => {
		const calls = mockFetch({ success: true });
		await removeSkillPack(TARGET, "my-pack");
		expect(calls[0]?.method).toBe("POST");
		expect(calls[0]?.url).toContain("/api/skills/packs/remove");
		expect(calls[0]?.body).toEqual({ id: "my-pack" });
	});
});
