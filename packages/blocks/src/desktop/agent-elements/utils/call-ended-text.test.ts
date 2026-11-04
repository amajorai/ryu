import { expect, test } from "bun:test";
import { formatMessage } from "@ryu/i18n/lite";
import {
	type CallEndedTranslate,
	callEndedText,
	formatCallClock,
	parseCallEnded,
} from "./call-ended-text.ts";

const SOURCE = "Call ended · {duration}";

/** A stand-in catalog with the Japanese and Arabic wording of the row. */
const catalog =
	(locale: string, wording: string): CallEndedTranslate =>
	(source, values) =>
		formatMessage(source === SOURCE ? wording : source, values, locale);

test("parses the stored English row Core writes", () => {
	expect(parseCallEnded("Call ended · 03:07")).toEqual({ seconds: 187 });
	expect(parseCallEnded("Call ended · 125:00")).toEqual({ seconds: 7500 });
});

test("ignores text that only resembles the row", () => {
	expect(parseCallEnded("Call ended")).toBeNull();
	expect(parseCallEnded("Call ended · 3:07")).toBeNull();
	expect(parseCallEnded("Call ended · 03:60")).toBeNull();
	expect(parseCallEnded("The call ended · 03:07")).toBeNull();
	expect(callEndedText("hello", catalog("ja", "通話終了 · {duration}"))).toBe(
		null
	);
});

test("renders the row in Japanese", () => {
	expect(
		callEndedText(
			"Call ended · 03:07",
			catalog("ja", "通話終了 · {duration}"),
			"ja"
		)
	).toBe("通話終了 · 03:07");
});

test("uses the locale's digits for the call length", () => {
	expect(formatCallClock(187, "ar-EG")).toBe("٠٣:٠٧");
	expect(
		callEndedText(
			"Call ended · 03:07",
			catalog("ar-EG", "انتهت المكالمة · {duration}"),
			"ar-EG"
		)
	).toBe("انتهت المكالمة · ٠٣:٠٧");
});

test("English keeps the stored text", () => {
	expect(callEndedText("Call ended · 03:07", undefined, "en")).toBe(
		"Call ended · 03:07"
	);
	expect(formatCallClock(7500, "en")).toBe("125:00");
});
