import { describe, expect, test } from "bun:test";
import { formatMessage } from "@ryu/i18n/core";
import type { LiteralMessage } from "@ryu/i18n/react";
import { inboxTrayStatus } from "./InboxCenter-labels.ts";

const RUSSIAN: Record<string, string> = {
	"{count, plural, one {# flagged risky} other {# flagged risky}}":
		"{count, plural, one {# элемент помечен как рискованный} few {# элемента помечены как рискованные} many {# элементов помечены как рискованные} other {# элемента помечены как рискованные}}",
	"{count, plural, one {# new} other {# new}}":
		"{count, plural, one {# новый} few {# новых} many {# новых} other {# новых}}",
};
const tl: LiteralMessage = (source, values) =>
	formatMessage(RUSSIAN[source] ?? source, values, "ru");
const english: LiteralMessage = (source, values) =>
	formatMessage(source, values, "en");

describe("inboxTrayStatus", () => {
	test("counts risky and new rows through plural messages", () => {
		expect(inboxTrayStatus(3, 0, 5, tl)).toBe(
			"3 элемента помечены как рискованные"
		);
		expect(inboxTrayStatus(0, 0, 5, tl)).toBe("5 новых");
		expect(inboxTrayStatus(1, 0, 1, english)).toBe("1 flagged risky");
		expect(inboxTrayStatus(0, 0, 2, english)).toBe("2 new");
	});

	test("prefers the decision line and stays empty with nothing new", () => {
		expect(inboxTrayStatus(0, 2, 5, english)).toBe("Waiting on you");
		expect(inboxTrayStatus(0, 0, 0, english)).toBeUndefined();
	});
});
