// The local traffic map's node names reach translated sentences
// ("Open {label}", "{label} settings"), so each label is translated where the
// topology is built. Ids stay English: they key persistence and routing.

import { describe, expect, test } from "bun:test";
import type { CanvasNode } from "@ryu/blocks/desktop/gateway-canvas/model.ts";
import { formatMessage, type MessageValuesInput } from "@ryu/i18n";
import type { LiteralMessage } from "@ryu/i18n/react";
import { buildLocalTopology } from "./gateway-traffic-map.ts";

// A fake ja catalog: every message the topology asks for comes back marked,
// so an untranslated label is one that still reads as plain ASCII English.
const ja: LiteralMessage = (source: string, values?: MessageValuesInput) =>
	`訳:${formatMessage(source, values ?? {}, "ja")}`;
const en: LiteralMessage = (source: string, values?: MessageValuesInput) =>
	formatMessage(source, values ?? {});

const input = {
	gatewayReachable: true,
	providers: ["openai", "my-upstream"],
	signedIn: true,
};

/** Provider names are product names, and Ryu Core a brand: never translated. */
function isNamedProduct(node: CanvasNode): boolean {
	return node.kind === "provider" && node.id !== "provider:other"
		? true
		: node.id === "infra:core";
}

describe("buildLocalTopology under a translated locale", () => {
	test("every display label is translated, not English", () => {
		const { nodes } = buildLocalTopology(input, ja);
		const translatable = nodes.filter((node) => !isNamedProduct(node));
		expect(translatable.length).toBeGreaterThanOrEqual(20);
		const english = translatable
			.filter((node) => !node.label.startsWith("訳:"))
			.map((node) => node.label);
		expect(english).toEqual([]);
		for (const label of ["Organization", "Router", "This gateway"]) {
			expect(nodes.some((node) => node.label === `訳:${label}`)).toBe(true);
		}
	});

	test("details are translated, except the literal API paths", () => {
		const { nodes } = buildLocalTopology(input, ja);
		const untranslated = nodes
			.filter((node) => node.detail && !node.detail.startsWith("訳:"))
			.map((node) => node.detail);
		expect(untranslated).toEqual(["/v1/chat, /v1/responses", "/v1/messages"]);
	});

	test("node ids are the same in every language", () => {
		const ids = (tl: LiteralMessage) =>
			buildLocalTopology(input, tl).nodes.map((node) => node.id);
		expect(ids(ja)).toEqual(ids(en));
	});

	test("English reads as before", () => {
		const { nodes } = buildLocalTopology(input, en);
		const byId = new Map(nodes.map((node) => [node.id, node.label]));
		expect(byId.get("scope:org")).toBe("Organization");
		expect(byId.get("infra:core")).toBe("Ryu Core");
	});
});
