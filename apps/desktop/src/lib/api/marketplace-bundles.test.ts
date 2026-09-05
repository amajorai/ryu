import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import type { MarketplaceBundleMember } from "@ryu/marketplace/catalog/bundle-types";
import type { ApiTarget } from "./client.ts";

const calls: string[] = [];
let installMarketplaceBundle: typeof import("./marketplace-bundles.ts").installMarketplaceBundle;

const member = (
	kind: MarketplaceBundleMember["kind"],
	id: string,
	required = true
): MarketplaceBundleMember => ({
	id,
	kind,
	name: id,
	required,
	source: null,
});

beforeAll(async () => {
	mock.module("./agents.ts", () => ({
		installPublishedAgent: async (_target: ApiTarget, id: string) => {
			calls.push(`agent:${id}`);
			return {};
		},
	}));
	mock.module("./mcp.ts", () => ({
		installMcpServer: async (_target: ApiTarget, id: string) => {
			calls.push(`mcp:${id}`);
			return {};
		},
	}));
	mock.module("./marketplace.ts", () => ({
		installPortablePackage: async () => undefined,
		recordMarketplaceUsage: async (
			_target: ApiTarget,
			input: { id: string }
		) => {
			calls.push(`usage:${input.id}`);
		},
	}));
	mock.module("./plugins.ts", () => ({
		installApp: async (_target: ApiTarget, id: string) => {
			calls.push(`app:${id}`);
			if (id === "@ryu/already") {
				throw Object.assign(new Error("already installed"), { status: 409 });
			}
			return {};
		},
		installPluginFromCatalog: async (_target: ApiTarget, id: string) => {
			calls.push(`plugin:${id}`);
			if (id === "@ryu/optional-failure") {
				throw new Error("publisher unavailable");
			}
		},
	}));
	mock.module("./skills.ts", () => ({
		installSkill: async (_target: ApiTarget, id: string) => {
			calls.push(`skill:${id}`);
			return {};
		},
	}));
	mock.module("./workflows.ts", () => ({
		installWorkflowTemplate: async (_target: ApiTarget, id: string) => {
			calls.push(`workflow:${id}`);
			return id;
		},
	}));
	({ installMarketplaceBundle } = await import("./marketplace-bundles.ts"));
});

afterAll(() => {
	mock.restore();
});

describe("Marketplace bundle orchestration", () => {
	test("continues after optional failure and reports conflicts separately", async () => {
		calls.length = 0;
		const result = await installMarketplaceBundle(
			{ token: null, url: "http://localhost:7980" },
			"ryu/bundle/test",
			[
				member("app", "@ryu/already"),
				member("plugin", "@ryu/optional-failure", false),
				member("skill", "addyosmani/best-practices"),
				member("agent", "ryu/design-director"),
			]
		);

		expect(calls).toEqual([
			"app:@ryu/already",
			"plugin:@ryu/optional-failure",
			"skill:addyosmani/best-practices",
			"agent:ryu/design-director",
			"usage:ryu/bundle/test",
		]);
		expect(result.skipped.map((item) => item.id)).toEqual(["@ryu/already"]);
		expect(result.completed.map((item) => item.id)).toEqual([
			"addyosmani/best-practices",
			"ryu/design-director",
		]);
		expect(result.failures.map(({ member: item }) => item.id)).toEqual([
			"@ryu/optional-failure",
		]);
	});
});
