import { expect, test } from "bun:test";
import { formatMessage, type MessageValuesInput } from "@ryu/i18n/core";
import { acpBreakdownRows } from "./message-stats.tsx";

// The ACP hover card's row labels are catalog copy: "First response" and
// "Session total" go through the translator like the values beside them.
const JA: Record<string, string> = {
	"First response": "最初の応答",
	"Session total": "セッション合計",
};

function japanese(source: string, values: MessageValuesInput = {}): string {
	return formatMessage(JA[source] ?? source, values, "ja");
}

test("the first-response and session-total rows are labelled in Japanese", () => {
	const rows = acpBreakdownRows(
		{ done: true, sessionTotalTokens: 1200, ttftMs: 340 },
		japanese
	);
	const labels = rows.map((row) => row.label);
	expect(labels).toContain("最初の応答");
	expect(labels).toContain("セッション合計");
	expect(labels).not.toContain("First response");
	expect(labels).not.toContain("Session total");
});

test("rows the turn did not report stay out of the card", () => {
	const rows = acpBreakdownRows({ done: true, ttftMs: 340 }, japanese);
	expect(rows.map((row) => row.label)).toEqual(["最初の応答"]);
});
