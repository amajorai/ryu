import { expect, test } from "bun:test";
import { formatMessage } from "@ryu/i18n/core";
import {
	formatRemainingDuration,
	formatSupportAccessRemaining,
} from "./support-access-banner-remaining.ts";

const HOUR = 3_600_000;
const NOW = 1_000_000_000_000;
const english = (message: string, values?: unknown) =>
	formatMessage(message, values);

// A German stub catalog: each clause is its own message, so a translator sees
// "expires in {duration}" whole instead of an English fragment spliced in.
const GERMAN: Record<string, string> = {
	"Support can read redacted diagnostics over the mesh; {remaining}.":
		"Der Support kann über das Mesh geschwärzte Diagnosedaten lesen; {remaining}.",
	"expires in {duration}": "läuft in {duration} ab",
	expiring: "läuft ab",
	"no expiry set": "kein Ablauf festgelegt",
};
const german = (message: string, values?: unknown) =>
	formatMessage(GERMAN[message] ?? message, values);

test("English keeps the banner's 'expires in 1 h 30 min' wording", () => {
	expect(
		formatSupportAccessRemaining(NOW + 1.5 * HOUR, NOW, english, "en")
	).toBe("expires in 1 h 30 min");
	expect(formatSupportAccessRemaining(NOW + 2 * HOUR, NOW, english, "en")).toBe(
		"expires in 2 h"
	);
	expect(formatSupportAccessRemaining(NOW + 90_000, NOW, english, "en")).toBe(
		"expires in 1 min"
	);
	expect(formatSupportAccessRemaining(0, NOW, english, "en")).toBe(
		"no expiry set"
	);
	expect(formatSupportAccessRemaining(NOW - 1, NOW, english, "en")).toBe(
		"expiring"
	);
});

test("the German banner sentence has no English fragment", () => {
	const remaining = formatSupportAccessRemaining(
		NOW + 1.5 * HOUR,
		NOW,
		german,
		"de"
	);
	const sentence = german(
		"Support can read redacted diagnostics over the mesh; {remaining}.",
		{ remaining }
	);
	expect(sentence).toBe(
		"Der Support kann über das Mesh geschwärzte Diagnosedaten lesen; läuft in 1 Std. 30 Min. ab."
	);
	expect(sentence).not.toMatch(/expires|min\b| h /u);
	expect(formatSupportAccessRemaining(0, NOW, german, "de")).toBe(
		"kein Ablauf festgelegt"
	);
});

test("Japanese and Arabic durations carry no English unit letters", () => {
	expect(formatRemainingDuration(1, 30, "ja")).toBe("1時間 30分");
	const arabic = formatRemainingDuration(1, 30, "ar");
	expect(arabic).not.toMatch(/[a-z]/u);
	expect(arabic).toContain(new Intl.NumberFormat("ar").format(30));
});
