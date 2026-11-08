import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { formatMessage, type LiteralMessage } from "@ryu/i18n";
import type { StoreCoverage } from "@/src/lib/api/encryption.ts";
import {
	ENCRYPTION_STORE_COPY,
	storeRowCopy,
} from "./encryption-store-copy.ts";

// The copy rendered through the real ICU formatter: English must equal what
// Core sends, and translated catalogs (ja, ar, de) must format every runtime
// value, plural forms included, with no English left in the row.

const CORE_STORES = readFileSync(
	fileURLToPath(
		new URL("../../../../core/src/server/encryption/stores.rs", import.meta.url)
	),
	"utf8"
);

const english: LiteralMessage = (source, values) =>
	formatMessage(source, values, "en");

function catalog(
	locale: string,
	entries: Record<string, string>
): LiteralMessage {
	return (source, values) => {
		const translated = entries[source] ?? `[${locale}] ${source}`;
		return formatMessage(translated, values, locale);
	};
}

function row(id: string, extra: Record<string, unknown> = {}): StoreCoverage {
	return {
		detail: "",
		id,
		label: "",
		sealed: null,
		status: "sealed",
		total: null,
		...extra,
	} as StoreCoverage;
}

const ROWS_PLURAL =
	"{count, plural, one {{countText} row did not open under the current key and is skipped.} other {{countText} rows did not open under the current key and are skipped.}}";
const VALUES_PLURAL =
	"{count, plural, one {Not complete yet: {countText} value did not open and is skipped.} other {Not complete yet: {countText} values did not open and are skipped.}}";
const FILES =
	"Not complete yet: {sealed} of {total} uploaded files are sealed ({reason}).";
const HISTORY =
	"Saved versions of agents, workflows, skills and Space sources are still in the unencrypted history an earlier version kept ({reason}). Ryu retries the import at each start.";

describe("encryption store copy through the ICU formatter", () => {
	test("English labels and details are Core's English, unchanged", () => {
		for (const id of Object.keys(ENCRYPTION_STORE_COPY)) {
			const copy = storeRowCopy(row(id, { unreadableCount: 0 }), english);
			expect(CORE_STORES).toContain(`"${copy.label}"`);
			expect(
				CORE_STORES.replaceAll('\\"', '"').includes(`"${copy.detail}"`)
			).toBe(true);
		}
		const history = storeRowCopy(
			row("source-history", { reason: "disk full", status: "plaintext" }),
			english
		);
		expect(history.detail).toBe(
			"Saved versions of agents, workflows, skills and Space sources are still in the unencrypted history an earlier version kept (disk full). Ryu retries the import at each start."
		);
	});

	test("English plurals pick one and other", () => {
		const one = storeRowCopy(
			row("agents", { status: "partial", unreadableCount: 1 }),
			english
		);
		expect(one.notes).toEqual([
			"1 row did not open under the current key and is skipped.",
		]);
		const many = storeRowCopy(
			row("agents", { status: "partial", unreadableCount: 1200 }),
			english
		);
		expect(many.notes).toEqual([
			"1,200 rows did not open under the current key and are skipped.",
		]);
		const spaces = storeRowCopy(
			row("spaces", {
				partialReasons: [
					{ code: "unreadable-values", count: 2 },
					{ code: "files-unsealed", pending: "disk full", sealed: 1, total: 3 },
				],
				status: "partial",
			}),
			english
		);
		expect(spaces.notes).toEqual([
			"Not complete yet: 2 values did not open and are skipped.",
			"Not complete yet: 1 of 3 uploaded files are sealed (disk full).",
		]);
	});

	test("ja, ar and de catalogs format every runtime value", () => {
		const cases = [
			{
				locale: "ja",
				entries: {
					[ROWS_PLURAL]:
						"{count, plural, other {{countText} 行は現在のキーで開けなかったため、スキップされます。}}",
					[VALUES_PLURAL]:
						"{count, plural, other {未完了: {countText} 個の値を開けなかったため、スキップされます。}}",
					[FILES]:
						"未完了: アップロードされた {total} 個のファイルのうち {sealed} 個が封印済みです ({reason})。",
					[HISTORY]:
						"エージェント、ワークフロー、スキル、スペースの保存済みバージョンは、以前のバージョンが残した暗号化されていない履歴にまだあります ({reason})。Ryu は起動するたびにインポートを再試行します。",
				},
				rows: "3 行は現在のキーで開けなかったため",
			},
			{
				locale: "ar",
				entries: {
					[ROWS_PLURAL]:
						"{count, plural, zero {لا صفوف} one {صف واحد لم يُفتح} two {صفان لم يُفتحا} few {{countText} صفوف لم تُفتح} many {{countText} صفًا لم يُفتح} other {{countText} صف لم يُفتح}}",
					[VALUES_PLURAL]:
						"{count, plural, one {لم يكتمل بعد: قيمة واحدة لم تُفتح.} other {لم يكتمل بعد: {countText} قيم لم تُفتح.}}",
					[FILES]:
						"لم يكتمل بعد: {sealed} من {total} ملفات مرفوعة مختومة ({reason}).",
					[HISTORY]:
						"الإصدارات المحفوظة لا تزال في السجل غير المشفّر ({reason}). يعيد Ryu المحاولة عند كل تشغيل.",
				},
				rows: "صفوف لم تُفتح",
			},
			{
				locale: "de",
				entries: {
					[ROWS_PLURAL]:
						"{count, plural, one {{countText} Zeile ließ sich nicht öffnen und wird übersprungen.} other {{countText} Zeilen ließen sich nicht öffnen und werden übersprungen.}}",
					[VALUES_PLURAL]:
						"{count, plural, one {Noch nicht fertig: {countText} Wert ließ sich nicht öffnen.} other {Noch nicht fertig: {countText} Werte ließen sich nicht öffnen.}}",
					[FILES]:
						"Noch nicht fertig: {sealed} von {total} hochgeladenen Dateien sind versiegelt ({reason}).",
					[HISTORY]:
						"Gespeicherte Versionen liegen noch im unverschlüsselten Verlauf ({reason}). Ryu versucht den Import bei jedem Start erneut.",
				},
				rows: "3 Zeilen ließen sich nicht öffnen",
			},
		];
		for (const { locale, entries, rows } of cases) {
			const tl = catalog(locale, entries);
			const agents = storeRowCopy(
				row("agents", { status: "partial", unreadableCount: 3 }),
				tl
			);
			expect(agents.notes[0]).toContain(rows);
			const spaces = storeRowCopy(
				row("spaces", {
					partialReasons: [
						{ code: "unreadable-values", count: 5 },
						{ code: "files-unsealed", pending: "ENOSPC", sealed: 1, total: 3 },
					],
					status: "partial",
				}),
				tl
			);
			expect(spaces.notes).toHaveLength(2);
			expect(spaces.notes[1]).toContain("ENOSPC");
			const history = storeRowCopy(
				row("source-history", { reason: "ENOSPC", status: "plaintext" }),
				tl
			);
			// Arabic isolates the Latin reason (FSI ... PDI); strip the marks here.
			expect(history.detail.replace(/[\u2066-\u2069]/gu, "")).toContain(
				"(ENOSPC)"
			);
			for (const text of [...agents.notes, ...spaces.notes, history.detail]) {
				expect(text).not.toMatch(/did not open|uploaded files|\{/);
			}
		}
	});
});
