import { describe, expect, it } from "bun:test";
import {
	buildRyuDeepLink,
	type DeepLinkIntent,
	parseRyuDeepLink,
} from "./deep-link.ts";

describe("parseRyuDeepLink", () => {
	it("parses a Hugging Face model link, keeping the -GGUF suffix and case", () => {
		expect(
			parseRyuDeepLink(
				"ryu://models/huggingface/unsloth/gemma-4-12B-it-qat-GGUF"
			)
		).toEqual({
			kind: "model",
			source: "huggingface",
			id: "unsloth/gemma-4-12B-it-qat-GGUF",
			node: null,
		});
	});

	it("parses a skill link with an owner/repo/slug id", () => {
		expect(parseRyuDeepLink("ryu://skills/skills.sh/acme/pack/fix")).toEqual({
			kind: "skill",
			source: "skills.sh",
			id: "acme/pack/fix",
			node: null,
		});
	});

	it("parses an app link with a scoped plugin id", () => {
		expect(parseRyuDeepLink("ryu://apps/@ryu/clips")).toEqual({
			kind: "app",
			id: "@ryu/clips",
			node: null,
		});
		expect(parseRyuDeepLink("ryu://apps/com.ryu.agentbrowser")).toEqual({
			kind: "app",
			id: "com.ryu.agentbrowser",
			node: null,
		});
	});

	it("parses a bundle link with a scoped install-target node", () => {
		expect(
			parseRyuDeepLink(
				"ryu://bundles/ryu/bundle/craft?node=https%3A%2F%2Fnode.example.com%3A7980%2F"
			)
		).toEqual({
			kind: "bundle",
			id: "ryu/bundle/craft",
			node: "https://node.example.com:7980",
		});
	});

	it("parses an app link with an install-target node hint", () => {
		expect(
			parseRyuDeepLink(
				"ryu://apps/@ryu/clips?node=https%3A%2F%2Fnode.example.com%3A7980%2F"
			)
		).toEqual({
			kind: "app",
			id: "@ryu/clips",
			node: "https://node.example.com:7980",
		});
	});

	it("tolerates a trailing slash and percent-encoding", () => {
		expect(
			parseRyuDeepLink("ryu://models/huggingface/unsloth/my%20model/")
		).toEqual({
			kind: "model",
			source: "huggingface",
			id: "unsloth/my model",
			node: null,
		});
	});

	it("parses the optional install-target node url, trimming a trailing slash", () => {
		expect(
			parseRyuDeepLink(
				"ryu://skills/skills.sh/acme/pack/fix?node=https%3A%2F%2Fnode.example.com%3A7980%2F"
			)
		).toEqual({
			kind: "skill",
			source: "skills.sh",
			id: "acme/pack/fix",
			node: "https://node.example.com:7980",
		});
	});

	it("ignores a node hint that is not an http(s) url", () => {
		for (const bad of [
			"javascript%3Aalert(1)",
			"file%3A%2F%2F%2Fetc",
			"local",
		]) {
			expect(
				parseRyuDeepLink(`ryu://models/huggingface/unsloth/x?node=${bad}`)
			).toEqual({
				kind: "model",
				source: "huggingface",
				id: "unsloth/x",
				node: null,
			});
		}
	});

	it("rejects unknown categories, schemes, and incomplete links", () => {
		expect(parseRyuDeepLink("ryu://agents/x/y")).toBeNull();
		expect(parseRyuDeepLink("https://models/huggingface/x")).toBeNull();
		expect(parseRyuDeepLink("ryu://models/huggingface")).toBeNull();
		expect(parseRyuDeepLink("ryu://apps/")).toBeNull();
		expect(parseRyuDeepLink("not a url")).toBeNull();
	});

	it("parses a node-connect link with url, token, and name", () => {
		expect(
			parseRyuDeepLink(
				"ryu://nodes/connect?url=http%3A%2F%2F192.168.1.50%3A7980&token=ryu_abc123&name=pi-home"
			)
		).toEqual({
			kind: "node",
			name: "pi-home",
			url: "http://192.168.1.50:7980",
			token: "ryu_abc123",
		});
	});

	it("derives a safe node name and null token when omitted", () => {
		expect(
			parseRyuDeepLink(
				"ryu://nodes/connect?url=http%3A%2F%2F192.168.1.50%3A7980"
			)
		).toEqual({
			kind: "node",
			name: "node-192-168-1-50",
			url: "http://192.168.1.50:7980",
			token: null,
		});
	});

	it("rejects a node link without a url", () => {
		expect(parseRyuDeepLink("ryu://nodes/connect?name=x")).toBeNull();
	});

	it("parses a page-navigation link and lower-cases the page key", () => {
		expect(parseRyuDeepLink("ryu://open/agents")).toEqual({
			kind: "page",
			page: "agents",
		});
		expect(parseRyuDeepLink("ryu://open/settings/")).toEqual({
			kind: "page",
			page: "settings",
		});
		expect(parseRyuDeepLink("ryu://open/MONITORS")).toEqual({
			kind: "page",
			page: "monitors",
		});
		expect(parseRyuDeepLink("ryu://open/")).toBeNull();
		expect(parseRyuDeepLink("ryu://open")).toBeNull();
	});

	it("parses a new-chat link with prompt, agent, and project", () => {
		expect(
			parseRyuDeepLink(
				"ryu://chat/new?prompt=Fix%20the%20build&agent=ryu&project=%2Fhome%2Fme%2Fapp"
			)
		).toEqual({
			kind: "chat",
			conversationId: null,
			prompt: "Fix the build",
			agent: "ryu",
			project: "/home/me/app",
		});
	});

	it("decodes `+` as a space in query values", () => {
		expect(parseRyuDeepLink("ryu://chat/new?prompt=Fix+the+build")).toEqual({
			kind: "chat",
			conversationId: null,
			prompt: "Fix the build",
			agent: null,
			project: null,
		});
	});

	it("parses a bare new-chat and an open-existing-conversation link", () => {
		expect(parseRyuDeepLink("ryu://chat/new")).toEqual({
			kind: "chat",
			conversationId: null,
			prompt: null,
			agent: null,
			project: null,
		});
		expect(parseRyuDeepLink("ryu://chat/conv-abc-123")).toEqual({
			kind: "chat",
			conversationId: "conv-abc-123",
			prompt: null,
			agent: null,
			project: null,
		});
	});

	it("parses an RNP handoff without accepting credentials in the source URL", () => {
		expect(
			parseRyuDeepLink(
				"ryu://handoff/conv-abc-123?source=https%3A%2F%2Fnode.example.com%3A7980%2F&v=0"
			)
		).toEqual({
			kind: "handoff",
			version: 0,
			conversationId: "conv-abc-123",
			sourceNodeUrl: "https://node.example.com:7980",
		});
		expect(
			parseRyuDeepLink(
				"ryu://handoff/conv-abc-123?source=https%3A%2F%2Fuser%3Asecret%40node.example.com&v=0"
			)
		).toBeNull();
		expect(
			parseRyuDeepLink(
				"ryu://handoff/conv-abc-123?source=https%3A%2F%2Fnode.example.com&v=0&token=secret"
			)
		).toBeNull();
	});
});

