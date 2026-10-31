"use client";

import { useLiteralMessages } from "@ryu/i18n/react";
import type { PiProvider } from "@/src/lib/api/pi-config.ts";

type RoutingCapabilities = NonNullable<PiProvider["accountRouting"]>;

/** Heading and caption for the OAuth account-routing fieldset. */
export function AccountRoutingHeader({
	capabilities,
}: {
	capabilities: RoutingCapabilities;
}) {
	const tl = useLiteralMessages();
	let caption: string;
	if (capabilities.quotaObservations) {
		caption = tl(
			"Applies to new conversations. Healthy conversations keep their account for prompt caching. Unknown quota falls back to rotation."
		);
	} else if (capabilities.strategies.includes("fill_first")) {
		caption = tl(
			"Applies to new conversations. Healthy conversations keep their account for prompt caching. Quota observations are unavailable. Fill first keeps the first eligible account until availability or priority changes."
		);
	} else {
		caption = tl(
			"Applies to new conversations. Healthy conversations keep their account for prompt caching. Quota observations are unavailable."
		);
	}
	return (
		<div>
			<h4 className="font-medium text-sm">Account routing</h4>
			<p className="text-detail text-muted-foreground">{caption}</p>
		</div>
	);
}
