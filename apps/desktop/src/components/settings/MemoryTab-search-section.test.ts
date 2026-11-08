import { describe, expect, test } from "bun:test";
import { formatMessage, type LiteralMessage } from "@ryu/i18n";
import type { ScoredChunk } from "@/src/lib/api/retrieval.ts";
import { sourceLabel } from "./MemoryTab-search-section.tsx";

const german: Record<string, string> = {
	"Space · {name}": "Space · {name}",
	Uploads: "Hochgeladene Dateien",
};
const de: LiteralMessage = (source, values) =>
	formatMessage(german[source] ?? source, values ?? {}, "de");

function chunk(spaceId: string): ScoredChunk {
	return { content: "", id: "c1", score: 1, source: "space", spaceId };
}

describe("sourceLabel", () => {
	test("names an unrenamed system Space in the reader's language", () => {
		expect(
			sourceLabel(
				chunk("s1"),
				[{ id: "s1", name: "Uploads", system: true }],
				de
			)
		).toBe("Space · Hochgeladene Dateien");
	});

	test("keeps a user Space's own name", () => {
		expect(sourceLabel(chunk("s2"), [{ id: "s2", name: "Uploads" }], de)).toBe(
			"Space · Uploads"
		);
	});
});
