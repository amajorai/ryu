"use client";

import { useLiteralMessages } from "@ryu/i18n/react";

/** "{count} featured apps", localized on the client for the server gallery. */
export function FeaturedAppsCount({ count }: { count: number }) {
	const tl = useLiteralMessages();
	return tl("{count} featured apps", { count: String(count) });
}

/** "Official app · {manifestId}", localized on the client for the server detail page. */
export function OfficialAppLabel({ manifestId }: { manifestId: string }) {
	const tl = useLiteralMessages();
	return tl("Official app · {manifestId}", { manifestId });
}
