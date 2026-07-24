import { describe, expect, it } from "bun:test";
import {
	BANGS,
	DEFAULT_ENGINE,
	looksLikeQuestion,
	looksLikeUrl,
	normalizeUrl,
	route,
	SEARCH_ENGINES,
} from "./smart-bar-engine.ts";

describe("normalizeUrl", () => {
	it("adds https:// when no scheme is present", () => {
		expect(normalizeUrl("example.com")).toBe("https://example.com");
	});

	it("leaves an explicit scheme untouched", () => {
		expect(normalizeUrl("http://example.com")).toBe("http://example.com");
		expect(normalizeUrl("https://example.com")).toBe("https://example.com");
		expect(normalizeUrl("ftp://host/x")).toBe("ftp://host/x");
	});
});

describe("looksLikeUrl - true cases", () => {
	it.each([
		["bare domain with common TLD", "example.com"],
		["dev gTLD", "foo.dev"],
		["subdomain", "sub.example.co.uk"],
		["explicit https scheme", "https://anything.zzz"],
		["file scheme", "file:///etc/hosts"],
		["ftp scheme", "ftp://host/file"],
		["localhost with port", "localhost:3000"],
		["ipv4", "127.0.0.1"],
		["ipv4 with port and path", "192.168.1.1:8080/status"],
		["ipv6 literal", "[::1]"],
		["ipv6 with port", "[2001:db8::1]:443"],
		["domain with path and query", "example.com/path?q=1"],
	])("treats %s as a URL", (_name, input) => {
		expect(looksLikeUrl(input)).toBe(true);
	});
});

describe("looksLikeUrl - false cases", () => {
	it.each([
		["empty string", ""],
		["whitespace only", "   "],
		["prose with a space before the dot", "hello world.com"],
		["plain multi-word text", "how do i do this"],
		["unknown TLD", "notatld.zzz"],
		["single label", "justaword"],
		["javascript scheme (dangerous)", "javascript:alert(1)"],
		["data scheme (dangerous)", "data:text/html,x"],
		["vbscript scheme (dangerous)", "vbscript:msgbox"],
		["chrome scheme (dangerous)", "chrome://settings"],
		["about scheme (dangerous)", "about:blank"],
		["custom scheme is left to search", "myapp://open"],
	])("does not treat %s as a URL", (_name, input) => {
		expect(looksLikeUrl(input)).toBe(false);
	});

	it("rejects a host whose last label is not a known TLD", () => {
		expect(looksLikeUrl("foo.bar")).toBe(false);
	});
});

describe("looksLikeQuestion", () => {
	it("is true for anything ending in a question mark", () => {
		expect(looksLikeQuestion("weather?")).toBe(true);
	});

	it("is true for leading question/command words", () => {
		expect(looksLikeQuestion("what is rust")).toBe(true);
		expect(looksLikeQuestion("Explain closures")).toBe(true);
		expect(looksLikeQuestion("summarize this article")).toBe(true);
		expect(looksLikeQuestion("write me a poem")).toBe(true);
	});

	it("is true for long inputs (6+ words) even without a question word", () => {
		expect(looksLikeQuestion("foxes hunt small rodents at night")).toBe(true);
	});

	it("is false for short non-question phrases", () => {
		expect(looksLikeQuestion("rust programming")).toBe(false);
		expect(looksLikeQuestion("best pizza nyc")).toBe(false);
	});
});

