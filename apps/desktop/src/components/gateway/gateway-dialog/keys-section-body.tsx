import type { ReactNode } from "react";
import { GatewayClientKeys } from "@/src/components/gateway/ApiSection.tsx";
import { ByokCard } from "@/src/components/gateway/ByokCard.tsx";
import { GatewayProviderApplication } from "@/src/components/gateway/GatewayProviderApplication.tsx";
import { GatewaySdkAccounts } from "@/src/components/gateway/GatewaySdkAccounts.tsx";
import {
	GatewayCloudSpeechAccounts,
	GatewaySpeechSettings,
} from "@/src/components/gateway/GatewaySpeechSettings.tsx";
import { GatewayWebAccounts } from "@/src/components/gateway/GatewayWebAccounts.tsx";
import { CaptionInfo } from "@/src/components/gateway/quiet.tsx";
import { AccountKeysDisplay } from "@/src/components/gateway/usage-cost/account-keys-display.tsx";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import type { GatewayProvidersConfig } from "@/src/lib/api/gateway.ts";
import {
	getFalApiKey,
	getReplicateApiKey,
	setFalApiKey,
	setReplicateApiKey,
} from "@/src/lib/api/preferences.ts";
import { ComposioKeyCard } from "./composio-key-card.tsx";
import { GatewayKeysCard, ManagedKeysBanner } from "./gateway-keys-card.tsx";
import { MediaKeyCard } from "./media-key-card.tsx";
import { PolicyReadOnlyBanner } from "./shared.tsx";

/** The gateway dialog's "keys" pane: client keys and every provider credential. */
export function KeysSectionBody({
	canConfigure,
	configProviders,
	configRevision,
	managed,
	nodeUrl,
	reachable,
	refreshWithConfig,
	target,
	webServiceSchema,
	appliedProviderRevision,
	statusUrl,
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
	appliedProviderRevision: string | null | undefined;
	statusUrl: string | null | undefined;
}) {
	return (
		<>
			{managed ? <ManagedKeysBanner /> : null}
			{canConfigure || managed ? null : <PolicyReadOnlyBanner />}
			<KeysGroup label="Providers">
				<GatewayProviderApplication
					appliedRevision={appliedProviderRevision}
					canConfigure={canConfigure}
					key={`provider-application:${nodeUrl}`}
					managed={managed}
					onRefresh={refreshWithConfig}
					reachable={reachable}
					revision={configRevision}
					target={target}
				/>
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
				{/* Extra rotation keys are keys too, so they sit with the provider
				    keys rather than on Usage & cost. */}
				<AccountKeysDisplay reachable={reachable} target={target} />
			</KeysGroup>
			<KeysGroup label="Media & tools">
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
				<ComposioKeyCard
					canConfigure={canConfigure}
					managed={managed}
					target={target}
				/>
				<MediaKeyCard
					canConfigure={canConfigure}
					caption={
						<CaptionInfo
							detail={
								"Cloud image & video generation via Replicate. Stored locally and sent only to Replicate; the gateway meters and governs each call. Get a token at replicate.com/account/api-tokens."
							}
						>
							{"Image and video generation through Replicate."}
						</CaptionInfo>
					}
					getKey={getReplicateApiKey}
					label="Replicate"
					managed={managed}
					placeholder="r8_…"
					saveKey={setReplicateApiKey}
					target={target}
				/>
				<MediaKeyCard
					canConfigure={canConfigure}
					caption={
						<CaptionInfo
							detail={
								"Cloud image, video & audio generation via fal.ai. Stored locally and sent only to Fal; the gateway meters and governs each call. Get a key at fal.ai/dashboard/keys."
							}
						>
							{"Image, video and audio generation through fal.ai."}
						</CaptionInfo>
					}
					getKey={getFalApiKey}
					label="Fal"
					managed={managed}
					placeholder="fal-…"
					saveKey={setFalApiKey}
					target={target}
				/>
			</KeysGroup>
			<KeysGroup label="App access keys">
				{managed ? (
					<GatewayKeysCard reachable={reachable} target={target} />
				) : (
					<GatewayClientKeys
						baseUrl={statusUrl ?? target.url}
						canConfigure={canConfigure}
						gatewayReady={reachable && statusUrl != null}
						key={`client-keys:${nodeUrl}`}
						managed={false}
						target={target}
					/>
				)}
			</KeysGroup>
		</>
	);
}

/**
 * One of the three groups on the API keys pane. The pane keeps every card; the
 * groups only say which kind of key each one holds.
 */
function KeysGroup({
	children,
	label,
}: {
	children: ReactNode;
	label: string;
}) {
	return (
		<section
			aria-label={label}
			className="flex flex-col gap-8 border-border border-t pt-6 first-of-type:border-t-0 first-of-type:pt-0 [&>*]:mt-0"
		>
			<h3 className="text-(length:--text-detail) text-muted-foreground leading-(--text-detail--line-height)">
				{label}
			</h3>
			{children}
		</section>
	);
}
