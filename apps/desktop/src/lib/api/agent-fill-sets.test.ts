import { afterEach, describe, expect, it } from "bun:test";
import {
	attachAgentFillSet,
	type BoxFillChoice,
	fetchAgentFillSets,
	fillSetItemRef,
	loginUrlPrefill,
	parseFillSetText,
	revokeAgentFillSet,
	withBoxFillChoices,
} from "./agent-fill-sets.ts";
import type { ApiTarget } from "./client.ts";

const target: ApiTarget = {
	url: "https://fill-sets-client.fixture",
	token: "fill-sets-token",
	userJwt: null,
};
const originalFetch = globalThis.fetch;
const SET = {
	agent_id: "agent-1",
	claimed: false,
	created_at: 1,
	expires_at: 3_600_001,
	id: "fs_1",
	items: [
		{
			environment: "default",
			fields: ["username", "password"],
			handle: "attached:1",
			host: "github.com",
			key: "github",
			kind: "login",
			path: "/logins",
			site: "https://github.com",
		},
	],
};

afterEach(() => {
	globalThis.fetch = originalFetch;
});

function answer(
	reply: unknown,
	seen: { url: string; method: string; body?: string }[]
) {
	globalThis.fetch = Object.assign(
		(input: RequestInfo | URL, init?: RequestInit) => {
			seen.push({
				url: String(input),
				method: init?.method ?? "GET",
				body: init?.body === undefined ? undefined : String(init.body),
			});
			return Promise.resolve(Response.json(reply));
		},
		{ preconnect: originalFetch.preconnect }
	);
}

describe("fill set text", () => {
	it("reads folder/key and an optional site per line", () => {
		expect(
			parseFillSetText(
				"logins/github https://github.com\n\n  root-key \n/a/b/c",
				" staging "
			)
		).toEqual({
			invalidLines: [],
			items: [
				{
					environment: "staging",
					key: "github",
					path: "/logins",
					site: "https://github.com",
				},
				{ environment: "staging", key: "root-key" },
				{ environment: "staging", key: "c", path: "/a/b" },
			],
		});
	});

	it("reports lines with a bad key or extra words", () => {
		expect(
			parseFillSetText("ok\nbad key here\nfolder/\nsp ace!", "").invalidLines
		).toEqual([2, 3]);
		expect(parseFillSetText("a/b!", "").invalidLines).toEqual([1]);
	});
});

describe("Box fill login URLs", () => {
	it("prefills the login URL from an item URL that names a page", () => {
		expect(loginUrlPrefill("https://github.com/session")).toBe(
			"https://github.com/session"
		);
		expect(loginUrlPrefill("https://Auth.Example.com/sign-in/")).toBe(
			"https://auth.example.com/sign-in/"
		);
		for (const none of [
			undefined,
			"",
			"https://github.com",
			"https://github.com/",
			"http://github.com/session",
			"https://github.com/session?next=/",
			"https://github.com/session#top",
			"https://github.com:8443/session",
			"https://user:pw@github.com/session",
			"not a url",
		]) {
			expect(loginUrlPrefill(none)).toBe("");
		}
	});

	it("sends each item's login URL and Box opt-in", () => {
		const parsed = parseFillSetText(
			"logins/github https://github.com/session\nlogins/bank https://bank.example\nnotes",
			""
		).items;
		const choices = new Map<string, BoxFillChoice>();
		const bank = parsed[1];
		const notes = parsed[2];
		if (!(bank && notes)) {
			throw new Error("parse failed");
		}
		choices.set(fillSetItemRef(bank), { loginUrl: "", unbound: true });
		choices.set(fillSetItemRef(notes), {
			loginUrl: " https://notes.example/login ",
			unbound: false,
		});
		expect(withBoxFillChoices(parsed, choices)).toEqual([
			{
				box_unbound: false,
				key: "github",
				path: "/logins",
				site: "https://github.com/session",
				submit_urls: ["https://github.com/session"],
			},
			{
				box_unbound: true,
				key: "bank",
				path: "/logins",
				site: "https://bank.example",
				submit_urls: [],
			},
			{
				box_unbound: false,
				key: "notes",
				submit_urls: ["https://notes.example/login"],
			},
		]);
	});

	it("reads Box fill fields on attached items and defaults them on older Cores", async () => {
		const seen: { url: string; method: string }[] = [];
		const bound = {
			...SET.items[0],
			box_unbound: false,
			login_url_bound: true,
			submit_urls: ["https://github.com/session"],
		};
		answer({ fillSets: [{ ...SET, items: [bound, SET.items[0]] }] }, seen);
		const [set] = await fetchAgentFillSets(target, "agent-1");
		expect(set?.items[0]?.submit_urls).toEqual(["https://github.com/session"]);
		expect(set?.items[0]?.login_url_bound).toBe(true);
		expect(set?.items[1]?.submit_urls).toEqual([]);
		expect(set?.items[1]?.box_unbound).toBe(false);
	});
});

describe("fill set client", () => {
	it("lists an agent's sets", async () => {
		const seen: { url: string; method: string }[] = [];
		answer({ fillSets: [SET] }, seen);
		const sets = await fetchAgentFillSets(target, "agent 1");
		expect(sets[0]?.items[0]?.handle).toBe("attached:1");
		expect(seen[0]?.url).toBe(
			"https://fill-sets-client.fixture/api/vault/fill-sets?agent_id=agent%201"
		);
	});

	it("attaches items with a time to live", async () => {
		const seen: { url: string; method: string; body?: string }[] = [];
		answer({ fillSet: SET }, seen);
		const set = await attachAgentFillSet(
			target,
			"agent-1",
			[{ key: "github", path: "/logins" }],
			3600
		);
		expect(set.id).toBe("fs_1");
		expect(seen[0]?.method).toBe("POST");
		expect(JSON.parse(seen[0]?.body ?? "{}")).toEqual({
			agent_id: "agent-1",
			items: [{ key: "github", path: "/logins" }],
			ttl_secs: 3600,
		});
	});

	it("revokes a set by id", async () => {
		const seen: { url: string; method: string }[] = [];
		answer({ revoked: true, audited: true }, seen);
		expect(await revokeAgentFillSet(target, "fs/1")).toBe(true);
		expect(seen[0]).toMatchObject({
			method: "DELETE",
			url: "https://fill-sets-client.fixture/api/vault/fill-sets/fs%2F1",
		});
	});
});
