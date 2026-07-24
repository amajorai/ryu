// packages/core-client/src/skills.test.ts
//
// Tests for the skills-catalog client. Coverage centers on the wire→camel mapping
// (`toCard` fallback chains, `fetchSkillDetail`'s snake→camel metadata remap), the
// request builders (query-param assembly in searchSkills, URL-encoding in detail),
// the buyer-token forwarding on install, and the error-envelope semantics:
// installSkill throws on `success === false` OR a missing `result`, while
// addMarketplaceSource throws ONLY on an explicit `ok === false` (an omitted flag
// proceeds). The client.setBuyerTokenProvider global is reset per test.

import { afterEach, describe, expect, test } from "bun:test";
import type { ApiTarget } from "./client.ts";
import { setBuyerTokenProvider } from "./client.ts";
import {
	addMarketplaceSource,
	fetchSkillDetail,
	fetchSkillSources,
	installSkill,
	listSkills,
	searchSkills,
	selectSkillSource,
	setSkillActive,
} from "./skills.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
	setBuyerTokenProvider(() => null);
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

describe("searchSkills — request builder + card mapping", () => {
	test("assembles query/limit/installed_only params", async () => {
		const cap = stub(JSON.stringify({ skills: [] }));
		await searchSkills(target, {
			query: "ci",
			limit: 5,
			installedOnly: true,
		});
		const u = new URL(cap.url ?? "");
		expect(u.pathname).toBe("/api/skills/catalog");
		expect(u.searchParams.get("query")).toBe("ci");
		expect(u.searchParams.get("limit")).toBe("5");
		expect(u.searchParams.get("installed_only")).toBe("true");
	});

	test("omits every param when none is passed", async () => {
		const cap = stub(JSON.stringify({ skills: [] }));
		await searchSkills(target);
		expect(cap.url).toBe("http://127.0.0.1:7980/api/skills/catalog?");
	});

	test("toCard fills defaults (name←slug←id, downloads←installs)", async () => {
		stub(JSON.stringify({ skills: [{ id: "x", installs: 4 }] }));
		const [card] = await searchSkills(target);
		expect(card).toEqual({
			id: "x",
			source: "",
			slug: "",
			name: "x",
			installs: 4,
			downloads: 4,
			installed: false,
		});
	});

	test("name prefers slug over id when name is absent", async () => {
		stub(JSON.stringify({ skills: [{ id: "x", slug: "my-slug" }] }));
		const [card] = await searchSkills(target);
		expect(card.name).toBe("my-slug");
		expect(card.downloads).toBe(0);
	});

	test("falls back to [] when skills is absent", async () => {
		stub("{}");
		expect(await searchSkills(target)).toEqual([]);
	});
});

describe("fetchSkillDetail — encoding + metadata remap", () => {
	test("URL-encodes the id and remaps snake_case metadata to camelCase", async () => {
		const cap = stub(
			JSON.stringify({
				card: { id: "org/skill" },
				description: "d",
				readme: "r",
				files: [{ path: "SKILL.md", contents: "x" }],
				metadata: {
					first_seen: "2026-01-01",
					github_stars: "42",
					repository_url: "https://github.com/o/s",
					security_audits: [{ name: "a", status: "pass", url: null }],
				},
				url: "https://skills.sh/org/skill",
			})
		);
		const detail = await fetchSkillDetail(target, "org/skill");
		expect(cap.url).toBe(
			"http://127.0.0.1:7980/api/skills/catalog/detail?id=org%2Fskill"
		);
		expect(detail.card.id).toBe("org/skill");
		expect(detail.metadata.firstSeen).toBe("2026-01-01");
		expect(detail.metadata.githubStars).toBe("42");
		expect(detail.metadata.repositoryUrl).toBe("https://github.com/o/s");
		expect(detail.metadata.securityAudits).toHaveLength(1);
	});

	test("degrades every optional field to null/[] when metadata is absent", async () => {
		stub(JSON.stringify({ card: { id: "x" } }));
		const detail = await fetchSkillDetail(target, "x");
		expect(detail.description).toBeNull();
		expect(detail.readme).toBeNull();
		expect(detail.files).toEqual([]);
		expect(detail.url).toBe("");
		expect(detail.metadata.firstSeen).toBeNull();
		expect(detail.metadata.securityAudits).toEqual([]);
	});
});

