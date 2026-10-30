// apps/desktop/src/components/gateway/UsageCostSection.tsx
//
// The Gateway "Usage & Cost" surface. Three cards (the read-only additional
// account keys moved to the API keys pane, `UsageCostSection-account-keys.tsx`):
//  1. Per-provider quota / rate-limit countdowns — read live from the gateway
//     `/metrics` `provider_quota` block (proxied through Core's gateway-status
//     endpoint, so no extra fetch loop: the parent's 5s status poll feeds this
//     card and a local 1s ticker smooths the countdown between polls).
//  2. Per-model spend — the control-plane usage rollup (`fetchProfileStats`:
//     lifetime cost in micro-USD + per-model request counts). Reuses the same
//     query key as the Stats tab so the cache is shared.
//  3. Provider cost-tier editor — reads the current `routing.provider_tiers`
//     from the config GET and writes it back with a full read-modify-write of
//     the whole `routing` object (0 = subscription, 1 = cheap, 2 = free),
//     because PUT /v1/config replaces the entire routing object.
//
// The tier editor goes through the SAME save path the rest of the dialog uses
// (`updateGatewayConfig`), which Core forwards verbatim to the gateway's
// `PUT /v1/config`.

import { OrgBillingContext } from "@/src/components/billing/OrgBillingContext.tsx";
import { CaptionInfo } from "@/src/components/gateway/quiet.tsx";
import { SettingsSection } from "@/src/components/settings/shared/settings-items.tsx";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import type { GatewayMetrics } from "@/src/lib/api/gateway.ts";
import { ProviderCreditsCard } from "./UsageCostSection-provider-credits.tsx";
import {
	ModelSpendCard,
	ProviderQuotaCard,
} from "./UsageCostSection-quota-spend.tsx";
import { ProviderTierEditor } from "./UsageCostSection-tier-editor.tsx";

// ── Section ──────────────────────────────────────────────────────────────────

export function UsageCostSection({
	target,
	reachable,
	metrics,
	configuredProviders,
}: {
	configuredProviders: string[];
	metrics: GatewayMetrics | null;
	reachable: boolean;
	target: ApiTarget;
}) {
	return (
		<div className="flex flex-col gap-8 [&>*]:mt-0">
			<SettingsSection
				caption={
					<CaptionInfo
						detail={
							"Managed inference debits this organization wallet; BYOK balances belong to keys stored on this node. Quota countdowns refresh with the gateway status poll, and the account rollup below is separate from the organization wallet."
						}
					>
						{
							"Managed inference spends organization credits; BYOK uses your own keys."
						}
					</CaptionInfo>
				}
				title="Billing"
			>
				<OrgBillingContext
					compact
					description="Ryu managed inference spends from this organization's shared credits."
					label="Managed inference billing"
				/>
			</SettingsSection>
			<ProviderQuotaCard metrics={metrics} />
			<ModelSpendCard />
			<ProviderTierEditor
				configuredProviders={configuredProviders}
				reachable={reachable}
				target={target}
			/>
			<ProviderCreditsCard />
		</div>
	);
}
