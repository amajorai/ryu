"use client";
// The raw message behind a Store or catalog load failure. The empty state says
// one plain sentence and offers Retry; the transport text ("… returned
// text/html, not JSON") stays behind this disclosure for support and debugging,
// never in the sentence itself.

import { useLocalizedString } from "@ryu/i18n/react";

export function StoreErrorDetails({ message }: { message?: string | null }) {
	const detailsLabel = useLocalizedString("Details");
	if (!message) {
		return null;
	}
	return (
		<details
			className="w-full max-w-sm text-muted-foreground text-xs"
			data-slot="store-error-details"
		>
			<summary className="cursor-pointer select-none">{detailsLabel}</summary>
			<p className="mt-1 break-words text-left">{message}</p>
		</details>
	);
}

/** The one sentence a catalog load failure shows in place of its raw message. */
export const STORE_LOAD_ERROR_SENTENCE =
	"Check your connection, then try again.";
