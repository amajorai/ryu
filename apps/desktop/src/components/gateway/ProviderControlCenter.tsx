"use client";

import type { ReactNode } from "react";
import { LlmProvidersSettings } from "@/src/components/settings/LlmProvidersSettings.tsx";
import type { LinkedSection } from "@/src/components/settings/provider-pages/provider-pages-model.ts";

/**
 * The "AI providers" pane of the node settings: one list of providers that
 * opens one page per provider. Credentials, integrations and model routing
 * are panes of their own in the same window; the list links to them through
 * `onOpenSection` instead of holding a second copy of each. The gateway's
 * own keys (read only, managed on the web) have no pane on a self-managed
 * node, so they are a page of this list.
 */
export function ProviderControlCenter({
	canSetGatewayAccount = true,
	gatewayKeys,
	managed = false,
	onOpenSection,
}: {
	canSetGatewayAccount?: boolean;
	/** The read-only list of the gateway's keys with its link to the web. */
	gatewayKeys?: ReactNode;
	managed?: boolean;
	/** Open the keys, integrations or routing pane of the same window. */
	onOpenSection?: (section: LinkedSection) => void;
}) {
	return (
		<LlmProvidersSettings
			canSetGatewayAccount={canSetGatewayAccount && !managed}
			gatewayKeys={gatewayKeys}
			onOpenSection={onOpenSection}
		/>
	);
}
