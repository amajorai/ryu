// The "What's new?" row caption: kind label, version and day, joined with
// " · " into one text node, so each label is translated before the join.

import type { LiteralMessage } from "@ryu/i18n/react";
import type { RecentUpdateItem } from "@/src/lib/api/updates.ts";
import { formatDate } from "@/src/lib/timezone.ts";

// The feed's `date` is the site's calendar day (`2026-10-01`) or, rarely, a
// timestamp. Hand `formatDate` the original string, not a parsed `Date`: it
// prints a bare day as written and keeps an instant in the display zone, but a
// `Date` of UTC midnight shows the previous day west of UTC.
function formatItemDate(date: string): string {
	if (Number.isNaN(new Date(date).getTime())) {
		return "";
	}
	return formatDate(date, {
		month: "short",
		day: "numeric",
		year: "numeric",
	});
}

export function itemMeta(item: RecentUpdateItem, tl: LiteralMessage): string {
	const date = formatItemDate(item.date);
	if (item.kind === "blog") {
		return [item.tag ?? tl("Blog"), date].filter(Boolean).join(" · ");
	}
	const parts = [tl("Changelog")];
	if (item.version) {
		parts.push(`v${item.version}`);
	}
	if (date) {
		parts.push(date);
	}
	return parts.join(" · ");
}
