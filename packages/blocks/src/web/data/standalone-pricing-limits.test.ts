import { describe, expect, it } from "bun:test";
import { formatMessage } from "@ryu/i18n/core";
import type { LiteralMessage } from "@ryu/i18n/react";
import {
	ENGLISH_LIMIT_VALUES,
	formatMailAllowance,
	localizedLimitValues,
	PRICING_COPY,
	PUBLISHED_PRICING,
} from "./standalone-pricing.ts";

/** Intl separates a figure from its unit with a (narrow) no-break space. */
const plain = (text: string) => text.replace(/[\u00a0\u202f]/gu, " ");

/** A German catalog for the meter messages, formatted the way `tl` does. */
const DE: Record<string, string> = {
	"{count}-minute minimum": "Mindestens {count} Minuten",
	"{price} per connection-month": "{price} pro Verbindungsmonat",
	"{price} per {count} events": "{price} pro {count} Ereignisse",
	"{price} per {count} fetches": "{price} pro {count} Abrufe",
	"{price} per {count} recipients": "{price} pro {count} Empfänger",
	"{price} per {count} calls": "{price} pro {count} Aufrufe",
	"{inboxes, plural, one {# inbox} other {# inboxes}}, {emails} emails per month, and {storageGib} GiB of stored mail":
		"{inboxes, plural, one {# Postfach} other {# Postfächer}}, {emails} E-Mails pro Monat und {storageGib} GiB gespeicherte Mail",
	"{emails} emails and {storageGib} GiB":
		"{emails} E-Mails und {storageGib} GiB",
};

const germanTl: LiteralMessage = (source, values) =>
	formatMessage(DE[source] ?? source, values, "de");

describe("localizedLimitValues", () => {
	it("keeps the published English copy by default", () => {
		const english = localizedLimitValues();
		expect(english.boxMinimum).toBe(PRICING_COPY.boxMinimum);
		expect(english.connectNativeCalls).toBe(PRICING_COPY.connectNativeCalls);
		expect(english.freeMailBaseline).toBe(PRICING_COPY.freeMailBaseline);
		expect(english.mailOverageRecipients).toBe(
			PRICING_COPY.mailOverageRecipients
		);
		expect(english.notifyEvents).toBe(PRICING_COPY.notifyEvents);
		expect(english.passportConnectionMonth).toBe(
			PRICING_COPY.passportConnectionMonth
		);
		expect(english.passportFetches).toBe(PRICING_COPY.passportFetches);
		expect(english.mailAllowance(PUBLISHED_PRICING.mail.pro)).toBe(
			formatMailAllowance(PUBLISHED_PRICING.mail.pro)
		);
		expect(ENGLISH_LIMIT_VALUES.notifyEvents).toBe(PRICING_COPY.notifyEvents);
	});

	it("translates each value as one message with German figures", () => {
		const de = localizedLimitValues(germanTl, "de");
		expect(plain(de.passportConnectionMonth)).toBe(
			"0,10 $ pro Verbindungsmonat"
		);
		expect(plain(de.notifyEvents)).toMatch(
			/^\d+,\d{2} \$ pro 1\.000 Ereignisse$/u
		);
		expect(plain(de.passportFetches)).toContain("pro 1.000 Abrufe");
		expect(de.boxMinimum).toBe(
			`Mindestens ${PUBLISHED_PRICING.box.minimumMinutesPerStart} Minuten`
		);
		expect(de.freeMailBaseline).toContain("1 Postfach,");
		expect(de.freeMailBaseline).not.toContain("emails per month");
		expect(de.mailAllowance(PUBLISHED_PRICING.mail.organization)).toBe(
			"100.000 E-Mails und 20 GiB"
		);
		expect(plain(de.format.price(2500))).toBe("2.500 $");
		for (const value of [
			de.connectNativeCalls,
			de.mailOverageRecipients,
			de.notifyEvents,
			de.passportFetches,
		]) {
			expect(value).not.toContain("1,000");
			expect(value).not.toMatch(/ per /u);
		}
	});
});
