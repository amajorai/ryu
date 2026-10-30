// Consent cards rendered by the consent tool. Each card lives in its own module;
// this file keeps the public import path stable.

import { Plug01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { CARD_CLASS, CardHeader } from "./consent-cards-shared.tsx";

export { ConnectAppCard } from "./consent-cards-connect.tsx";
export { PluginInstallCard } from "./consent-cards-install.tsx";
export {
	type ConsentFollowUp,
	PluginStats,
	TrustTierMark,
} from "./consent-cards-shared.tsx";

/** Read-only card for chats that can't act on a request or send the answer back. */
export function ConsentUnavailableCard({
	reason,
	title,
}: {
	reason: string;
	title: string;
}) {
	return (
		<section aria-label={title} className={CARD_CLASS}>
			<CardHeader
				icon={<HugeiconsIcon className="size-4" icon={Plug01Icon} />}
				reason={reason}
				title={title}
			/>
			<p className="border-border border-t px-3 py-2 text-muted-foreground text-xs">
				This chat can't act on the request. Connect or install it from the Store
				in Ryu, then reply here so the agent can continue.
			</p>
		</section>
	);
}
