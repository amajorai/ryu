import { afterEach, describe, expect, test } from "bun:test";
import { formatMessage, type MessageValuesInput } from "@ryu/i18n/core";
import { StepUpRequestError } from "@ryu/step-up";
// The provider registers its runtime here; the test registers a stand-in.
import {
	registerActiveI18nRuntime,
	unregisterActiveI18nRuntime,
} from "../../../i18n/src/active-locale.ts";
import { stepUpEmailWaitLine } from "./step-up-email-wait.ts";

const SECONDS =
	"Please wait {count, plural, one {# second} other {# seconds}} before requesting another email.";
const DE: Record<string, string> = {
	[SECONDS]:
		"Bitte warten Sie {count, plural, one {# Sekunde} other {# Sekunden}}, bevor Sie eine weitere E-Mail anfordern.",
};
const runtime = {
	direction: "ltr" as const,
	locale: "de",
	translate(source: string, values?: MessageValuesInput, fallback?: string) {
		const message = (fallback && DE[fallback]) ?? fallback ?? source;
		return formatMessage(message, values, "de");
	},
};

afterEach(() => {
	unregisterActiveI18nRuntime(runtime);
});

const cooldown = (retryAfter?: number) =>
	new StepUpRequestError(
		"Please wait 40 seconds before requesting another email.",
		429,
		retryAfter
	);

describe("stepUpEmailWaitLine", () => {
	test("says a wait in seconds, with the plural for one and for many", () => {
		expect(stepUpEmailWaitLine(cooldown(1))).toBe(
			"Please wait 1 second before requesting another email."
		);
		expect(stepUpEmailWaitLine(cooldown(45))).toBe(
			"Please wait 45 seconds before requesting another email."
		);
	});

	test("says a longer wait in minutes", () => {
		expect(stepUpEmailWaitLine(cooldown(91))).toBe(
			"Please wait 2 minutes before requesting another email."
		);
		expect(stepUpEmailWaitLine(cooldown(60 * 60))).toBe(
			"Please wait 60 minutes before requesting another email."
		);
	});

	test("says a daily cap in hours", () => {
		expect(stepUpEmailWaitLine(cooldown(3 * 3600))).toBe(
			"Please wait 3 hours before requesting another email."
		);
		expect(stepUpEmailWaitLine(cooldown(91 * 60))).toBe(
			"Please wait 2 hours before requesting another email."
		);
	});

	test("says the wait in the reader's language from the catalogued ICU message", () => {
		registerActiveI18nRuntime(runtime);
		expect(stepUpEmailWaitLine(cooldown(1))).toBe(
			"Bitte warten Sie 1 Sekunde, bevor Sie eine weitere E-Mail anfordern."
		);
		expect(stepUpEmailWaitLine(cooldown(40))).toBe(
			"Bitte warten Sie 40 Sekunden, bevor Sie eine weitere E-Mail anfordern."
		);
	});

	test("keeps the server's sentence for a cooldown without a number, and is null for any other refusal", () => {
		expect(
			stepUpEmailWaitLine(
				new StepUpRequestError(
					"Please wait a moment before requesting another email.",
					429
				)
			)
		).toBe("Please wait a moment before requesting another email.");
		expect(
			stepUpEmailWaitLine(new StepUpRequestError("Internal Server Error", 500))
		).toBeNull();
		expect(stepUpEmailWaitLine(new Error("offline"))).toBeNull();
	});
});
