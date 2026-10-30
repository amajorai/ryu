import { SkeletonRows } from "@ryu/ui/components/skeleton.tsx";
import { lazy, Suspense } from "react";
import { AcpRuntimeSection } from "@/src/components/gateway/AcpRuntimeSection.tsx";
import { ApiSection } from "@/src/components/gateway/ApiSection.tsx";
import { AutoRetrySection } from "@/src/components/gateway/AutoRetrySection.tsx";
import { ComputerUseSettings } from "@/src/components/gateway/ComputerUseSettings.tsx";
import { DefaultsSection } from "@/src/components/gateway/DefaultsSection.tsx";
import { EgressPoolsEditor } from "@/src/components/gateway/EgressPoolsEditor.tsx";
import { EnvironmentsSection } from "@/src/components/gateway/EnvironmentsSection.tsx";
import { FallbackRulesSection } from "@/src/components/gateway/FallbackRulesSection.tsx";
import { GatewayPostureCard } from "@/src/components/gateway/GatewayPostureCard.tsx";
import { GitSettingsSection } from "@/src/components/gateway/GitSettingsSection.tsx";
import { GuardrailPoliciesSection } from "@/src/components/gateway/GuardrailPoliciesSection.tsx";
import { HooksSection } from "@/src/components/gateway/HooksSection.tsx";
import { McpSection } from "@/src/components/gateway/McpSection.tsx";
import { ModelsDefaultsCard } from "@/src/components/gateway/ModelsDefaultsCard.tsx";
import { NodeOnboardingSettings } from "@/src/components/gateway/NodeOnboardingSettings.tsx";
import { WorkspaceSection } from "@/src/components/gateway/WorkspaceSection.tsx";
import { WorktreesSection } from "@/src/components/gateway/WorktreesSection.tsx";
import { ConnectionsTab } from "@/src/components/settings/ConnectionsTab.tsx";
import { DangerZoneSettings } from "@/src/components/settings/DangerZoneSettings.tsx";
import { DesktopRouteSettings } from "@/src/components/settings/DesktopRouteSettings.tsx";
import { EmailAlertsSettings } from "@/src/components/settings/EmailAlertsSettings.tsx";
import { EncryptionSettings } from "@/src/components/settings/EncryptionSettings.tsx";
import { EntitySettings } from "@/src/components/settings/EntitySettings.tsx";
import { IntegrationsTab } from "@/src/components/settings/IntegrationsTab.tsx";
import {
	ManagedInferenceSettings,
	NetworkSettings,
} from "@/src/components/settings/NetworkSettings.tsx";
import { NodePermissionsSettings } from "@/src/components/settings/NodePermissionsSettings.tsx";
import { NodeRoutingSettings } from "@/src/components/settings/NodeRoutingSettings.tsx";
import { PrivacySettings } from "@/src/components/settings/PrivacySettings.tsx";
import { StorageSettings } from "@/src/components/settings/StorageSettings.tsx";
import { UpdatesSettings } from "@/src/components/settings/UpdatesSettings.tsx";
import type { ScopedNavEntity } from "@/src/hooks/useScopedSettingsNav.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import type {
	GatewayProvidersConfig,
	GatewayStatus,
} from "@/src/lib/api/gateway.ts";
import { BudgetsCard } from "./budgets-card.tsx";
import { GuardrailsSection } from "./guardrails-section.tsx";
import { KeysSectionBody } from "./keys-section-body.tsx";
import { LiveSpendCard } from "./live-spend-card.tsx";
import { OverviewSection } from "./overview-section.tsx";
import { ProvidersSectionBody } from "./providers-section-body.tsx";
import { RoutingCard } from "./routing-card.tsx";
import { PolicyReadOnlyBanner } from "./shared.tsx";
import { SmartRoutingCard } from "./smart-routing-card.tsx";

// The heavy, rarely opened panes load on first open, behind a skeleton at the
// pane's height, so opening the dialog never pays for them.
const TrafficMapSection = lazy(() =>
	import("@/src/components/gateway/TrafficMapSection.tsx").then((m) => ({
		default: m.TrafficMapSection,
	}))
);
const CloudEnvironmentsSettings = lazy(() =>
	import("@/src/components/gateway/CloudEnvironmentsSettings.tsx").then(
		(m) => ({ default: m.CloudEnvironmentsSettings })
	)
);
const AgentSyncImportSection = lazy(() =>
	import("@/src/components/gateway/AgentSyncSections.tsx").then((m) => ({
		default: m.AgentSyncImportSection,
	}))
);
const AgentSyncExportSection = lazy(() =>
	import("@/src/components/gateway/AgentSyncSections.tsx").then((m) => ({
		default: m.AgentSyncExportSection,
	}))
);
const RunEvalsPanel = lazy(() =>
	import("./run-evals-panel.tsx").then((m) => ({ default: m.RunEvalsPanel }))
);
const AuditPanel = lazy(() =>
	import("./audit-panel.tsx").then((m) => ({ default: m.AuditPanel }))
);
const PreflightPage = lazy(() =>
	import("@/src/pages/PreflightPage.tsx").then((m) => ({
		default: m.PreflightPage,
	}))
);
const UsageCostSection = lazy(() =>
	import("@/src/components/gateway/UsageCostSection.tsx").then((m) => ({
		default: m.UsageCostSection,
	}))
);