describe("installSkill — buyer token + error envelope", () => {
	test("returns the result and forwards the buyer token header", async () => {
		setBuyerTokenProvider(() => "sess-42");
		const cap = stub(
			JSON.stringify({ success: true, result: { slug: "s", path: "/p" } })
		);
		const out = await installSkill(target, "id1");
		expect(out).toEqual({ slug: "s", path: "/p" });
		const h = cap.init?.headers as Record<string, string>;
		expect(h["X-Ryu-Buyer-Token"]).toBe("sess-42");
		expect(JSON.parse(cap.init?.body as string)).toEqual({ id: "id1" });
	});

	test("omits the buyer header when not signed in", async () => {
		const cap = stub(
			JSON.stringify({ success: true, result: { slug: "s", path: "/p" } })
		);
		await installSkill(target, "id1");
		const h = cap.init?.headers as Record<string, string>;
		expect(h["X-Ryu-Buyer-Token"]).toBeUndefined();
	});

	test("throws the server error when success === false", async () => {
		stub(JSON.stringify({ success: false, error: "not entitled" }));
		await expect(installSkill(target, "id1")).rejects.toThrow("not entitled");
	});

	test("throws when result is missing even if success is not false", async () => {
		stub(JSON.stringify({ success: true }));
		await expect(installSkill(target, "paid")).rejects.toThrow(
			"Failed to install paid"
		);
	});
});

describe("listSkills — installed mapping", () => {
	test("maps wire rows, defaulting name/enabled/allowed_tools", async () => {
		stub(
			JSON.stringify({
				skills: [
					{ id: "a", enabled: true, allowed_tools: ["Read"] },
					{ id: "b" },
				],
			})
		);
		const skills = await listSkills(target);
		expect(skills).toEqual([
			{
				id: "a",
				name: "a",
				description: null,
				enabled: true,
				allowedTools: ["Read"],
			},
			{
				id: "b",
				name: "b",
				description: null,
				enabled: false,
				allowedTools: [],
			},
		]);
	});

	test("falls back to [] when skills is absent", async () => {
		stub("{}");
		expect(await listSkills(target)).toEqual([]);
	});
});

describe("setSkillActive", () => {
	test("POSTs id + active to the activate endpoint", async () => {
		const cap = stub("{}");
		await setSkillActive(target, "a", false);
		expect(cap.url).toBe("http://127.0.0.1:7980/api/skills/activate");
		expect(cap.init?.method).toBe("POST");
		expect(JSON.parse(cap.init?.body as string)).toEqual({
			id: "a",
			active: false,
		});
	});
});

describe("catalog sources", () => {
	test("fetchSkillSources maps display_name/builtin/base_url", async () => {
		const cap = stub(
			JSON.stringify({
				active: "skills.sh",
				sources: [
					{ id: "skills.sh", display_name: "Skills.sh", builtin: true },
					{ id: "c", display_name: "Custom", base_url: "https://x" },
				],
			})
		);
		const out = await fetchSkillSources(target);
		expect(cap.url).toBe(
			"http://127.0.0.1:7980/api/catalog/sources?kind=skill"
		);
		expect(out.active).toBe("skills.sh");
		expect(out.sources).toEqual([
			{
				id: "skills.sh",
				displayName: "Skills.sh",
				builtin: true,
				baseUrl: null,
			},
			{
				id: "c",
				displayName: "Custom",
				builtin: false,
				baseUrl: "https://x",
			},
		]);
	});

	test("fetchSkillSources degrades to empty active + [] sources", async () => {
		stub("{}");
		expect(await fetchSkillSources(target)).toEqual({
			active: "",
			sources: [],
		});
	});

	test("selectSkillSource POSTs kind:skill + id", async () => {
		const cap = stub("{}");
		await selectSkillSource(target, "c");
		expect(cap.url).toBe("http://127.0.0.1:7980/api/catalog/sources/select");
		expect(JSON.parse(cap.init?.body as string)).toEqual({
			kind: "skill",
			id: "c",
		});
	});
});

describe("addMarketplaceSource — error envelope", () => {
	test("maps params to the snake_case body", async () => {
		const cap = stub(JSON.stringify({ ok: true }));
		await addMarketplaceSource(target, {
			id: "m",
			displayName: "Mine",
			baseUrl: "https://repo",
		});
		expect(JSON.parse(cap.init?.body as string)).toEqual({
			kind: "skill",
			id: "m",
			display_name: "Mine",
			base_url: "https://repo",
		});
	});

	test("succeeds when the ok flag is omitted (only explicit false throws)", async () => {
		stub("{}");
		await expect(
			addMarketplaceSource(target, {
				id: "m",
				displayName: "Mine",
				baseUrl: "https://repo",
			})
		).resolves.toBeUndefined();
	});

	test("throws the server error on ok === false", async () => {
		stub(JSON.stringify({ ok: false, error: "bad marketplace.json" }));
		await expect(
			addMarketplaceSource(target, {
				id: "m",
				displayName: "Mine",
				baseUrl: "https://repo",
			})
		).rejects.toThrow("bad marketplace.json");
	});
});
