import { describe, expect, test } from "bun:test";
import {
	MARKETPLACE_BROWSE_KINDS,
	MARKETPLACE_HOME_SHELVES,
	MARKETPLACE_SECTION_TABS,
	marketplaceBrowseKindLabel,
	marketplaceHomeShelfDefinition,
} from "./marketplace-sections.ts";

describe("Marketplace surface contract", () => {
	test("owns one ordered built-in tab list", () => {
		expect(MARKETPLACE_SECTION_TABS.map((tab) => tab.value)).toEqual([
			"home",
			"integrations",
			"apps",
			"plugins",
			"models",
			"skills",
			"mcp",
			"agents",
			"engines",
			"workflows",
			"themes",
			"marketplaces",
			"browse",
			"connections",
			"licenses",
			"sell",
		]);
	});

	test("owns the Home shelf order and labels", () => {
		expect(MARKETPLACE_HOME_SHELVES.map((shelf) => shelf.key)).toEqual([
			"models",
			"skills",
			"mcp",
			"agents",
			"apps",
			"plugins",
		]);
		expect(marketplaceHomeShelfDefinition("models").title).toBe(
			"Popular models"
		);
	});

	test("owns the Browse category order", () => {
		expect(MARKETPLACE_BROWSE_KINDS.map((kind) => kind.value)).toEqual([
			"app",
			"skill",
			"plugin",
			"mcp",
			"model",
			"agent",
			"stack_template",
			"workflow",
			"theme",
			"language_pack",
			"space",
			"profile",
			"output_style",
			"bundle",
		]);
		expect(
			MARKETPLACE_BROWSE_KINDS.find((kind) => kind.value === "agent")?.label
		).toBe("Agent Templates");
		expect(
			MARKETPLACE_SECTION_TABS.find((tab) => tab.value === "agents")?.label
		).toBe("Agents");
		expect(marketplaceBrowseKindLabel("agent")).toBe("Agent Templates");
	});
});
