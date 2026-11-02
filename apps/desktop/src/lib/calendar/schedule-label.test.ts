import { afterEach, describe, expect, test } from "bun:test";
import { formatMessage, type MessageValuesInput } from "@ryu/i18n/core";
import type { LiteralMessage } from "@ryu/i18n/react";
// The provider registers its runtime here; a test registers a stand-in.
import {
	registerActiveI18nRuntime,
	unregisterActiveI18nRuntime,
} from "../../../../../packages/i18n/src/active-locale.ts";
import { describeSchedule } from "./events.ts";

const tl: LiteralMessage = (source, values) => formatMessage(source, values);

function runtimeFor(locale: string) {
	return {
		direction: locale === "ar" ? ("rtl" as const) : ("ltr" as const),
		locale,
		translate(id: string, values?: MessageValuesInput, fallback?: string) {
			return formatMessage(fallback ?? id, values, locale);
		},
	};
}

let mounted: ReturnType<typeof runtimeFor> | null = null;

function withLocale(locale: string): void {
	mounted = runtimeFor(locale);
	registerActiveI18nRuntime(mounted);
}

afterEach(() => {
	if (mounted) {
		unregisterActiveI18nRuntime(mounted);
		mounted = null;
	}
});

const DAILY_NINE = { kind: "cron", expr: "0 9 * * *" } as const;
const MONDAY_NINE = { kind: "cron", expr: "0 9 * * 1" } as const;

describe("describeSchedule follows the UI locale", () => {
	test("English keeps the familiar phrasing", () => {
		expect(describeSchedule(DAILY_NINE, tl)).toBe("Daily at 9 AM");
		expect(describeSchedule(MONDAY_NINE, tl)).toBe("Weekly on Monday at 9 AM");
		expect(describeSchedule({ kind: "cron", expr: "0 0 * * 0" }, tl)).toBe(
			"Weekly on Sunday at 12 AM"
		);
	});

	test("Japanese names the weekday and hour without AM/PM", () => {
		withLocale("ja");
		const label = describeSchedule(MONDAY_NINE, tl);
		expect(label).toContain("月曜日");
		expect(label).not.toContain("AM");
		expect(label).not.toContain("Monday");
		expect(describeSchedule(DAILY_NINE, tl)).not.toContain("AM");
	});

	test("German writes Montag and a 24-hour clock", () => {
		withLocale("de");
		const label = describeSchedule({ kind: "cron", expr: "0 15 * * 1" }, tl);
		expect(label).toContain("Montag");
		expect(label).toContain("15");
		expect(label).not.toContain("PM");
	});

	test("Arabic uses Arabic weekday names", () => {
		withLocale("ar");
		const label = describeSchedule(MONDAY_NINE, tl);
		expect(label).toContain("الاثنين");
		expect(label).not.toContain("Monday");
		expect(label).not.toContain("AM");
	});

	test("an out-of-range cron weekday keeps its raw digit", () => {
		withLocale("de");
		expect(describeSchedule({ kind: "cron", expr: "0 9 * * 7" }, tl)).toContain(
			"Weekly on 7 at"
		);
	});
});
