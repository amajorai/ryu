import { expect, test } from "bun:test";
import type { LiteralMessage } from "@ryu/i18n/react";
import { recordRangeLabel } from "./record-range-label.ts";

test("the page range is one catalogued sentence with formatted numbers", () => {
	const tl: LiteralMessage = (source, values) =>
		`[${source}]${values ? JSON.stringify(values) : ""}`;
	expect(recordRangeLabel(50, 50, 1200, tl)).toBe(
		'[{start}–{end} of {total}]{"end":"100","start":"51","total":"1,200"}'
	);
});
