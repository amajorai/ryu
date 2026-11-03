// The product profiles carry their prices and counts as published English
// strings ("$0.025 per running hour", "10,000"), because the docs drift
// checks and profile grounding compare them verbatim. A page shown in another
// language must not print US grouping and a leading "$" inside a translated
// sentence, so this module rebuilds each priced value from the raw
// `PUBLISHED_PRICING` numbers for the reader's locale at render.
//
// Each builder below is the one place a priced profile value is produced for
// display. Run with the English translator and formatters it yields exactly
// the string the profile holds, which is how a row finds its localized
// replacement; the companion test fails when a priced row has no builder.

import { formatMessage } from "@ryu/i18n/core";
import type { LiteralMessage } from "@ryu/i18n/react";
import { PUBLISHED_PRICING } from "../data/standalone-pricing.ts";
import type { PublishedMailAllowance } from "../data/standalone-pricing-figures.ts";
import {
	type LocalizedLimitValues,
	localizedLimitValues,
} from "../data/standalone-pricing-limits.ts";
import {
	ENGLISH_PRICING_FORMAT,
	type PricingFormat,
	pricingFormat,
} from "../data/standalone-pricing-locale.ts";
import type { ProductLimits } from "./profile-types.ts";

/** What a builder formats with: the page translator, formatters and meters. */
interface ValueContext {
	readonly format: PricingFormat;
	readonly limits: LocalizedLimitValues;
	readonly tl: LiteralMessage;
}

type ValueBuilder = (context: ValueContext) => string;

const { box, mail, notify, passport } = PUBLISHED_PRICING;

const runningHour =
	(amount: number): ValueBuilder =>
	({ format, tl }) =>
		tl("{price} per running hour", { price: format.usdRate(amount) });

const mailAllowance =
	(allowance: PublishedMailAllowance): ValueBuilder =>
	({ format, tl }) =>
		tl("{emails} emails and {storageGib} GiB a month", {
			emails: format.count(allowance.monthlyEmails),
			storageGib: format.count(allowance.storageGib),
		});

/**
 * Every priced or counted value the profiles display, as the same whole
 * message the profile builds in English (see profiles-agent-api-*.ts).
 */
const PROFILE_VALUE_BUILDERS: readonly ValueBuilder[] = [
	// Box (profiles-agent-api-a-data.ts)
	runningHour(box.smallHourUsd),
	runningHour(box.defaultHourUsd),
	runningHour(box.largeHourUsd),
	({ limits }) => limits.boxMinimum,
	({ format, tl }) =>
		tl("{price} per GiB-month", {
			price: format.usd(box.storageGibMonthUsd, 2),
		}),
	({ format, tl }) =>
		tl(
			"Above the {includedGib} GiB a paid organization includes; {trialGib} GiB without a paid plan.",
			{
				includedGib: format.count(box.includedStorageGib.paid),
				trialGib: format.count(box.includedStorageGib.trial),
			}
		),
	// Passport (profiles-agent-api-a.ts)
	({ limits }) => limits.passportConnectionMonth,
	({ format, tl }) =>
		tl(
			"After {freeConnections} connection-months free each month, per organization.",
			{ freeConnections: format.count(passport.freeConnectionMonths) }
		),
	({ limits }) => limits.passportFetches,
	({ format, tl }) =>
		tl("After {freeFetches} fetches free each month, per organization.", {
			freeFetches: format.count(passport.freeFetchesPerMonth),
		}),
	// Notify (profiles-agent-api-a-notify.ts)
	({ limits }) => limits.notifyEvents,
	({ format, tl }) =>
		tl(
			"The first {freeEvents} events each calendar month are free. Replays and refused requests are not counted.",
			{ freeEvents: format.count(notify.freeEventsPerMonth) }
		),
	// Connect (profiles-agent-api-a-connect.ts)
	({ limits }) => limits.connectNativeCalls,
	// Mail (profiles-agent-api-b.ts)
	({ limits }) => limits.freeMailBaseline,
	mailAllowance(mail.pro),
	mailAllowance(mail.max),
	mailAllowance(mail.organization),
	({ limits }) => limits.mailOverageRecipients,
];

const englishLiteral: LiteralMessage = (source, values) =>
	formatMessage(source, values, "en");

const ENGLISH_CONTEXT: ValueContext = {
	format: ENGLISH_PRICING_FORMAT,
	limits: localizedLimitValues(),
	tl: englishLiteral,
};

/** The published English strings the builders produce, in builder order. */
export const ENGLISH_PROFILE_VALUES: readonly string[] =
	PROFILE_VALUE_BUILDERS.map((build) => build(ENGLISH_CONTEXT));

const ENGLISH_TAG = /^en(?:-|$)/iu;

/**
 * Maps a profile's published English value to the same value for `locale`.
 * Strings no builder produces (unpriced copy) come back unchanged, as does
 * everything under English or with no locale.
 */
export function profileValueLocalizer(
	tl: LiteralMessage,
	locale?: string | null
): (english: string) => string {
	if (!locale || ENGLISH_TAG.test(locale)) {
		return (english) => english;
	}
	const context: ValueContext = {
		format: pricingFormat(locale),
		limits: localizedLimitValues(tl, locale),
		tl,
	};
	const localized = new Map<string, string>();
	PROFILE_VALUE_BUILDERS.forEach((build, index) => {
		const english = ENGLISH_PROFILE_VALUES[index];
		if (english !== undefined && !localized.has(english)) {
			localized.set(english, build(context));
		}
	});
	return (english) => localized.get(english) ?? english;
}

/** A profile's limits table with its prices and counts in `locale`. */
export function localizeProfileLimits(
	limits: ProductLimits,
	tl: LiteralMessage,
	locale?: string | null
): ProductLimits {
	const localize = profileValueLocalizer(tl, locale);
	return {
		...limits,
		rows: limits.rows.map((row) => ({
			...row,
			value: localize(row.value),
			...(row.note === undefined ? {} : { note: localize(row.note) }),
		})),
	};
}
