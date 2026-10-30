import { AutoRetrySection } from "@/src/components/gateway/AutoRetrySection.tsx";
import { ByokCard } from "@/src/components/gateway/ByokCard.tsx";
import { EgressPoolsEditor } from "@/src/components/gateway/EgressPoolsEditor.tsx";
import { FallbackRulesSection } from "@/src/components/gateway/FallbackRulesSection.tsx";
import { GatewaySdkAccounts } from "@/src/components/gateway/GatewaySdkAccounts.tsx";
import {
	GatewayCloudSpeechAccounts,
	GatewaySpeechSettings,
} from "@/src/components/gateway/GatewaySpeechSettings.tsx";
import { GatewayWebAccounts } from "@/src/components/gateway/GatewayWebAccounts.tsx";
import { ProviderControlCenter } from "@/src/components/gateway/ProviderControlCenter.tsx";
import { IntegrationsTab } from "@/src/components/settings/IntegrationsTab.tsx";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import type { GatewayProvidersConfig } from "@/src/lib/api/gateway.ts";
import {
	getFalApiKey,
	getReplicateApiKey,
	setFalApiKey,
	setReplicateApiKey,
} from "@/src/lib/api/preferences.ts";
import { GatewayKeysCard, ManagedKeysBanner } from "./gateway-keys-card.tsx";
import { MediaKeyCard } from "./media-key-card.tsx";
import { RoutingCard } from "./routing-card.tsx";
import { PolicyReadOnlyBanner } from "./shared.tsx";
import { SmartRoutingCard } from "./smart-routing-card.tsx";

/** The gateway dialog's "providers" pane: credentials, integrations and routing. */
export function ProvidersSectionBody({
	canConfigure,
	configProviders,
	configRevision,
	managed,
	nodeUrl,
	reachable,
	refreshWithConfig,
	target,
	webServiceSchema,
	configuredProviders,
}: {
	canConfigure: boolean;
	configProviders: GatewayProvidersConfig | null;
	configRevision: string | null;
	managed: boolean;
	nodeUrl: string;
	reachable: boolean;
	refreshWithConfig: () => Promise<void>;
	target: ApiTarget;
	webServiceSchema: number | undefined;
	configuredProviders: string[];
}) {
	return (
		<ProviderControlCenter
			canSetGatewayAccount={canConfigure}
			credentials={
				<>
					{managed ? <ManagedKeysBanner /> : null}
					{canConfigure || managed ? null : <PolicyReadOnlyBanner />}
					<GatewayKeysCard reachable={reachable} target={target} />
					<ByokCard
						canConfigure={canConfigure}
						expectedRevision={configRevision ?? undefined}
						managed={managed}
						onRefresh={refreshWithConfig}
						providers={configProviders}
						target={target}
					/>
					<GatewaySdkAccounts
						canConfigure={canConfigure}
						expectedRevision={configRevision ?? undefined}
						managed={managed}
						onRefresh={refreshWithConfig}
						providers={configProviders}
						target={target}
					/>
					{webServiceSchema === 1 ? (
						<GatewaySpeechSettings
							canConfigure={canConfigure}
							canView={configProviders !== null}
							key={`speech-settings:${nodeUrl}`}
							managed={managed}
							onRefresh={refreshWithConfig}
							target={target}
						/>
					) : null}
					<GatewayCloudSpeechAccounts
						canConfigure={canConfigure}
						canView={configProviders !== null}
						key={`cloud-speech:${nodeUrl}`}
						managed={managed}
						onRefresh={refreshWithConfig}
						providers={configProviders}
						target={target}
					/>
					{webServiceSchema === 1 ? (
						<GatewayWebAccounts
							canConfigure={canConfigure}
							canView={configProviders !== null}
							key={`web-accounts:${nodeUrl}`}
							managed={managed}
							onRefresh={refreshWithConfig}
							target={target}
							webServiceSchema={webServiceSchema}
						/>
					) : null}
					<MediaKeyCard
						canConfigure={canConfigure}
						caption="Cloud image & video generation via Replicate."
						getKey={getReplicateApiKey}
						label="Replicate"
						managed={managed}
						placeholder="r8_…"
						saveKey={setReplicateApiKey}
						target={target}
					/>
					<MediaKeyCard
						canConfigure={canConfigure}
						caption="Cloud image, video and audio generation via fal.ai."
						getKey={getFalApiKey}
						label="Fal"
						managed={managed}
						placeholder="fal-…"
						saveKey={setFalApiKey}
						target={target}
					/>
				</>
			}
			integrations={<IntegrationsTab />}
			managed={managed}
			routing={
				<>
					{canConfigure ? null : <PolicyReadOnlyBanner />}
					<RoutingCard
						canConfigure={canConfigure}
						configuredProviders={configuredProviders}
						reachable={reachable}
						target={target}
					/>
					<EgressPoolsEditor
						canConfigure={canConfigure}
						providers={configuredProviders}
						reachable={reachable}
						target={target}
					/>
					<SmartRoutingCard
						canConfigure={canConfigure}
						reachable={reachable}
						target={target}
					/>
					<FallbackRulesSection canConfigure={canConfigure} target={target} />
					<AutoRetrySection canConfigure={canConfigure} target={target} />
				</>
			}
		/>
	);
}
