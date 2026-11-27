// apps/desktop/src/components/usage-rail/usage-rail-text.ts
//
// The words of the usage rings: the accessible name of a ring, the line of one
// limit window and why an account has no number. Kept apart from the
// components so the names can be tested as plain strings.

import { formatList } from "@ryu/i18n/lite";
import type { LiteralMessage } from "@ryu/i18n/react";
import type { UsageBarMode } from "@/src/hooks/useUsageBarPrefs.ts";
import { formatExpiryDate } from "@/src/lib/expiry.ts";
import {
	limitedAccounts,
	type RailAccount,
	type RailAccountState,
	type RailWindow,
	type UsageRailSource,
} from "@/src/lib/usage-rail/usage-rail-sources.ts";

/** The number a surface shows for a used percentage, what is used or what is left. */
export function shownPercent(usedPercent: number, mode: UsageBarMode): number {
	const used = Math.max(0, Math.min(100, usedPercent));
	return Math.round(mode === "remaining" ? 100 - used : used);
}

/** "5h: 88% left" or "5h: 12% used", one whole sentence per mode. */
export function windowLine(
	window: Pick<RailWindow, "label" | "usedPercent">,
	mode: UsageBarMode,
	tl: LiteralMessage
): string {
	const values = {
		label: window.label,
		percent: shownPercent(window.usedPercent, mode),
	};
	return mode === "remaining"
		? tl("{label}: {percent}% left", values)
		: tl("{label}: {percent}% used", values);
}

/** Why an account shows no number, in the words the picker already uses. */
export function accountStateText(
	state: RailAccountState,
	tl: LiteralMessage
): string {
	switch (state) {
		case "needs_reauth":
			return tl("needs a new sign-in");
		case "pool_disabled":
			return tl("off in account routing");
		case "unsupported":
			return tl("no usage reported");
		case "pending":
			return tl("checking…");
		case "unavailable":
			return tl("usage unavailable");
		default:
			return tl("no reading yet");
	}
}

/**
 * The words for a used-up account, so colour is never the only signal:
 * "Limited until Nov 26 at 5:30 PM", or a plain sentence with no reset time.
 */
export function limitedText(
	account: Pick<RailAccount, "limitedUntil">,
	tl: LiteralMessage
): string {
	return account.limitedUntil
		? tl("Limited until {time}", {
				time: formatExpiryDate(account.limitedUntil),
			})
		: tl("Limited, reset time unknown");
}

/** The account-wide windows of the one readable account of a source. */
function singleAccountWindows(source: UsageRailSource): RailWindow[] {
	const account = source.accounts.find((entry) => entry.leftPercent !== null);
	return account ? account.windows.filter((window) => !window.model) : [];
}

/**
 * The accessible name of a ring: the source, then each window's percent for a
 * source with one account, or the mean and the number of accounts for a pool,
 * then how many accounts are limited.
 */
export function ringLabel(
	source: UsageRailSource,
	mode: UsageBarMode,
	tl: LiteralMessage
): string {
	const details: string[] = [];
	if (source.readable === 1) {
		for (const window of singleAccountWindows(source)) {
			details.push(windowLine(window, mode, tl));
		}
	} else {
		const values = {
			count: source.readable,
			percent: shownPercent(100 - source.leftPercent, mode),
		};
		details.push(
			mode === "remaining"
				? tl(
						"{percent}% left on average across {count, plural, one {# account} other {# accounts}}",
						values
					)
				: tl(
						"{percent}% used on average across {count, plural, one {# account} other {# accounts}}",
						values
					)
		);
	}
	const limited = limitedAccounts(source).length;
	if (limited > 0) {
		details.push(
			tl(
				"{count, plural, one {# account limited} other {# accounts limited}}",
				{
					count: limited,
				}
			)
		);
	}
	return tl("Usage of {name}: {details}", {
		details: formatList(details),
		name: source.name,
	});
}

/**
 * The accessible name of the "+N" ring. It holds every source when the strip
 * has one place only, and the sources that did not fit otherwise.
 */
export function moreRingLabel(
	count: number,
	holdsAll: boolean,
	tl: LiteralMessage
): string {
	return holdsAll
		? tl("Usage of {count, plural, one {# source} other {# sources}}", {
				count,
			})
		: tl(
				"Usage of {count, plural, one {# more source} other {# more sources}}",
				{ count }
			);
}

/** What kind of source a card section shows, under its name. */
export function sourceKindText(
	source: Pick<UsageRailSource, "kind">,
	tl: LiteralMessage
): string {
	if (source.kind === "pool") {
		return tl("Account pool");
	}
	return source.kind === "agent"
		? tl("The agent's own sign-in")
		: tl("Accounts outside every pool");
}
