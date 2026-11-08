import { describe, expect, it } from "bun:test";
import {
	FILE_CONTENTS_NOT_INDEXED_BADGE,
	FILE_CONTENTS_PENDING_BADGE,
	indexBadgeLabel,
} from "./spaces-index-state.ts";

// The badge words go through tl(), so a non-English Spaces list does not show
// an English "Name only" at the end of every unread file's row.
const JA: Record<string, string> = {
	"Name only": "名前のみ",
	"Reading…": "読み込み中…",
};
const japanese = (source: string) => JA[source] ?? source;

describe("indexBadgeLabel", () => {
	it("spells the same words as the exported badge constants", () => {
		expect(indexBadgeLabel("pending")).toBe(FILE_CONTENTS_PENDING_BADGE);
		for (const state of ["failed", "skipped", "unattempted"] as const) {
			expect(indexBadgeLabel(state)).toBe(FILE_CONTENTS_NOT_INDEXED_BADGE);
		}
		expect(indexBadgeLabel("indexed")).toBeNull();
		expect(indexBadgeLabel(undefined)).toBeNull();
	});

	it("translates the badge through the caller's tl", () => {
		expect(indexBadgeLabel("skipped", japanese)).toBe("名前のみ");
		expect(indexBadgeLabel("pending", japanese)).toBe("読み込み中…");
		expect(indexBadgeLabel("indexed", japanese)).toBeNull();
	});
});
