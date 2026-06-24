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
		});
	});

	it("parses a skill link with an owner/repo/slug id", () => {
		expect(parseRyuDeepLink("ryu://skills/skills.sh/acme/pack/fix")).toEqual({
			kind: "skill",
			source: "skills.sh",
			id: "acme/pack/fix",
		});
	});

	it("tolerates a trailing slash and percent-encoding", () => {
		expect(
			parseRyuDeepLink("ryu://models/huggingface/unsloth/my%20model/")
		).toEqual({
			kind: "model",
			source: "huggingface",
			id: "unsloth/my model",
		});
	});

	it("rejects unknown categories, schemes, and incomplete links", () => {
		expect(parseRyuDeepLink("ryu://agents/x/y")).toBeNull();
		expect(parseRyuDeepLink("https://models/huggingface/x")).toBeNull();
		expect(parseRyuDeepLink("ryu://models/huggingface")).toBeNull();
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
});

describe("buildRyuDeepLink round-trips with parseRyuDeepLink", () => {
	const cases: DeepLinkIntent[] = [
		{
			kind: "model",
			source: "huggingface",
			id: "unsloth/gemma-4-12B-it-qat-GGUF",
		},
		{ kind: "skill", source: "skills.sh", id: "acme/pack/fix" },
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
});
