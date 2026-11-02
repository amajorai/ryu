import { afterEach, describe, expect, test } from "bun:test";
import type { LiteralMessage } from "@ryu/i18n";
import { formatMessage, type MessageValuesInput } from "@ryu/i18n/core";
// The provider registers its runtime here; a test registers a stand-in.
import {
	registerActiveI18nRuntime,
	unregisterActiveI18nRuntime,
} from "../../../i18n/src/active-locale.ts";
import {
	formatUsageReset,
	usageMeterDetail,
	usageWindowDetail,
} from "./monitors-usage-format.ts";

const tl: LiteralMessage = (source, values) =>
	formatMessage(source, values ?? {});

const german = {
	direction: "ltr" as const,
	locale: "de",
	translate(id: string, values?: MessageValuesInput, fallback?: string) {
		return formatMessage(fallback ?? id, values, "de");
	},
};

const IN_THREE_HOURS = new Date(Date.now() + 3 * 3_600_000 + 60_000);

afterEach(() => {
	unregisterActiveI18nRuntime(german);
});

describe("provider usage readouts", () => {
	test("reads a window's share and reset in English", () => {
		expect(usageWindowDetail(42.5, null, tl)).toBe("42.5% used");
		expect(usageWindowDetail(42.5, IN_THREE_HOURS.toISOString(), tl)).toBe(
			"42.5% used · resets in 3 hours"
		);
		expect(usageMeterDetail(1.234, "tokens", null, tl)).toBe("1.23 tokens");
	});

	test("never shows a raw ISO timestamp, and keeps an unparseable one", () => {
		expect(usageWindowDetail(10, IN_THREE_HOURS.toISOString(), tl)).not.toMatch(
			/\dT\d/u
		);
		expect(formatUsageReset("soon")).toBe("soon");
	});

	test("uses a decimal comma and German relative time under de", () => {
		registerActiveI18nRuntime(german);
		expect(usageWindowDetail(42.5, null, tl)).toMatch(/^42,5\s?% used$/u);
		expect(formatUsageReset(IN_THREE_HOURS.toISOString())).toBe("in 3 Stunden");
		expect(usageMeterDetail(1.234, "tokens", null, tl)).toBe("1,23 tokens");
	});
});
