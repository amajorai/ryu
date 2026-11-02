import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { LiteralMessage } from "@ryu/i18n/react";
import type { StoreCoverage } from "@/src/lib/api/encryption.ts";
import {
	ENCRYPTION_STORE_COPY,
	storeRowCopy,
} from "./encryption-store-copy.ts";

const CORE_STORES = fileURLToPath(
	new URL("../../../../core/src/server/encryption/stores.rs", import.meta.url)
);

/** Every store id Core's status builder can emit. */
function coreStoreIds(): string[] {
	const source = readFileSync(CORE_STORES, "utf8");
	const ids = new Set<string>();
	for (const match of source.matchAll(/"id":\s*"([a-z-]+)"/g)) {
		ids.add(match[1] ?? "");
	}
	for (const match of source.matchAll(/record_store\(\s*"([a-z-]+)"/g)) {
		ids.add(match[1] ?? "");
	}
	ids.delete("");
	return [...ids].sort();
}

/** A stand-in Japanese catalog: every source is "translated" with a marker. */
const ja: LiteralMessage = (source, values) =>
	`ja:${source.replace(/\{(\w+)\}/g, (_, name: string) =>
		String((values as Record<string, unknown> | undefined)?.[name] ?? "")
	)}`;

function row(id: string, extra: Record<string, unknown> = {}): StoreCoverage {
	return {
		detail: `Core English detail for ${id}`,
		id,
		label: `Core English label for ${id}`,
		sealed: null,
		status: "sealed",
		total: null,
		...extra,
	} as StoreCoverage;
}

describe("encryption store copy", () => {
	test("covers every store id Core emits", () => {
		const ids = coreStoreIds();
		expect(ids.length).toBeGreaterThanOrEqual(17);
		for (const id of ids) {
			expect(Object.hasOwn(ENCRYPTION_STORE_COPY, id)).toBe(true);
		}
	});

	test("renders every store in the reader's language, never Core's English", () => {
		for (const id of coreStoreIds()) {
			const copy = storeRowCopy(row(id, { unreadableCount: 0 }), ja);
			expect(copy.label.startsWith("ja:")).toBe(true);
			expect(copy.detail.startsWith("ja:")).toBe(true);
			expect(copy.detail).not.toContain("Core English");
		}
	});

	test("localizes the runtime parts from the values Core sends", () => {
		const agents = storeRowCopy(
			row("agents", { status: "partial", unreadableCount: 2 }),
			ja
		);
		expect(agents.notes).toHaveLength(1);
		expect(agents.notes[0]?.startsWith("ja:")).toBe(true);

		const spaces = storeRowCopy(
			row("spaces", {
				partialReasons: [
					{ code: "key-not-held" },
					{ code: "unreadable-values", count: 1 },
					{ code: "sealing-running", state: "sealing" },
					{ code: "files-unsealed", pending: "disk", sealed: 1, total: 3 },
				],
				status: "partial",
			}),
			ja
		);
		expect(spaces.notes).toHaveLength(4);
		expect(spaces.notes.every((note) => note.startsWith("ja:"))).toBe(true);
		expect(spaces.notes[3]).toContain("disk");

		const history = storeRowCopy(
			row("source-history", { reason: "low space", status: "plaintext" }),
			ja
		);
		expect(history.detail.startsWith("ja:")).toBe(true);
		expect(history.detail).toContain("low space");
	});

	test("keeps Core's English where this build cannot localize", () => {
		const unknown = storeRowCopy(row("future-store"), ja);
		expect(unknown.label).toBe("Core English label for future-store");
		expect(unknown.detail).toBe("Core English detail for future-store");

		// An older Core sends a partial row with no values.
		const olderSpaces = storeRowCopy(row("spaces", { status: "partial" }), ja);
		expect(olderSpaces.label.startsWith("ja:")).toBe(true);
		expect(olderSpaces.detail).toBe("Core English detail for spaces");
		const olderHistory = storeRowCopy(
			row("source-history", { status: "plaintext" }),
			ja
		);
		expect(olderHistory.detail).toBe("Core English detail for source-history");
		const badReason = storeRowCopy(
			row("spaces", { partialReasons: [{ code: "new" }], status: "partial" }),
			ja
		);
		expect(badReason.detail).toBe("Core English detail for spaces");
	});
});
