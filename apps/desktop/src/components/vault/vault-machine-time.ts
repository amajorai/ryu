// Expiry and use-count text for machine credentials. Core sends times as
// epoch milliseconds (or ISO text from older nodes).

import { translate } from "@ryu/i18n/core";
import { formatDateTime } from "@/src/lib/timezone.ts";
import { timestampMillis } from "./vault-ttl.ts";

export function expiryText(value: string | number | null): string {
	if (value === null) {
		return translate("Never expires");
	}
	const millis = timestampMillis(value);
	return translate("Expires {when}", {
		when: millis === null ? String(value) : formatDateTime(millis),
	});
}

export function usesText(remaining: number | null): string {
	return remaining === null
		? translate("Unlimited uses")
		: translate("{count, plural, one {# use left} other {# uses left}}", {
				count: remaining,
			});
}