interface GatewaySectionBodyProps {
	activeEntity: ScopedNavEntity | undefined;
	appliedProviderRevision: string | null | undefined;
	canConfigure: boolean;
	canViewTraffic: boolean;
	configProviders: GatewayProvidersConfig | null;
	configRevision: string | null;
	managed: boolean;
	nodeUrl: string;
	reachable: boolean;
	refreshWithConfig: () => Promise<void>;
	section: string;
	setSection: (section: string) => void;
	status: GatewayStatus | null;
	target: ApiTarget;
	webServiceSchema: number | undefined;
}

/**
 * The content pane of the gateway dialog: renders the body of whichever
 * section (or node-scoped app/plugin entity) is selected.
 */
export function GatewaySectionBody({
	activeEntity,
	appliedProviderRevision,
	canConfigure,
	canViewTraffic,
	configProviders,
	configRevision,
	managed,
	nodeUrl,
	reachable,
	refreshWithConfig,
	section,
	setSection,
	status,
	target,
	webServiceSchema,
}: GatewaySectionBodyProps) {
	const health = status?.health ?? null;
	const metrics = status?.metrics ?? null;
	return (
		<Suspense fallback={<SkeletonRows spacing="spacious" />}>
			<GatewaySectionPanes
				{...{
					activeEntity,
					appliedProviderRevision,
					canConfigure,
					canViewTraffic,
					configProviders,
					configRevision,
					health,
					managed,
					metrics,
					nodeUrl,
					reachable,
					refreshWithConfig,
					section,
					setSection,
					status,
					target,
					webServiceSchema,
				}}
			/>
		</Suspense>
	);
}

