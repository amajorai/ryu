import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { formatMessage, type LiteralMessage } from "@ryu/i18n";
import {
	hasUsageHistorySourceLabel,
	historySourceName,
	usageHistorySourceLabel,
} from "./usage-history-source-labels.ts";

// A Japanese catalog for two of the labels; the rest stay English.
const JAPANESE: Readonly<Record<string, string>> = {
	"OpenAI organization usage": "OpenAI 組織の使用量",
	"Saved Ryu sessions": "保存済みの Ryu セッション",
};

/** A Japanese `tl()`, recording every key it is asked. */
function japaneseTl(asked: string[]): LiteralMessage {
	return (source, values = {}) => {
		asked.push(source);
		return Object.hasOwn(JAPANESE, source)
			? (JAPANESE[source] as string)
			: formatMessage(source, values, "ja");
	};
}

/** Core's metadata-export source ids, read from `EXPORT_SOURCES`. */
function coreExportSourceIds(): string[] {
	const scan = readFileSync(
		join(import.meta.dir, "../../../../../apps/core/src/usage_history/scan.rs"),
		"utf8"
	);
	const list = /EXPORT_SOURCES: &\[&str\] = &\[([^\]]*)\]/u.exec(scan)?.[1];
	return [...(list ?? "").matchAll(/"([^"]+)"/gu)].map((match) => match[1]);
}

describe("usageHistorySourceLabel under a Japanese pack", () => {
	it("names every Core export source and Core's own sources", () => {
		const ids = [...coreExportSourceIds(), "ryu-sessions", "cursor-local"];
		expect(ids.length).toBeGreaterThanOrEqual(9);
		for (const id of ids) {
			const asked: string[] = [];
			const label = usageHistorySourceLabel(
				{ id, label: id.replaceAll("-", " ") },
				japaneseTl(asked)
			);
			expect(hasUsageHistorySourceLabel(id)).toBe(true);
			expect(asked).toHaveLength(1);
			expect(label).not.toBe(id.replaceAll("-", " "));
		}
	});

	it("renders the display name in the UI language", () => {
		const tl = japaneseTl([]);
		expect(
			usageHistorySourceLabel(
				{ id: "openai-org-usage", label: "openai org usage" },
				tl
			)
		).toBe("OpenAI 組織の使用量");
		expect(
			usageHistorySourceLabel(
				{ id: "ryu-sessions", label: "Saved Ryu sessions" },
				tl
			)
		).toBe("保存済みの Ryu セッション");
	});

	it("falls back to Core's label for product-named and unknown sources", () => {
		const asked: string[] = [];
		const tl = japaneseTl(asked);
		expect(usageHistorySourceLabel({ id: "codex", label: "Codex" }, tl)).toBe(
			"Codex"
		);
		expect(
			usageHistorySourceLabel({ id: "new-export", label: "new export" }, tl)
		).toBe("new export");
		expect(hasUsageHistorySourceLabel("toString")).toBe(false);
		expect(asked).toEqual([]);
	});

	it("names a report row's source for the chart legend and breakdown", () => {
		const report = {
			sources: [
				{ id: "openai-org-usage", label: "openai org usage" },
				{ id: "codex", label: "Codex" },
			],
		};
		const tl = japaneseTl([]);
		expect(historySourceName(report, "openai-org-usage", tl)).toBe(
			"OpenAI 組織の使用量"
		);
		expect(historySourceName(report, "codex", tl)).toBe("Codex");
		expect(historySourceName(report, "gone", tl)).toBe("gone");
	});
});
