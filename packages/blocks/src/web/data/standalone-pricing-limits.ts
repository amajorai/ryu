// Published meter values ("$0.10 per connection-month", "5-minute minimum")
// as whole catalog messages, with every figure formatted for the reader's
// locale. `PRICING_COPY` keeps the same values in English for the docs drift
// tests and SEO metadata; this factory is what pages display, so the unit
// phrase and the figures inside it read in one language ("0,10 $ pro
// Verbindungsmonat" rather than "$0.10 per connection-month").

import { formatMessage } from "@ryu/i18n/core";
import type { LiteralMessage } from "@ryu/i18n/react";
import {
	PUBLISHED_PRICING,
	type PublishedMailAllowance,
} from "./standalone-pricing-figures.ts";
import {
	type PricingFormat,
	pricingFormat,
} from "./standalone-pricing-locale.ts";

/** The block size the per-thousand meters are priced in. */
const PER_THOUSAND = 1000;

/** The displayed meter values, one whole message each. */
export interface LocalizedLimitValues {
	readonly boxMinimum: string;
	readonly connectNativeCalls: string;
	/** The formatters the values were built with, for notes beside them. */
	readonly format: PricingFormat;
	readonly freeMailBaseline: string;
	/** "5,000 emails and 10 GiB" for a hosted-mail allowance. */
	mailAllowance(allowance: PublishedMailAllowance): string;
	readonly mailOverageRecipients: string;
	readonly notifyEvents: string;
	readonly passportConnectionMonth: string;
	readonly passportFetches: string;
}

const englishLiteral: LiteralMessage = (source, values) =>
	formatMessage(source, values, "en");

/**
 * The meter values for `locale`, each passed through `tl` as one message.
 * With no arguments it returns the published English copy, which equals the
 * matching `PRICING_COPY` entries.
 */
export function localizedLimitValues(
	tl: LiteralMessage = englishLiteral,
	locale?: string | null
): LocalizedLimitValues {
	const format = pricingFormat(locale);
	const { box, connect, mail, mailOverage, notify, passport } =
		PUBLISHED_PRICING;
	const thousand = format.count(PER_THOUSAND);
	return {
		format,
		boxMinimum: tl("{count}-minute minimum", {
			count: format.count(box.minimumMinutesPerStart),
		}),
		connectNativeCalls: tl("{price} per {count} calls", {
			price: format.usd(connect.nativeCallsPer1000Usd, 2),
			count: thousand,
		}),
		freeMailBaseline: tl(
			"{inboxes, plural, one {# inbox} other {# inboxes}}, {emails} emails per month, and {storageGib} GiB of stored mail",
			{
				inboxes: mail.free.inboxes,
				emails: format.count(mail.free.monthlyEmails),
				storageGib: format.count(mail.free.storageGib),
			}
		),
		mailAllowance: (allowance) =>
			tl("{emails} emails and {storageGib} GiB", {
				emails: format.count(allowance.monthlyEmails),
				storageGib: format.count(allowance.storageGib),
			}),
		mailOverageRecipients: tl("{price} per {count} recipients", {
			price: format.usd(mailOverage.recipientsPer1000Usd, 2),
			count: thousand,
		}),
		notifyEvents: tl("{price} per {count} events", {
			price: format.usd(notify.eventsPer1000Usd, 2),
			count: thousand,
		}),
		passportConnectionMonth: tl("{price} per connection-month", {
			price: format.usd(passport.connectionMonthUsd, 2),
		}),
		passportFetches: tl("{price} per {count} fetches", {
			price: format.usd(passport.fetchesPer1000Usd, 2),
			count: thousand,
		}),
	};
}

/** The published English meter values the product profiles show. */
export const ENGLISH_LIMIT_VALUES: LocalizedLimitValues =
	localizedLimitValues();
