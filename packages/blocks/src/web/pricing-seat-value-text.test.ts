import { afterEach, describe, expect, test } from "bun:test";
import {
	formatMessage,
	I18nRuntime,
	messageIdForLiteral,
} from "@ryu/i18n/core";
import {
	type LiteralCatalog,
	registerLiteralCatalogLoader,
} from "@ryu/i18n/lite";
import type { LiteralMessage } from "@ryu/i18n/react";
import { TEAMS_MAX_SEATS } from "./pricing-seat-model.ts";
import { organizationSeatValueText } from "./pricing-seat-value-text.ts";

const SEATS = "{count, plural, one {# seat} other {# seats}}";
const ENTERPRISE = "{minimum}+ seats";

const GERMAN: LiteralCatalog = {
	[SEATS]: "{count, plural, one {# Platz} other {# Plätze}}",
	[ENTERPRISE]: "{minimum}+ Plätze",
	"{plan} seats": "{plan}-Plätze",
};

const english: LiteralMessage = (source, values) =>
	formatMessage(source, values ?? {}, "en");

async function germanMessages(): Promise<LiteralMessage> {
	registerLiteralCatalogLoader((locale) =>
		locale.startsWith("de") ? GERMAN : null
	);
	const runtime = new I18nRuntime([], {
		initialLocale: "de",
		initialPackId: null,
	});
	runtime.overlayMessage(messageIdForLiteral(SEATS));
	await Promise.resolve();
	return (source, values) =>
		runtime.translate(messageIdForLiteral(source), values ?? {}, source);
}

afterEach(() => {
	registerLiteralCatalogLoader(null);
});

describe("organization seat value text", () => {
	test("English keeps the plural and the Enterprise step", () => {
		expect(organizationSeatValueText(english, 12)).toBe("12 seats");
		expect(organizationSeatValueText(english, TEAMS_MAX_SEATS + 1)).toBe(
			`${TEAMS_MAX_SEATS + 1}+ seats`
		);
	});

	test("German reads the locale's plural, not the '{plan} seats' template", async () => {
		const tl = await germanMessages();
		expect(organizationSeatValueText(tl, 12)).toBe("12 Plätze");
		expect(organizationSeatValueText(tl, 1)).toBe("1 Platz");
		expect(organizationSeatValueText(tl, TEAMS_MAX_SEATS + 1)).toBe(
			`${TEAMS_MAX_SEATS + 1}+ Plätze`
		);
		expect(organizationSeatValueText(tl, 12)).not.toContain("-Plätze");
	});
});