function GatewaySectionPanes({
	activeEntity,
	appliedProviderRevision,
	canConfigure,
	canViewTraffic,
	configProviders,
	configRevision,
	health,
	managed,
	metrics,
	nodeUrl,
	reachable,
	refreshWithConfig,
	section,
	setSection,
	status,
	target,
	webServiceSchema,
}: GatewaySectionBodyProps & {
	health: GatewayStatus["health"] | null;
	metrics: GatewayStatus["metrics"] | null;
}) {
	return (
		<div className="flex flex-col gap-8 [&>*]:mt-0">
			{section === "overview" ? (
				<OverviewSection
					canConfigure={canConfigure}
					metrics={metrics}
					reachable={reachable}
					status={status}
					target={target}
				/>
			) : null}
			{section === "workspace" ? <WorkspaceSection /> : null}
			{section === "defaults" ? (
				<>
					<DefaultsSection
						canConfigure={canConfigure}
						managed={managed}
						target={target}
					/>
					<ModelsDefaultsCard canConfigure={canConfigure} target={target} />
				</>
			) : null}
			{/* LLM Providers. Provider *selection* (which model/keys/routing the
			    local Pi agent uses) is strictly Core — "what runs" — NOT account/org
			    data, so it lives here on the node/infra Gateway surface, next to
			    model routing, rather than in the account SettingsDialog. The
			    component is reused verbatim; only its host dialog moved. */}
			{section === "providers" ? (
				<ProvidersSectionBody
					canConfigure={canConfigure}
					configProviders={configProviders}
					configRevision={configRevision}
					configuredProviders={health?.providers ?? []}
					managed={managed}
					nodeUrl={nodeUrl}
					reachable={reachable}
					refreshWithConfig={refreshWithConfig}
					target={target}
					webServiceSchema={webServiceSchema}
				/>
			) : null}
			{section === "routing" ? (
				<>
					{canConfigure ? null : <PolicyReadOnlyBanner />}
					<RoutingCard
						canConfigure={canConfigure}
						configuredProviders={health?.providers ?? []}
						reachable={reachable}
						target={target}
					/>
					<EgressPoolsEditor
						canConfigure={canConfigure}
						providers={health?.providers ?? []}
						reachable={reachable}
						target={target}
					/>
					<SmartRoutingCard
						canConfigure={canConfigure}
						reachable={reachable}
						target={target}
					/>
					{/* Threshold-driven fallback: proactively swap the model when
					    credit / a subscription window runs low. A different axis from
					    the cards above, which react to an error or a prompt's shape —
					    but the same question ("which model actually answers"), so it
					    belongs in this section. */}
					<FallbackRulesSection canConfigure={canConfigure} target={target} />
					<AutoRetrySection canConfigure={canConfigure} target={target} />
				</>
			) : null}
			{section === "guardrails" ? (
				<>
					{canConfigure ? null : <PolicyReadOnlyBanner />}
					<GuardrailsSection
						canConfigure={canConfigure}
						reachable={reachable}
						target={target}
					/>
				</>
			) : null}
			{section === "traffic-map" ? (
				<TrafficMapSection
					canConfigure={canConfigure}
					canViewTraffic={canViewTraffic}
					onNavigate={setSection}
					reachable={reachable}
					renderSafetyFilters={() => (
						<GuardrailsSection
							canConfigure={canConfigure}
							reachable={reachable}
							target={target}
						/>
					)}
					status={status}
					target={target}
				/>
			) : null}
			{section === "policies" ? <GuardrailPoliciesSection /> : null}
			{section === "runtime" ? (
				<>
					{canConfigure ? null : <PolicyReadOnlyBanner />}
					<AcpRuntimeSection canConfigure={canConfigure} target={target} />
				</>
			) : null}
			{section === "hooks" ? (
				<HooksSection canConfigure={canConfigure} target={target} />
			) : null}
			{section === "git" ? (
				<GitSettingsSection canConfigure={canConfigure} target={target} />
			) : null}
			{section === "worktrees" ? (
				<WorktreesSection canConfigure={canConfigure} target={target} />
			) : null}
			{section === "environments" ? <EnvironmentsSection /> : null}
			{section === "cloud-environments" ? <CloudEnvironmentsSettings /> : null}
			{section === "budgets" ? (
				<>
					{canConfigure ? null : <PolicyReadOnlyBanner />}
					<BudgetsCard canConfigure={canConfigure} target={target} />
					<LiveSpendCard target={target} />
				</>
			) : null}
			{section === "keys" ? (
				<KeysSectionBody
					appliedProviderRevision={appliedProviderRevision}
					canConfigure={canConfigure}
					configProviders={configProviders}
					configRevision={configRevision}
					managed={managed}
					nodeUrl={nodeUrl}
					reachable={reachable}
					refreshWithConfig={refreshWithConfig}
					statusUrl={status?.url}
					target={target}
					webServiceSchema={webServiceSchema}
				/>
			) : null}
			{section === "integrations" ? <IntegrationsTab /> : null}
			{section === "network" ? (
				<>
					<NetworkSettings />
					<DesktopRouteSettings />
					<ManagedInferenceSettings />
					<NodeRoutingSettings />
				</>
			) : null}
			{section === "usage" ? (
				<UsageCostSection
					configuredProviders={health?.providers ?? []}
					metrics={metrics}
					reachable={reachable}
					target={target}
				/>
			) : null}
			{section === "audit" ? <AuditPanel target={target} /> : null}
			{section === "api" ? (
				<ApiSection
					canConfigure={canConfigure}
					canViewTraffic={canViewTraffic}
					managed={managed}
					reachable={reachable}
					statusUrl={status?.url ?? null}
					target={target}
				/>
			) : null}
			{section === "mcp" ? <McpSection target={target} /> : null}
			{section === "import" ? <AgentSyncImportSection target={target} /> : null}
			{section === "export" ? <AgentSyncExportSection target={target} /> : null}
			{section === "evals" ? <RunEvalsPanel target={target} /> : null}
			{/* Node-level Core-infra tabs (moved out of the App Settings dialog). */}
			{section === "connections" ? <ConnectionsTab /> : null}
			{section === "email-alerts" ? <EmailAlertsSettings /> : null}
			{section === "privacy" ? <PrivacySettings /> : null}
			{section === "computer" ? (
				<ComputerUseSettings
					canConfigure={canConfigure}
					reachable={reachable}
					target={target}
				/>
			) : null}
			{section === "access" ? <ConnectionsTab /> : null}
			{section === "permissions" ? <NodePermissionsSettings /> : null}
			{/* Also carries the node's upload ceiling, which used to be the one
			    thing the retired "Document parsing" section owned alone. The parser
			    itself is bound from the node dropdown's Toolkits row. */}
			{section === "storage" ? <StorageSettings /> : null}
			{section === "encryption" ? <EncryptionSettings /> : null}
			{section === "updates" ? <UpdatesSettings /> : null}
			{section === "health" ? (
				<>
					<GatewayPostureCard
						canConfigure={canConfigure}
						compact={false}
						reachable={reachable}
						target={target}
					/>
					<PreflightPage embedded />
				</>
			) : null}
			{section === "onboarding" ? (
				<NodeOnboardingSettings canConfigure={canConfigure} target={target} />
			) : null}
			{section === "danger" ? <DangerZoneSettings /> : null}
			{/* Dynamic node-scoped app/plugin settings (manifest-registered). */}
			{activeEntity ? (
				<EntitySettings entity={activeEntity} target={target} />
			) : null}
		</div>
	);
}
