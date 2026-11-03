"use client";

import { useLiteralMessages } from "@ryu/i18n/react";

/**
 * A polite live region that tells screen-reader users how many results a
 * search left. It is always mounted (empty while nothing is searched) so the
 * first announcement is not lost when it appears.
 */
export function SearchResultStatus({
	count,
	kind,
	query,
}: {
	count: number;
	kind: "posts" | "releases";
	query: string;
}) {
	const tl = useLiteralMessages();
	const trimmed = query.trim();
	let message = "";
	if (trimmed && kind === "posts") {
		message = tl(
			'{count, plural, =0 {No posts} one {# post} other {# posts}} match "{query}"',
			{ count, query: trimmed }
		);
	} else if (trimmed) {
		message = tl(
			'{count, plural, =0 {No releases} one {# release} other {# releases}} match "{query}"',
			{ count, query: trimmed }
		);
	}
	return (
		<p aria-live="polite" className="sr-only" data-slot="search-status">
			{message}
		</p>
	);
}
