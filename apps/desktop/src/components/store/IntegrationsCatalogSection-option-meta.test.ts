import { describe, expect, test } from "bun:test";
import type { IntegrationOption } from "@/src/lib/api/integrations.ts";
import { providerOptionMetaParts } from "./IntegrationsCatalogSection-option-meta.ts";

const tl = (source: string) => `[${source}]`;

function option(overrides: Partial<IntegrationOption>): IntegrationOption {
	return {
		action: "connect",
		availabilityNote: null,
		available: true,
		capability: null,
		comparisonKey: null,
		connectionId: null,
		description: null,
		id: "id",
		isCheapest: false,
		kind: "mcp",
		name: "Example",
		price: null,
		provider: null,
		providerRole: null,
		source: "directory",
		url: null,
		...overrides,
	};
}

describe("providerOptionMetaParts", () => {
	test("translates the source and kind labels as separate parts", () => {
		const parts = providerOptionMetaParts(
			option({ kind: "treg-endpoint", source: "ryu" }),
			tl
		);
		expect(parts.slice(0, 2)).toEqual(["[Ryu catalog]", "[Treg endpoint]"]);
		expect(parts.some((part) => part.includes(" · "))).toBe(false);
	});

	test("keeps brand sources and acronym kinds, translates Alternative", () => {
		const parts = providerOptionMetaParts(
			option({
				kind: "mcp",
				provider: "Acme",
				providerRole: "alternative",
				source: "composio",
			}),
			tl
		);
		expect(parts.slice(0, 4)).toEqual([
			"Composio",
			"MCP",
			"[Alternative]",
			"Acme",
		]);
	});

	test("translates the Ryu endpoint and platform catalog kinds", () => {
		expect(
			providerOptionMetaParts(option({ kind: "ryu-endpoint" }), tl)[1]
		).toBe("[Ryu endpoint]");
		expect(
			providerOptionMetaParts(option({ kind: "ryu-platform" }), tl)[1]
		).toBe("[Platform catalog]");
	});
});