describe("route - explicit prefixes have no alternatives", () => {
	it("routes a slash command to a skill", () => {
		const r = route("/deploy prod now");
		expect(r.primary).toEqual({
			kind: "skill",
			name: "deploy",
			rest: "prod now",
			label: "Run /deploy",
		});
		expect(r.alternatives).toEqual([]);
	});

	it("labels a bare slash as pick-a-skill", () => {
		const r = route("/");
		expect(r.primary).toMatchObject({ kind: "skill", name: "", rest: "" });
		expect((r.primary as { label: string }).label).toBe("Pick a skill");
	});

	it("collects @mentions into targets", () => {
		const r = route("@alice ping @bob");
		expect(r.primary).toEqual({
			kind: "mention",
			targets: ["alice", "bob"],
			rest: "@alice ping @bob",
			label: "Ask Ryu with @alice @bob",
		});
		expect(r.alternatives).toEqual([]);
	});

	it("routes a known bang to its destination", () => {
		const r = route("!g rust lang");
		expect(r.primary).toMatchObject({
			kind: "bang",
			bang: "g",
			query: "rust lang",
			url: SEARCH_ENGINES.google.buildUrl("rust lang"),
			label: "Google rust lang",
		});
		expect(r.alternatives).toEqual([]);
	});

	it("is case-insensitive on the bang keyword", () => {
		const r = route("!GH ryu");
		expect(r.primary).toMatchObject({ kind: "bang", bang: "GH" });
		expect((r.primary as { url: string }).url).toBe(BANGS.gh.build("ryu"));
	});

	it("falls back to search for an unknown bang", () => {
		const r = route("!zzz find me");
		expect(r.primary).toMatchObject({
			kind: "search",
			query: "zzz find me",
		});
		expect(r.alternatives).toEqual([]);
	});

	it("forces search with a leading ? but offers AI as an alternative", () => {
		const r = route("?best editor");
		expect(r.primary).toMatchObject({ kind: "search", query: "best editor" });
		expect(r.alternatives).toEqual([{ kind: "ai", prompt: "best editor", label: "Ask Ryu" }]);
	});
});

describe("route - implicit classification with cyclable fallbacks", () => {
	it("returns an empty AI intent for blank input", () => {
		const r = route("");
		expect(r.primary).toEqual({ kind: "ai", prompt: "", label: "Ask Ryu" });
		expect(r.alternatives).toEqual([]);
	});

	it("navigates a URL, with search then AI as fallbacks", () => {
		const r = route("example.com");
		expect(r.primary).toEqual({
			kind: "navigate",
			url: "https://example.com",
			label: "Go to example.com",
		});
		expect(r.alternatives.map((a) => a.kind)).toEqual(["search", "ai"]);
	});

	it("asks the AI for a question, with search as the fallback", () => {
		const r = route("what is a monad");
		expect(r.primary).toMatchObject({ kind: "ai", prompt: "what is a monad" });
		expect(r.alternatives.map((a) => a.kind)).toEqual(["search"]);
	});

	it("searches plain keywords, with AI as the fallback", () => {
		const r = route("rust ownership");
		expect(r.primary).toMatchObject({ kind: "search", query: "rust ownership" });
		expect(r.alternatives.map((a) => a.kind)).toEqual(["ai"]);
	});

	it("honors a non-default engine for search intents", () => {
		const r = route("rust ownership", "duckduckgo");
		expect(r.primary).toMatchObject({
			kind: "search",
			engine: "duckduckgo",
			url: SEARCH_ENGINES.duckduckgo.buildUrl("rust ownership"),
		});
	});

	it("defaults to Google as the search engine", () => {
		expect(DEFAULT_ENGINE).toBe("google");
	});
});

describe("SEARCH_ENGINES + BANGS build encoded URLs", () => {
	it("percent-encodes the query for each engine", () => {
		expect(SEARCH_ENGINES.google.buildUrl("a b&c")).toBe(
			"https://www.google.com/search?q=a%20b%26c"
		);
		expect(SEARCH_ENGINES.bing.buildUrl("x y")).toContain("q=x%20y");
	});

	it("every bang builds an https URL", () => {
		for (const [key, entry] of Object.entries(BANGS)) {
			const url = entry.build("test query");
			expect(url.startsWith("https://"), `${key} builds https`).toBe(true);
			expect(url).toContain("test%20query");
		}
	});
});
