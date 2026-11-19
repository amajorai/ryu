// Labels for the outcome codes Core writes into the broker request log
// (`apps/core/src/vault/broker/proxy/`). The codes are for programs; the
// request log shows one translated phrase per row. Lower case, because the
// label sits mid-line in the row detail ("12:04 · github · forbidden · 8 ms").
// A code this table does not know is a refusal, so it reads "refused".

import type { LiteralMessage } from "@ryu/i18n/react";

export function brokerOutcomeLabel(code: string, tl: LiteralMessage): string {
	switch (code) {
		case "forwarded":
			return tl("forwarded");
		case "intercepted":
			return tl("inspected tunnel opened");
		case "tunneled":
			return tl("tunnel opened");
		case "rate_limited":
			return tl("rate limited");
		case "forbidden":
			return tl("forbidden");
		case "proxy_auth_required":
			return tl("proxy authentication required");
		case "credential_approval_required":
			return tl("credential approval required");
		case "card_approval_required":
			return tl("card approval required");
		case "oauth_connect_required":
			return tl("OAuth connection required");
		case "oauth_reconnect_required":
			return tl("OAuth reconnection required");
		case "absolute_form_required":
			return tl("full URL required");
		default:
			return tl("refused");
	}
}
