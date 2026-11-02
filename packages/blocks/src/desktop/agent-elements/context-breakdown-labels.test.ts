import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { formatMessage, type MessageValuesInput } from "@ryu/i18n/core";
import {
	type ContextLiteral,
	contextSegmentDetail,
	contextSegmentLabel,
} from "./context-breakdown-labels.ts";
import { contextBands } from "./context-breakdown-model.ts";

/** A translator that marks every source it was asked for. */
function recordingLiteral() {
	const seen: string[] = [];
	const tl: ContextLiteral = (source, values: MessageValuesInput = {}) => {
		seen.push(source);
		return `«${formatMessage(source, values, "en")}»`;
	};
	return { seen, tl };
}

const SEGMENT_RS = fileURLToPath(
	new URL(
		"../../../../../apps/core/src/sidecar/adapters/context_breakdown/segment.rs",
		import.meta.url
	)
);

/** The `labelKey`s Core can emit, read from its `label_key` table. */
function coreLabelKeys(): string[] {
	const source = readFileSync(SEGMENT_RS, "utf8");
	const table = source.slice(source.indexOf("pub fn label_key"));
	return [...table.matchAll(/"[^"]+"\s*=>\s*"([a-z_]+)"/g)].map(
		(match) => match[1] ?? ""
	);
}

describe("contextSegmentLabel", () => {
	test("translates every label key Core emits", () => {
		const keys = coreLabelKeys();
		expect(keys.length).toBeGreaterThan(15);
		for (const labelKey of keys) {
			const { tl } = recordingLiteral();
			const label = contextSegmentLabel(
				{ label: "server fallback", labelKey },
				tl
			);
			expect(label.startsWith("«")).toBe(true);
			expect(label).not.toContain("server fallback");
		}
	});

	test("translates through whole literal messages", () => {
		const { seen, tl } = recordingLiteral();
		expect(
			contextSegmentLabel(
				{ label: "Tool definitions", labelKey: "tool_definitions" },
				tl
			)
		).toBe("«Tool definitions»");
		expect(seen).toEqual(["Tool definitions"]);
	});

	test("falls back to Core's label for an unknown or missing key", () => {
		const { tl } = recordingLiteral();
		expect(
			contextSegmentLabel({ label: "Future layer", labelKey: "future" }, tl)
		).toBe("Future layer");
		expect(contextSegmentLabel({ label: "Older Core" }, tl)).toBe("Older Core");
	});
});

describe("contextSegmentDetail", () => {
	test("pluralizes the tool and server counts as one sentence", () => {
		const { tl } = recordingLiteral();
		expect(
			contextSegmentDetail(
				{
					counts: { servers: 1, tools: 24 },
					detailKey: "tools",
					label: "Tool definitions",
				},
				tl
			)
		).toBe("«24 tools across 1 server»");
	});

	test("pluralizes messages, images and skills from counts", () => {
		const { tl } = recordingLiteral();
		const detail = (detailKey: string, counts: Record<string, number>) =>
			contextSegmentDetail({ counts, detailKey, label: "x" }, tl);
		expect(detail("messages", { messages: 1 })).toBe("«1 message»");
		expect(detail("messages", { messages: 12 })).toBe("«12 messages»");
		expect(detail("images", { images: 3 })).toBe("«3 images»");
		expect(detail("skills", { skills: 2 })).toBe("«2 enabled»");
		expect(detail("replayed_turns", {})).toBe("«replayed turns»");
	});

	test("falls back to Core's English detail when the key or counts are unusable", () => {
		const { tl } = recordingLiteral();
		expect(
			contextSegmentDetail(
				{ detail: "3 widgets", detailKey: "widgets", label: "x" },
				tl
			)
		).toBe("3 widgets");
		expect(
			contextSegmentDetail(
				{ detail: "24 tools across 5 servers", detailKey: "tools", label: "x" },
				tl
			)
		).toBe("24 tools across 5 servers");
		expect(contextSegmentDetail({ detail: "plain", label: "x" }, tl)).toBe(
			"plain"
		);
	});
});

