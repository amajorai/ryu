import { describe, expect, test } from "bun:test";
import { formatMessage } from "@ryu/i18n/lite";
import type { LiteralMessage } from "@ryu/i18n/react";
import { maplibreLocale } from "./maplibre-labels.ts";
import {
	reactFlowAriaLiveMessage,
	reactFlowEdgeAriaLabel,
	reactFlowRoleDescriptions,
	reactFlowStaticLabels,
} from "./react-flow-labels.ts";

const english: LiteralMessage = (source, values = {}) =>
	formatMessage(source, values, "en");

describe("React Flow labels", () => {
	test("keep React Flow's English wording", () => {
		const labels = reactFlowStaticLabels(english);
		expect(labels["controls.fitView.ariaLabel"]).toBe("Fit View");
		expect(labels["minimap.ariaLabel"]).toBe("Mini Map");
		expect(labels["node.a11yDescription.default"]).toBe(
			"Press enter or space to select a node. Press delete to remove it and escape to cancel."
		);
	});

	test("announce keyboard moves as one sentence per direction", () => {
		const announce = reactFlowAriaLiveMessage(english);
		expect(announce({ direction: "left", x: 12, y: -4 })).toBe(
			"Moved selected node left. New position, x: 12, y: -4"
		);
		expect(announce({ direction: "sideways", x: 0, y: 0 })).toBe(
			"Moved selected node. New position, x: 0, y: 0"
		);
	});

	test("route every label through the translator", () => {
		const marked: LiteralMessage = (source) => `«${source}»`;
		for (const value of Object.values(reactFlowStaticLabels(marked))) {
			expect(value.startsWith("«")).toBe(true);
		}
		for (const value of Object.values(maplibreLocale(marked))) {
			expect(value.startsWith("«")).toBe(true);
		}
	});

	test("name nodes and edges in lowercase catalog keys and readable edge labels", () => {
		expect(reactFlowRoleDescriptions(english)).toEqual({
			edge: "edge",
			node: "node",
		});
		expect(reactFlowEdgeAriaLabel(english, "Gateway", "OpenAI")).toBe(
			"Edge from Gateway to OpenAI"
		);
		const marked: LiteralMessage = (source) => `«${source}»`;
		expect(reactFlowRoleDescriptions(marked).node).toBe("«node»");
		expect(reactFlowEdgeAriaLabel(marked, "a", "b")).toBe(
			"«Edge from {source} to {target}»"
		);
	});
});
