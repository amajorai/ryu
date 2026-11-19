// A checkbox column's filter values read through the keyed `dataGrid.checked`
// and `dataGrid.unchecked` (ja チェックあり, チェックなし). The bare catalog
// "Checked" and "Unchecked" are a check time and "not verified" (ja
// チェック日時, 未確認).
import { expect, test } from "bun:test";
import { I18nRuntime } from "@ryu/i18n/core";
import { collectFilterOptions } from "./data-grid-cell-text.ts";

const checkbox = { variant: "checkbox" } as const;

function labels(sense?: (id: string, fallback: string) => string): string[] {
	return collectFilterOptions([true, false, true], checkbox, sense).map(
		(option) => option.label
	);
}

test("Japanese checkbox filters read チェックあり and チェックなし", () => {
	const runtime = new I18nRuntime([], { initialPackId: "official/ja" });
	expect(
		labels((id, fallback) => runtime.translate(id, {}, fallback)).sort()
	).toEqual(["チェックあり", "チェックなし"]);
});

test("English keeps Checked and Unchecked", () => {
	expect(labels().sort()).toEqual(["Checked", "Unchecked"]);
});
