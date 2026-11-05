// Reader-facing labels for protocol ids that settings rows show inside
// translated sentences: support-access scope ids ("billing", "sync-status"),
// support-session end reasons ("stopped", "revoked", "expired") and OAuth
// application types ("native", "web"). Every label is a literal tl() call so
// the extractor sees it. An unknown end reason or application type falls back
// to a generic label; an unknown scope id (a newer server) is shown as is.

import { formatList } from "@ryu/i18n/lite";
import type { LiteralMessage } from "@ryu/i18n/react";

type Translate = LiteralMessage;

/** The label of one support-access scope id, or the id when it is unknown. */
export function supportScopeLabel(tl: Translate, scope: string): string {
	switch (scope) {
		case "billing":
			return tl("Billing");
		case "subscription":
			return tl("Subscription");
		case "organization":
			return tl("Organization");
		case "sync-status":
			return tl("Sync status");
		case "channels":
			return tl("Channels");
		case "marketplace":
			return tl("Marketplace");
		default:
			return scope;
	}
}

/**
 * The granted scopes as one list in the reader's language ("Billing and
 * Sync status", "請求、同期状況"), or "none" when the grant has no scopes.
 */
export function supportScopeList(
	tl: Translate,
	scopes: readonly string[],
	locale: string | null | undefined
): string {
	if (scopes.length === 0) {
		return tl("none");
	}
	return formatList(
		scopes.map((scope) => supportScopeLabel(tl, scope)),
		"conjunction",
		locale
	);
}

/** Why a support session ended, as a short status label. */
export function supportSessionEndLabel(
	tl: Translate,
	reason: string | null | undefined
): string {
	switch (reason) {
		case "stopped":
			return tl("Stopped");
		case "revoked":
			return tl("Revoked");
		case "expired":
			return tl("Expired");
		default:
			return tl("Ended");
	}
}

/** An OAuth client's application type ("native" or "web") as a label. */
export function oauthApplicationTypeLabel(
	tl: Translate,
	applicationType: string | null | undefined
): string {
	return applicationType === "native" ? tl("Native app") : tl("Web app");
}
