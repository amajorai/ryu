import type { LiteralMessage } from "@ryu/i18n/react";
import type { CheckStatus, CheckType } from "@ryuhq/core-client/monitors";

const CONTENT_LENGTH = /^(\d+) chars$/u;

/**
 * A readable label for the raw value a monitor check stores. The backend keeps
 * these tokens (`up`, `present`, `in_stock`, `"12 chars"`) as comparison
 * state, so the label is mapped here instead of changing what it stores.
 * Returns the raw value for anything else (a price, a provider snapshot).
 */
export function monitorValueLabel(
	checkType: CheckType["type"],
	raw: string,
	tl: LiteralMessage
): string {
	if (checkType === "uptime") {
		if (raw === "up") {
			return tl("Up");
		}
		if (raw === "down") {
			return tl("Down");
		}
	}
	if (checkType === "keyword") {
		if (raw === "present") {
			return tl("Keyword present");
		}
		if (raw === "absent") {
			return tl("Keyword absent");
		}
	}
	if (checkType === "stock") {
		if (raw === "in_stock") {
			return tl("In stock");
		}
		if (raw === "out_of_stock") {
			return tl("Out of stock");
		}
	}
	if (checkType === "content_diff") {
		const length = CONTENT_LENGTH.exec(raw);
		if (length) {
			return tl("{count, plural, one {# character} other {# characters}}", {
				count: Number(length[1]),
			});
		}
	}
	return raw;
}

/** A readable label for a check status shown when no value was stored. */
export function monitorStatusLabel(
	status: CheckStatus,
	tl: LiteralMessage
): string {
	if (status === "triggered") {
		return tl("Alert triggered");
	}
	if (status === "error") {
		return tl("Check failed");
	}
	return tl("Check passed");
}
