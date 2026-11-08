// Row summaries for the Vault broker panel. Each fragment is one whole
// translated message (`at {host}`, `field {field}`, `expires {date}`) before
// the fragments are joined with the visual " · " separator, so no English
// connective word is left around a localized value.

import type { LiteralMessage } from "@ryu/i18n/react";
import type { VaultCardApproval } from "@/src/lib/api/vault-cards.ts";
import { formatDateTime } from "@/src/lib/timezone.ts";

const SEPARATOR = " · ";

/** A date-time label, or the raw value when it is not a date. */
export function whenLabel(value: string): string {
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? value : formatDateTime(value);
}

/** "expires {date}" for an expiry timestamp. */
export function expiresLabel(value: string, tl: LiteralMessage): string {
	return tl("expires {date}", { date: whenLabel(value) });
}

function cardChannelLabel(
	channel: VaultCardApproval["channel"],
	tl: LiteralMessage
): string {
	switch (channel) {
		case "broker":
			return tl("agent request");
		case "fill":
			return tl("fill");
		case "reveal":
			return tl("reveal");
		default:
			return channel;
	}
}

function cardLabel(approval: VaultCardApproval, tl: LiteralMessage): string {
	const brand = approval.brand ?? tl("card");
	return approval.last4 ? `${brand} •••• ${approval.last4}` : brand;
}

/** The one-line description of a pending card spend approval. */
export function cardApprovalSummary(
	approval: VaultCardApproval,
	tl: LiteralMessage
): string {
	return [
		cardLabel(approval, tl),
		approval.merchantHost && tl("at {host}", { host: approval.merchantHost }),
		cardChannelLabel(approval.channel, tl),
		approval.field && tl("field {field}", { field: approval.field }),
		approval.requester,
		expiresLabel(approval.requestExpiresAt, tl),
	]
		.filter(Boolean)
		.join(SEPARATOR);
}

/** The proposal row's detail line: summary, requester and expiry. */
export function proposalDetail(
	summary: string,
	requestedBy: string | undefined,
	expiresAt: string,
	tl: LiteralMessage
): string {
	return [summary, requestedBy, expiresLabel(expiresAt, tl)]
		.filter(Boolean)
		.join(SEPARATOR);
}
