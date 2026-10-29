import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import type { MarketplaceBundleMember } from "@ryu/marketplace/catalog/bundle-types";
import type { ApiTarget } from "./client.ts";

const calls: string[] = [];
let installMarketplaceBundle: typeof import("./marketplace-bundles.ts").installMarketplaceBundle;
let describeBundleManualSteps: typeof import("./marketplace-bundles.ts").describeBundleManualSteps;

const member = (
	kind: MarketplaceBundleMember["kind"],
	id: string,
	required = true,
	source: string | null = null
): MarketplaceBundleMember => ({
	id,
	kind,
	name: id,
	required,
	source,
});

beforeAll(async () => {
	mock.module("./client.ts", () => ({
		request: async (
			_target: ApiTarget,
			path: string,
			init?: { body?: { id?: string } }
		) => {
			if (path === "/api/knowledge/catalog/install") {
				calls.push(`knowledge:${init?.body?.id ?? ""}`);
				return { success: true };
			}
			return undefined;
		},
	}));
	mock.module("./models.ts", () => ({
		installModelFile: async (_target: ApiTarget, id: string, file: string) => {
			calls.push(`model:${id}:${file}`);
			return { filename: file, path: file, repoId: id };
		},
	}));
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
	({ installMarketplaceBundle, describeBundleManualSteps } = await import(
		"./marketplace-bundles.ts"
	));
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
		expect(result.manual).toEqual([]);
	});

	test("installs model files and knowledge, and reports unpicked models as manual steps", async () => {
		calls.length = 0;
		const result = await installMarketplaceBundle(
			{ token: null, url: "http://localhost:7980" },
			"ryu/bundle/models",
			[
				member("model", "acme/tiny-GGUF", true, "tiny-Q4_K_M.gguf"),
				member("model", "acme/pick-me", true),
				member("model", "acme/escape", true, "../evil.gguf"),
				member("knowledge", "acme/handbook"),
			]
		);

		expect(calls).toEqual([
			"model:acme/tiny-GGUF:tiny-Q4_K_M.gguf",
			"knowledge:acme/handbook",
			"usage:ryu/bundle/models",
		]);
		expect(result.completed.map((item) => item.id)).toEqual([
			"acme/tiny-GGUF",
			"acme/handbook",
		]);
		expect(result.failures).toEqual([]);
		expect(result.manual.map(({ member: item }) => item.id)).toEqual([
			"acme/pick-me",
			"acme/escape",
		]);
		expect(describeBundleManualSteps(result.manual)).toContain(
			"2 need manual setup"
		);
		expect(describeBundleManualSteps([])).toBeNull();
	});
});