describe("buildRyuDeepLink round-trips with parseRyuDeepLink", () => {
	const cases: DeepLinkIntent[] = [
		{
			kind: "model",
			source: "huggingface",
			id: "unsloth/gemma-4-12B-it-qat-GGUF",
			node: null,
		},
		{
			kind: "model",
			source: "huggingface",
			id: "unsloth/gemma-4-12B-it-qat-GGUF",
			node: "https://node.example.com:7980",
		},
		{ kind: "skill", source: "skills.sh", id: "acme/pack/fix", node: null },
		{
			kind: "skill",
			source: "skills.sh",
			id: "acme/pack/fix",
			node: "http://192.168.1.50:7980",
		},
		{ kind: "app", id: "@ryu/clips", node: null },
		{
			kind: "app",
			id: "com.ryu.agentbrowser",
			node: "https://node.example.com:7980",
		},
		{ kind: "bundle", id: "ryu/bundle/craft", node: null },
		{
			kind: "bundle",
			id: "ryu/bundle/software-factory",
			node: "https://node.example.com:7980",
		},
		{
			kind: "node",
			name: "pi-home",
			url: "http://192.168.1.50:7980",
			token: "ryu_abc123",
		},
		{
			kind: "node",
			name: "pi-home",
			url: "http://192.168.1.50:7980",
			token: null,
		},
		{ kind: "page", page: "marketplace" },
		{
			kind: "handoff",
			version: 0,
			conversationId: "conv-abc-123",
			sourceNodeUrl: "https://node.example.com:7980",
		},
		{
			kind: "chat",
			conversationId: null,
			prompt: "Summarize today's PRs",
			agent: "ryu",
			project: "/home/me/app",
		},
		{
			kind: "chat",
			conversationId: "conv-abc-123",
			prompt: null,
			agent: null,
			project: null,
		},
	];

	for (const intent of cases) {
		it(`rebuilds a ${intent.kind} intent losslessly`, () => {
			expect(parseRyuDeepLink(buildRyuDeepLink(intent))).toEqual(intent);
		});
	}

	// The node link is what a user copies as a connection string, so its `url`
	// stays readable rather than percent-encoded into `https%3A%2F%2F…`.
	it("emits a readable node connection string", () => {
		expect(
			buildRyuDeepLink({
				kind: "node",
				name: "prod",
				url: "https://node.example.com:7980",
			})
		).toBe("ryu://nodes/connect?url=https://node.example.com:7980&name=prod");
	});

	// Links built by older surfaces percent-encoded the url; those must keep
	// parsing, so the readability change is additive rather than a format break.
	it("still parses a percent-encoded node url", () => {
		expect(
			parseRyuDeepLink(
				"ryu://nodes/connect?url=https%3A%2F%2Fnode.example.com%3A7980&name=prod"
			)
		).toEqual({
			kind: "node",
			name: "prod",
			url: "https://node.example.com:7980",
			token: null,
		});
	});
});