describe("contextBands with a translator", () => {
	test("localizes segment rows and the Unattributed band", () => {
		const { tl } = recordingLiteral();
		const bands = contextBands(
			{
				attributed: 100,
				plane: "acp",
				reserveOutput: 0,
				segments: [
					{
						counts: { servers: 5, tools: 24 },
						detail: "24 tools across 5 servers",
						detailKey: "tools",
						kind: "tools",
						label: "Tool definitions",
						labelKey: "tool_definitions",
						tokens: 100,
					},
				],
				window: 0,
			},
			150,
			tl
		);
		expect(bands.map((band) => [band.label, band.detail])).toEqual([
			["«Tool definitions»", "«24 tools across 5 servers»"],
			[
				"«Unattributed»",
				"«Agent-side prompt and tool results Core cannot measure»",
			],
		]);
	});
});

/** A translator backed by a per-locale catalog, as a language pack supplies. */
function catalogLiteral(
	locale: string,
	catalog: Readonly<Record<string, string>>
): ContextLiteral {
	return (source, values: MessageValuesInput = {}) =>
		formatMessage(catalog[source] ?? source, values, locale);
}

const TOOLS_SOURCE =
	"{tools, plural, one {# tool} other {# tools}} across {servers, plural, one {# server} other {# servers}}";

describe("contextBands in translated locales", () => {
	const segment = (tools: number, servers: number) => ({
		attributed: 10,
		plane: "openai" as const,
		reserveOutput: 0,
		segments: [
			{
				counts: { servers, tools },
				detail: `${tools} tools across ${servers} servers`,
				detailKey: "tools",
				kind: "tools",
				label: "Tool definitions",
				labelKey: "tool_definitions",
				tokens: 10,
			},
		],
		window: 0,
	});

	test("ja renders the label and counted detail from the pack", () => {
		const tl = catalogLiteral("ja", {
			"Tool definitions": "ツール定義",
			[TOOLS_SOURCE]: "{servers} 個のサーバーにまたがる {tools} 個のツール",
		});
		const [band] = contextBands(segment(24, 5), undefined, tl);
		expect([band?.label, band?.detail]).toEqual([
			"ツール定義",
			"5 個のサーバーにまたがる 24 個のツール",
		]);
	});

	test("ar selects its own plural categories per count", () => {
		const tl = catalogLiteral("ar", {
			"Tool definitions": "تعريفات الأدوات",
			[TOOLS_SOURCE]:
				"{tools, plural, zero {لا أدوات} one {أداة واحدة} two {أداتان} few {# أدوات} many {# أداة} other {# أداة}} عبر {servers, plural, zero {لا خوادم} one {خادم واحد} two {خادمين} few {# خوادم} many {# خادمًا} other {# خادم}}",
		});
		const detail = (tools: number, servers: number) =>
			contextBands(segment(tools, servers), undefined, tl)[0]?.detail;
		expect(detail(2, 1)).toBe("أداتان عبر خادم واحد");
		expect(detail(3, 11)).toBe("3 أدوات عبر 11 خادمًا");
		expect(contextBands(segment(2, 1), undefined, tl)[0]?.label).toBe(
			"تعريفات الأدوات"
		);
	});

	test("de keeps the sentence whole and pluralizes each count", () => {
		const tl = catalogLiteral("de", {
			"{count, plural, one {# message} other {# messages}}":
				"{count, plural, one {# Nachricht} other {# Nachrichten}}",
			"Conversation history": "Gesprächsverlauf",
			[TOOLS_SOURCE]:
				"{tools, plural, one {# Tool} other {# Tools}} aus {servers, plural, one {# Server} other {# Servern}}",
			Unattributed: "Nicht zugeordnet",
		});
		const bands = contextBands(
			{
				...segment(1, 2),
				segments: [
					...segment(1, 2).segments,
					{
						counts: { messages: 1 },
						detail: "1 message",
						detailKey: "messages",
						kind: "messages",
						label: "Conversation history",
						labelKey: "conversation_history",
						tokens: 5,
					},
				],
			},
			40,
			tl
		);
		expect(bands.map((band) => [band.label, band.detail])).toEqual([
			["Tool definitions", "1 Tool aus 2 Servern"],
			["Gesprächsverlauf", "1 Nachricht"],
			[
				"Nicht zugeordnet",
				"Agent-side prompt and tool results Core cannot measure",
			],
		]);
	});
});
