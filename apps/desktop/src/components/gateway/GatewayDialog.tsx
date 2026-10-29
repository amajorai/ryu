import type { CSSProperties } from "react";
import "./gateway-dialog.css";
import {
	Activity01Icon,
	Add01Icon,
	ApiIcon,
	ArrowDown01Icon,
	ArrowUp01Icon,
	BubbleChatIcon,
	CodeCircleIcon,
	CpuIcon,
	Delete01Icon,
	Dollar01Icon,
	EyeIcon,
	FlowConnectionIcon,
	GitBranchIcon,
	Key01Icon,
	LaptopIcon,
	Package01Icon,
	PencilEdit01Icon,
	Plug01Icon,
	PlugSocketIcon,
	PolicyIcon,
	Refresh01Icon,
	Settings01Icon,
	Share08Icon,
	Shield01Icon,
	SparklesIcon,
	SquareLock01Icon,
	UserGroupIcon,
	ViewOffSlashIcon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	EvaluatorCatalog,
	type EvaluatorCatalogItem,
} from "@ryu/blocks/desktop/evaluator-catalog.tsx";
import {
	LockedByBroader,
	LockToggle,
	PipelineBadge,
} from "@ryu/blocks/desktop/guardrails/controls.tsx";
import {
	GUARDRAIL_ACTION_LABELS as POLICY_LABELS,
	GUARDRAIL_ACTION_OPTIONS as POLICY_OPTIONS,
} from "@ryu/blocks/desktop/guardrails/copy.ts";
import {
	DlpCard,
	FirewallCard,
} from "@ryu/blocks/desktop/guardrails/firewall-cards.tsx";
import type { GuardrailScopeCtx } from "@ryu/blocks/desktop/guardrails/types.ts";
import ResizableSettingsLayout from "@ryu/blocks/desktop/resizable-settings-layout.tsx";
import {
	SettingsIconTile,
	type SettingsTint,
} from "@ryu/blocks/desktop/settings-nav.tsx";
import { Badge } from "@ryu/ui/components/badge.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@ryu/ui/components/dialog.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { Label } from "@ryu/ui/components/label.tsx";
import { FluidSlider } from "@ryu/ui/components/motion/range-slider-fluid.tsx";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select.tsx";
import {
	SidebarGroup,
	SidebarGroupLabel,
	SidebarMenu,
	SidebarMenuButton,
	SidebarMenuItem,
} from "@ryu/ui/components/sidebar.tsx";
import { SkeletonRows } from "@ryu/ui/components/skeleton.tsx";
import { Switch } from "@ryu/ui/components/switch.tsx";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ryu/ui/components/tooltip.tsx";
import { isNativeNumber } from "@ryu/ui/lib/native-primitive-observation.ts";
import { formatNumber as formatSharedNumber } from "@ryu/ui/lib/number-format.ts";
import { useQuery } from "@tanstack/react-query";
import type { ComponentProps, ReactElement, ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AgentModelPickerField } from "@/components/agent-elements/input/agent-model-picker-field.tsx";
import { WEB_URL } from "@/lib/app-urls.ts";
import { openExternal } from "@/lib/tauri-bridge.ts";
import { toCatalogItem } from "@/src/components/evaluators/catalog-utils.ts";
import {
	EvaluatorEditorDialog,
	type EvaluatorEditorMode,
} from "@/src/components/evaluators/EvaluatorEditorDialog.tsx";
import { AcpRuntimeSection } from "@/src/components/gateway/AcpRuntimeSection.tsx";
import { AgentEgressSection } from "@/src/components/gateway/AgentEgressSection.tsx";
import {
	AgentSyncExportSection,
	AgentSyncImportSection,
} from "@/src/components/gateway/AgentSyncSections.tsx";
import {
	ApiSection,
	GatewayClientKeys,
} from "@/src/components/gateway/ApiSection.tsx";
import { AutoRetrySection } from "@/src/components/gateway/AutoRetrySection.tsx";
import { BudgetChargeInclusionFields } from "@/src/components/gateway/BudgetRuleFields.tsx";
import { ByokCard } from "@/src/components/gateway/ByokCard.tsx";
import {
	budgetUsdToMicroUsd,
	formatBudgetUsd,
	microUsdToBudgetInput,
} from "@/src/components/gateway/budget-copy.ts";
import { CloudEnvironmentsSettings } from "@/src/components/gateway/CloudEnvironmentsSettings.tsx";
import { ComputerUseSettings } from "@/src/components/gateway/ComputerUseSettings.tsx";
import { DefaultsSection } from "@/src/components/gateway/DefaultsSection.tsx";
import { EgressPoolsEditor } from "@/src/components/gateway/EgressPoolsEditor.tsx";
import { EnvironmentsSection } from "@/src/components/gateway/EnvironmentsSection.tsx";
import { FallbackRulesSection } from "@/src/components/gateway/FallbackRulesSection.tsx";
import { GatewayNodeScopePicker } from "@/src/components/gateway/GatewayNodeScopePicker.tsx";
import { GatewayPostureCard } from "@/src/components/gateway/GatewayPostureCard.tsx";
import { GatewayProviderApplication } from "@/src/components/gateway/GatewayProviderApplication.tsx";
import { GatewaySdkAccounts } from "@/src/components/gateway/GatewaySdkAccounts.tsx";
import {
	GatewayCloudSpeechAccounts,
	GatewaySpeechSettings,
} from "@/src/components/gateway/GatewaySpeechSettings.tsx";
import { GatewayWebAccounts } from "@/src/components/gateway/GatewayWebAccounts.tsx";
import { GitSettingsSection } from "@/src/components/gateway/GitSettingsSection.tsx";
import { GuardrailPoliciesSection } from "@/src/components/gateway/GuardrailPoliciesSection.tsx";
import { HooksSection } from "@/src/components/gateway/HooksSection.tsx";
import { McpSection } from "@/src/components/gateway/McpSection.tsx";
import { ModelsDefaultsCard } from "@/src/components/gateway/ModelsDefaultsCard.tsx";
import { NodeOnboardingSettings } from "@/src/components/gateway/NodeOnboardingSettings.tsx";
import { ProviderControlCenter } from "@/src/components/gateway/ProviderControlCenter.tsx";
import { ManagedKeyNote } from "@/src/components/gateway/ProviderKeyRow.tsx";
import { ProviderPoolsEditor } from "@/src/components/gateway/ProviderPoolsEditor.tsx";
import { RoutePoolFields } from "@/src/components/gateway/RoutePoolFields.tsx";
import { TrafficMapSection } from "@/src/components/gateway/TrafficMapSection.tsx";
import { TrustedFoldersCard } from "@/src/components/gateway/TrustedFoldersCard.tsx";
import { UsageCostSection } from "@/src/components/gateway/UsageCostSection.tsx";
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
import { SettingsSearchResults } from "@/src/components/settings/SettingsSearchResults.tsx";
import { StorageSettings } from "@/src/components/settings/StorageSettings.tsx";
import {
	SettingsCard,
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "@/src/components/settings/shared/settings-items.tsx";
import { UpdatesSettings } from "@/src/components/settings/UpdatesSettings.tsx";
import { NodeScopeProvider } from "@/src/contexts/NodeScopeContext.tsx";
import {
	useActiveNode,
	useActiveNodeGetter,
} from "@/src/hooks/useActiveNode.ts";
import { useFriendlyMode } from "@/src/hooks/useFriendlyMode.ts";
import {
	useCanManagePermission,
	useGatewayConfigurable,
} from "@/src/hooks/useGatewayConfigurable.ts";
import { useGatewayStatus } from "@/src/hooks/useGatewayStatus.ts";
import {
	NO_DEFAULT_MODEL_INPUT_HINT,
	useNodeDefaultModel,
} from "@/src/hooks/useNodeDefaultModel.ts";
import {
	APP_SECTION_PREFIX,
	buildEntityNavGroups,
	isEntitySection,
	PLUGIN_SECTION_PREFIX,
	type ScopedNavEntity,
	useScopedSettingsNav,
} from "@/src/hooks/useScopedSettingsNav.ts";
import { useSettingReveal } from "@/src/hooks/useSettingReveal.ts";
import type { AgentSummary } from "@/src/lib/api/agents.ts";
import { fetchAgents } from "@/src/lib/api/agents.ts";
import { CATALOG_SCAN_AGENT_PREF } from "@/src/lib/api/catalog-scan.ts";
import { ApiError, type ApiTarget } from "@/src/lib/api/client.ts";
import type {
	AuditEntry,
	BudgetAction,
	BudgetChargeInclusion,
	BudgetRule,
	BudgetSpend,
	ClassifyTierState,
	EvalCaseScore,
	EvalRunAggregate,
	EvalRunResult,
	Evaluator,
	EvaluatorBinding,
	GatewayAlertTier,
	GatewayAuthConfig,
	GatewayBudgetConfig,
	GatewayConfig,
	GatewayFirewallConfig,
	GatewayFirewallOverlay,
	GatewayFirewallView,
	GatewayMetrics,
	GatewayProvidersConfig,
	GatewayRoutingConfig,
	GatewayStatus,
	InspectorConfig,
	InspectorMode,
	Modality,
	ModalityMapping,
	ModelMapping,
	ModelRouterType,
	ProviderCircuitState,
	ProviderKind,
	ProviderPoolStrategy,
	RouteStrategy,
	SmartRoutingConfig,
} from "@/src/lib/api/gateway.ts";
import {
	ALERT_TIERS,
	buildBudgetRule,
	CLASSIFY_MODEL_ID,
	CLASSIFY_TIER_COPY,
	classifyTierCannotServeModel,
	classifyTierServable,
	DEFAULT_BUDGET_INCLUSION,
	DEFAULT_INSPECTOR,
	DEFAULT_SESSION_BUDGET,
	DEFAULT_SMART_ROUTING,
	deleteCustomEvaluator,
	deriveClassifyTierState,
	fetchBudgetSpend,
	fetchClassifyWeightsPresent,
	fetchEvaluators,
	fetchGatewayAudit,
	fetchGatewayConfig,
	formatPoolList,
	MODALITIES,
	MODEL_ROUTER_TYPE_DESCRIPTIONS,
	MODEL_ROUTER_TYPE_LABELS,
	parsePoolList,
	routeStrategyCopy,
	routingViewIncludesModalityMap,
	routingViewIncludesSmartRouting,
	runGatewayEvals,
	sameGuardrailSections,
	updateGatewayConfig,
	withModalityMapping,
	withRoutingDraftEdits,
} from "@/src/lib/api/gateway.ts";
import {
	getComposioApiKey,
	getExecApprovalEnabled,
	getFalApiKey,
	getPreference,
	getReplicateApiKey,
	setComposioApiKey,
	setExecApprovalEnabled,
	setFalApiKey,
	setPreference,
	setReplicateApiKey,
} from "@/src/lib/api/preferences.ts";
import { fetchSidecarStatus } from "@/src/lib/api/system.ts";
import { requestSettingReveal } from "@/src/lib/settings-focus.ts";
import type { SettingsEntry } from "@/src/lib/settings-index.ts";
import { formatTime } from "@/src/lib/timezone.ts";
import { PreflightPage } from "@/src/pages/PreflightPage.tsx";
import type { GatewaySection } from "@/src/store/useGatewayDialog.ts";
import { useNodeStore } from "@/src/store/useNodeStore.ts";
import { useSettingsDialog } from "@/src/store/useSettingsDialog.ts";

/**
 * Banner shown atop a policy section when the caller lacks `gateway.configure`.
 * The write controls in that section are also disabled; this explains why.
 */
function PolicyReadOnlyBanner() {
	return (
		<SettingsCard className="flex items-start gap-2 text-muted-foreground text-sm">
			<HugeiconsIcon
				className="mt-0.5 size-4 shrink-0"
				icon={SquareLock01Icon}
			/>
			<span>
				<span className="font-medium text-foreground">Read-only.</span> You do
				not have the <span className="font-mono">gateway.configure</span>{" "}
				permission in this workspace, so changes are disabled. Ask a workspace
				owner or admin to grant it.
			</span>
		</SettingsCard>
	);
}

function formatNumber(value: number): string {
	return formatSharedNumber(value);
}

function formatPercent(rate: number): string {
	return `${(rate * 100).toFixed(1)}%`;
}

/**
 * One stat inside a metrics `SettingsCard`. No surface of its own: that card is
 * the only box, so a row of stats reads as one card, not tiles in a card.
 */
function MetricTile({ label, value }: { label: string; value: string }) {
	return (
		<div className="min-w-0">
			<div className="text-muted-foreground text-xs">{label}</div>
			<div className="mt-0.5 truncate font-medium text-lg tabular-nums">
				{value}
			</div>
		</div>
	);
}

function circuitBadgeVariant(
	state: ProviderCircuitState | undefined
): "default" | "secondary" | "destructive" {
	if (!state) {
		return "secondary";
	}
	if (state.circuit === "open") {
		return "destructive";
	}
	if (state.circuit === "half_open") {
		return "secondary";
	}
	return "default";
}

function circuitBadgeLabel(state: ProviderCircuitState | undefined): string {
	if (!state) {
		return "Up";
	}
	if (state.circuit === "open") {
		return state.openForSecs === null ? "Open" : `Open (${state.openForSecs}s)`;
	}
	if (state.circuit === "half_open") {
		return "Half-open";
	}
	return "Up";
}

function ProvidersCard({
	providers,
	metrics,
}: {
	providers: string[];
	metrics: GatewayMetrics | null;
}) {
	const requestCounts = metrics?.providers.requests ?? {};
	const errorCounts = metrics?.providers.errors ?? {};
	const healthMap = metrics?.providerHealth ?? {};

	return (
		<SettingsSection
			caption="Configured providers the gateway can route to, with per-provider request and error counts. The health badge flips to Open when the circuit breaker trips."
			title="Providers"
		>
			{providers.length === 0 ? (
				<SettingsCard className="text-center text-muted-foreground text-sm">
					No providers reported.
				</SettingsCard>
			) : (
				<SettingsGroup>
					{providers.map((name) => {
						const health = healthMap[name];
						return (
							<SettingsItem
								actions={
									<span className="flex items-center gap-2 text-muted-foreground text-xs tabular-nums">
										<span>{formatNumber(requestCounts[name] ?? 0)} req</span>
										{(errorCounts[name] ?? 0) > 0 ? (
											<Badge variant="destructive">
												{formatNumber(errorCounts[name] ?? 0)} err
											</Badge>
										) : null}
										<Badge variant={circuitBadgeVariant(health)}>
											{circuitBadgeLabel(health)}
										</Badge>
									</span>
								}
								key={name}
								title={name}
							/>
						);
					})}
				</SettingsGroup>
			)}
		</SettingsSection>
	);
}

// ── Gateway API-keys management surface (Unit U102) ─────────────────────────
//
// Lists the gateway's configured API keys (name + masked prefix) and whether
// auth is required. Never renders a plaintext key — the gateway redacts all key
// values to "***" in GET /v1/config responses. The "Manage in web" action deep-
// links to the web org gateway-keys page (built by WB4 / #94).

/**
 * Derive a display-safe prefix from a redacted key value.
 * The gateway always returns "***" for the key field; we show the key name
 * and a fixed masked placeholder so users can confirm their key is registered.
 */
function maskedKeyPrefix(name: string): string {
	const prefix = name.slice(0, 6).padEnd(6, "*");
	return `${prefix}···`;
}

function GatewayKeysCard({
	target,
	reachable,
}: {
	target: ApiTarget;
	reachable: boolean;
}) {
	const [authConfig, setAuthConfig] = useState<GatewayAuthConfig | null>(null);
	const [loading, setLoading] = useState(false);
	const [loadError, setLoadError] = useState<string | null>(null);

	useEffect(() => {
		if (!reachable || authConfig !== null) {
			return;
		}
		let cancelled = false;
		setLoading(true);
		fetchGatewayConfig(target)
			.then((cfg) => {
				if (!cancelled) {
					setAuthConfig(cfg.auth);
					setLoadError(null);
				}
			})
			.catch((e) => {
				if (!cancelled) {
					setLoadError(
						e instanceof Error ? e.message : "Failed to load auth config"
					);
				}
			})
			.finally(() => {
				if (!cancelled) {
					setLoading(false);
				}
			});
		return () => {
			cancelled = true;
		};
	}, [reachable, authConfig, target]);

	const handleManageInWeb = () => {
		openExternal(`${WEB_URL}/organizations`).catch(() => undefined);
	};

	const keys = authConfig?.api_keys ?? [];
	const requireAuth = authConfig?.require_auth ?? false;

	return (
		<SettingsSection
			caption="Issue or revoke keys in Console on the web. Plaintext values are shown only at creation time and never stored in the desktop."
			headerAction={
				<Button onClick={handleManageInWeb} size="sm" variant="ghost">
					<HugeiconsIcon className="size-4" icon={Share08Icon} />
					Manage in web
				</Button>
			}
			title="Gateway keys"
		>
			{reachable && loading ? (
				<SettingsCard>
					<SkeletonRows label="Loading…" spacing="panel" />
				</SettingsCard>
			) : null}
			{reachable && !loading && loadError ? (
				<SettingsCard className="text-muted-foreground text-sm">
					<span title={loadError}>Couldn't load the gateway's API keys.</span>
				</SettingsCard>
			) : null}
			{reachable && !(loading || loadError) ? (
				<>
					{requireAuth ? null : (
						<SettingsCard className="flex items-start gap-2 text-sm text-status-warning">
							<HugeiconsIcon
								className="mt-0.5 size-4 shrink-0"
								icon={Shield01Icon}
							/>
							<span>
								<span className="font-medium">Auth disabled.</span> The gateway
								accepts requests without an API key. Enable{" "}
								<span className="font-mono">require_auth</span> in the gateway
								config or via the web org settings to require authentication.
							</span>
						</SettingsCard>
					)}

					{keys.length === 0 ? (
						<SettingsCard className="text-center text-muted-foreground text-sm">
							No API keys configured. Use the web org settings to issue keys.
						</SettingsCard>
					) : (
						<SettingsGroup>
							{keys.map((k) => (
								<SettingsItem
									actions={
										<div className="flex items-center gap-2">
											<span className="font-mono text-muted-foreground text-xs">
												{maskedKeyPrefix(k.name)}
											</span>
											{k.trusted_forwarder ? (
												<Badge variant="secondary">trusted forwarder</Badge>
											) : null}
											{k.org_id ? (
												<Badge typography="code" variant="secondary">
													org
												</Badge>
											) : null}
										</div>
									}
									key={k.name}
									title={k.name}
								/>
							))}
						</SettingsGroup>
					)}
				</>
			) : null}
			{reachable ? null : (
				<SettingsCard className="text-center text-muted-foreground text-sm">
					Gateway unreachable, so the key list is unavailable. Start the gateway
					and refresh.
				</SettingsCard>
			)}
		</SettingsSection>
	);
}

// ── BYOK provider-key vault (Unit U026) ─────────────────────────────────────

/**
 * Banner atop the Keys section on a managed node, explaining why every key card
 * is read-only. Copy only — no action, since editing is deliberately unavailable.
 */
function ManagedKeysBanner() {
	return (
		<SettingsCard className="flex items-start gap-2 text-muted-foreground text-sm">
			<HugeiconsIcon
				className="mt-0.5 size-4 shrink-0"
				icon={SquareLock01Icon}
			/>
			<span>
				<span className="font-medium text-foreground">Ryu Cloud computer.</span>{" "}
				Provider keys are held securely server-side by Ryu Cloud and can't be
				changed from the desktop.
			</span>
		</SettingsCard>
	);
}

/**
 * Composio API key, surfaced here in Gateway → Keys alongside the BYOK provider
 * keys because Composio is an execution credential the gateway uses to run tool
 * actions (the gateway reads it via the `COMPOSIO_API_KEY` env Core injects). The
 * value is stored in Core preferences (`composio-api-key`) and shared with the
 * browse path (catalog + Marketplace → Connections), so saving here is identical
 * to the old Settings → Integrations field — only the location moved.
 */
function ComposioKeyCard({
	target,
	managed = false,
	canConfigure = true,
}: {
	target: ApiTarget;
	/** Managed (Ryu Cloud) node: read-only, writers no-op, no per-node fetch. */
	managed?: boolean;
	/** When false the caller lacks `gateway.configure`; writers disabled. */
	canConfigure?: boolean;
}) {
	const [input, setInput] = useState("");
	const [isSet, setIsSet] = useState(false);
	const [loaded, setLoaded] = useState(false);
	const [saving, setSaving] = useState(false);
	const [showKey, setShowKey] = useState(false);
	const [rowError, setRowError] = useState<string | null>(null);

	useEffect(() => {
		// A managed node holds no keys locally (WS1); the fetch would report a
		// misleading "No key", so skip it and let the read-only note be the state.
		if (managed) {
			return;
		}
		let active = true;
		getComposioApiKey(target)
			.then((key) => {
				if (active) {
					setIsSet(Boolean(key));
					setLoaded(true);
				}
			})
			.catch(() => {
				if (active) {
					setLoaded(true);
				}
			});
		return () => {
			active = false;
		};
	}, [target, managed]);

	const handleSave = async () => {
		// Security gate (WS4): never POST a personal key to the shared fleet.
		// Also blocked when the caller lacks `gateway.configure` (RBAC).
		if (managed || canConfigure === false) {
			return;
		}
		const trimmed = input.trim();
		if (!trimmed) {
			return;
		}
		setSaving(true);
		setRowError(null);
		try {
			const ok = await setComposioApiKey(target, trimmed);
			if (ok) {
				setIsSet(true);
				setInput("");
			} else {
				setRowError("Failed to save key");
			}
		} catch (e) {
			setRowError(e instanceof Error ? e.message : "Failed to save key");
		} finally {
			setSaving(false);
		}
	};

	const handleClear = async () => {
		if (managed) {
			return;
		}
		setSaving(true);
		setRowError(null);
		try {
			const ok = await setComposioApiKey(target, "");
			if (ok) {
				setIsSet(false);
				setInput("");
			} else {
				setRowError("Failed to clear key");
			}
		} catch (e) {
			setRowError(e instanceof Error ? e.message : "Failed to clear key");
		} finally {
			setSaving(false);
		}
	};

	return (
		<SettingsSection
			caption="Connect agents to Gmail, GitHub, Slack, and 800+ apps. The gateway runs the actions; browse and connect accounts in Marketplace → Connections. Stored locally and sent only to Composio."
			title="Composio"
		>
			<SettingsGroup>
				<SettingsItem
					actions={
						<div className="flex items-center gap-2">
							{managed ? (
								<Badge variant="secondary">Ryu Cloud</Badge>
							) : isSet ? (
								<Badge variant="default">Key set</Badge>
							) : (
								<Badge variant="secondary">No key</Badge>
							)}
							{!managed && isSet && (
								<Button
									loading={saving}
									onClick={() => handleClear()}
									size="sm"
									variant="ghost"
								>
									{!saving && (
										<HugeiconsIcon className="size-3" icon={Delete01Icon} />
									)}
									Clear
								</Button>
							)}
						</div>
					}
					title={
						<span className="flex items-center gap-2">
							<HugeiconsIcon
								className="size-4 text-muted-foreground"
								icon={Key01Icon}
							/>
							API key
						</span>
					}
				>
					{managed ? (
						<ManagedKeyNote />
					) : (
						<div className="flex w-full items-center gap-2">
							<div className="relative flex-1">
								<Input
									disabled={!loaded}
									onChange={(e) => setInput(e.target.value)}
									onKeyDown={(e) => {
										if (e.key === "Enter") {
											handleSave();
										}
									}}
									placeholder={
										isSet ? "•••••••• (leave blank to keep current)" : "comp_…"
									}
									trailingAdornment="compact"
									type={showKey ? "text" : "password"}
									value={input}
								/>
								<button
									aria-label={showKey ? "Hide key" : "Show key"}
									className="absolute top-1/2 right-2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
									onClick={() => setShowKey((v) => !v)}
									type="button"
								>
									{showKey ? (
										<HugeiconsIcon className="size-4" icon={ViewOffSlashIcon} />
									) : (
										<HugeiconsIcon className="size-4" icon={EyeIcon} />
									)}
								</button>
							</div>
							<Button
								disabled={!(loaded && input.trim()) || canConfigure === false}
								loading={saving}
								onClick={() => handleSave()}
								size="sm"
							>
								Save
							</Button>
						</div>
					)}
					{rowError ? (
						<p className="text-status-destructive text-xs">{rowError}</p>
					) : null}
				</SettingsItem>
			</SettingsGroup>
		</SettingsSection>
	);
}

/**
 * Cloud media provider (Replicate / Fal) BYOK key card. Mirrors
 * {@link ComposioKeyCard}: the key is a Core preference that Core mirrors into
 * its resolver and injects into the gateway (`REPLICATE_API_KEY` / `FAL_API_KEY`)
 * on save, activating the provider's image/video generation.
 */
function MediaKeyCard({
	target,
	label,
	caption,
	placeholder,
	getKey,
	saveKey,
	managed = false,
	canConfigure = true,
}: {
	target: ApiTarget;
	label: string;
	caption: string;
	placeholder: string;
	getKey: (t: ApiTarget) => Promise<string>;
	saveKey: (t: ApiTarget, key: string) => Promise<boolean>;
	/** Managed (Ryu Cloud) node: read-only, writers no-op, no per-node fetch. */
	managed?: boolean;
	/** When false the caller lacks `gateway.configure`; writers disabled. */
	canConfigure?: boolean;
}) {
	const [input, setInput] = useState("");
	const [isSet, setIsSet] = useState(false);
	const [loaded, setLoaded] = useState(false);
	const [saving, setSaving] = useState(false);
	const [showKey, setShowKey] = useState(false);
	const [rowError, setRowError] = useState<string | null>(null);

	useEffect(() => {
		// A managed node holds no keys locally (WS1); skip the fetch so the card
		// doesn't report a misleading "No key" for a fleet-held key.
		if (managed) {
			return;
		}
		let active = true;
		getKey(target)
			.then((key) => {
				if (active) {
					setIsSet(Boolean(key));
					setLoaded(true);
				}
			})
			.catch(() => {
				if (active) {
					setLoaded(true);
				}
			});
		return () => {
			active = false;
		};
	}, [target, getKey, managed]);

	const handleSave = async () => {
		// Security gate (WS4): never POST a personal key to the shared fleet.
		// Also blocked when the caller lacks `gateway.configure` (RBAC).
		if (managed || canConfigure === false) {
			return;
		}
		const trimmed = input.trim();
		if (!trimmed) {
			return;
		}
		setSaving(true);
		setRowError(null);
		try {
			const ok = await saveKey(target, trimmed);
			if (ok) {
				setIsSet(true);
				setInput("");
			} else {
				setRowError("Failed to save key");
			}
		} catch (e) {
			setRowError(e instanceof Error ? e.message : "Failed to save key");
		} finally {
			setSaving(false);
		}
	};

	const handleClear = async () => {
		if (managed) {
			return;
		}
		setSaving(true);
		setRowError(null);
		try {
			const ok = await saveKey(target, "");
			if (ok) {
				setIsSet(false);
				setInput("");
			} else {
				setRowError("Failed to clear key");
			}
		} catch (e) {
			setRowError(e instanceof Error ? e.message : "Failed to clear key");
		} finally {
			setSaving(false);
		}
	};

	return (
		<SettingsSection caption={caption} title={label}>
			<SettingsGroup>
				<SettingsItem
					actions={
						<div className="flex items-center gap-2">
							{managed ? (
								<Badge variant="secondary">Ryu Cloud</Badge>
							) : isSet ? (
								<Badge variant="default">Key set</Badge>
							) : (
								<Badge variant="secondary">No key</Badge>
							)}
							{!managed && isSet && (
								<Button
									loading={saving}
									onClick={() => handleClear()}
									size="sm"
									variant="ghost"
								>
									{!saving && (
										<HugeiconsIcon className="size-3" icon={Delete01Icon} />
									)}
									Clear
								</Button>
							)}
						</div>
					}
					title={
						<span className="flex items-center gap-2">
							<HugeiconsIcon
								className="size-4 text-muted-foreground"
								icon={Key01Icon}
							/>
							API key
						</span>
					}
				>
					{managed ? (
						<ManagedKeyNote />
					) : (
						<div className="flex w-full items-center gap-2">
							<div className="relative flex-1">
								<Input
									disabled={!loaded}
									onChange={(e) => setInput(e.target.value)}
									onKeyDown={(e) => {
										if (e.key === "Enter") {
											handleSave();
										}
									}}
									placeholder={
										isSet
											? "•••••••• (leave blank to keep current)"
											: placeholder
									}
									trailingAdornment="compact"
									type={showKey ? "text" : "password"}
									value={input}
								/>
								<button
									aria-label={showKey ? "Hide key" : "Show key"}
									className="absolute top-1/2 right-2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
									onClick={() => setShowKey((v) => !v)}
									type="button"
								>
									{showKey ? (
										<HugeiconsIcon className="size-4" icon={ViewOffSlashIcon} />
									) : (
										<HugeiconsIcon className="size-4" icon={EyeIcon} />
									)}
								</button>
							</div>
							<Button
								disabled={!(loaded && input.trim()) || canConfigure === false}
								loading={saving}
								onClick={() => handleSave()}
								size="sm"
							>
								Save
							</Button>
						</div>
					)}
					{rowError ? (
						<p className="text-status-destructive text-xs">{rowError}</p>
					) : null}
				</SettingsItem>
			</SettingsGroup>
		</SettingsSection>
	);
}

const ACTION_LABELS = {
	notify: "Notify",
	downgrade: "Downgrade",
	restrict: "Restrict",
	stop: "Stop (402)",
} satisfies Record<BudgetAction, string>;

const ACTION_DESCRIPTIONS = {
	notify: "Allow but flag in metrics",
	downgrade: "Switch to a cheaper model",
	restrict: "Cap max_tokens and strip tools",
	stop: "Reject with 402 budget_exceeded",
} satisfies Record<BudgetAction, string>;

// ── Alert tier copy (shared by the budget dialogs and the guardrails card) ────
//
// ONE source for the wording, in two maps: a short name (for a locked-field
// summary or an "Inherit (…)" label) and a clause saying what the tier actually
// delivers. Every option list below is derived from them, so the four tiers
// cannot end up described one way in Budgets and another in Safety filters.
//
// The clauses are Core's behaviour, read out of the one function that turns a tier
// into sinks: `dispatch` in `apps/core/src/policy_alerts/mod.rs`. `email` sends to
// the node's email recipients INSTEAD OF the webhook/Telegram/push targets, because
// Core's tier match arms are exclusive. The gateway's `AlertTier` doc used to claim
// "fan out AND send email" — it has since been corrected and now agrees, but read
// `dispatch` rather than either comment if this copy ever needs changing.

/** Short tier names, for inline summaries. */
const ALERT_TIER_LABELS = {
	silent: "Silent",
	warn: "Warn",
	fanout: "Fanout",
	email: "Email",
} satisfies Record<GatewayAlertTier, string>;

/** What each tier delivers, as a mid-sentence clause. */
const ALERT_TIER_DESCRIPTIONS = {
	silent: "No notification (default)",
	warn: "In-app notification only",
	fanout: "Webhook, Telegram, and mobile push",
	email: "Email recipients only (instead of the fan-out channels)",
} satisfies Record<GatewayAlertTier, string>;

/** `Label — clause` options, ascending in severity (the Rust `Ord` order). */
const ALERT_TIER_OPTIONS: { value: GatewayAlertTier; label: string }[] =
	ALERT_TIERS.map((tier) => ({
		value: tier,
		label: `${ALERT_TIER_LABELS[tier]} — ${ALERT_TIER_DESCRIPTIONS[tier]}`,
	}));

/**
 * The dependency this control cannot satisfy on its own, said once and reused by
 * both surfaces: the tier chooses a delivery CHANNEL, and the channel's targets
 * (SMTP transport, recipients, webhook/Telegram/push) are node settings edited on
 * the "Email & alerts" pane. Raising the tier with no targets configured delivers
 * nothing beyond the in-app notification.
 */
const ALERT_TIER_TARGETS_NOTE =
	"Anything above Silent needs delivery targets: Fanout uses this node's webhook / Telegram / push targets, Email its recipient list. Both are configured under Email & alerts.";

interface BudgetFormState {
	action: BudgetAction;
	agentId: string;
	/** Notification tier for this rule. Round-trips, so an edit cannot demote it. */
	alert: GatewayAlertTier;
	downgrade_to: string;
	include: BudgetChargeInclusion;
	limitUsd: string;
	restrict_max_tokens: string;
}

const DEFAULT_FORM: BudgetFormState = {
	agentId: "",
	include: { ...DEFAULT_BUDGET_INCLUSION },
	limitUsd: "1.00",
	action: "notify",
	alert: "silent",
	downgrade_to: "",
	restrict_max_tokens: "256",
};

/**
 * The single form → wire mapping for budget rules. Was duplicated verbatim in
 * `BudgetsCard` and `BudgetScopeSection`; both copies built a fresh literal that
 * carried only limit/action/downgrade_to/restrict_max_tokens, so every save
 * dropped the rule's `alert` tier (and `PUT /v1/config` replaces the whole
 * `BudgetConfig`, so "dropped" meant "reset to silent"). Numeric/trim handling
 * lives in {@link buildBudgetRule} so it is unit-testable without React.
 */
function formToRule(form: BudgetFormState): BudgetRule {
	return buildBudgetRule({
		limit: budgetUsdToMicroUsd(form.limitUsd) ?? 0,
		action: form.action,
		alert: form.alert,
		downgradeTo: form.downgrade_to,
		include: form.include,
		restrictMaxTokens: form.restrict_max_tokens,
	});
}

/**
 * Inherit-free tier Select, used by both budget dialogs. Kept next to the copy
 * maps so a new tier only has to be added to {@link ALERT_TIERS}.
 */
function AlertTierSelect({
	id,
	value,
	onChange,
}: {
	id: string;
	value: GatewayAlertTier;
	onChange: (next: GatewayAlertTier) => void;
}) {
	// No `disabled` prop: both call sites are inside a budget editor whose other
	// selects (`budget-action`, `session-budget-action`) are always enabled too —
	// the permission gate on those surfaces is on the Save button, not the fields.
	return (
		<Select
			items={ALERT_TIER_OPTIONS}
			onValueChange={(v) => {
				if (v) {
					onChange(v);
				}
			}}
			value={value}
		>
			<SelectTrigger id={id}>
				<SelectValue />
			</SelectTrigger>
			<SelectContent>
				{ALERT_TIER_OPTIONS.map((opt) => (
					<SelectItem key={opt.value} value={opt.value}>
						<span className="font-medium">{ALERT_TIER_LABELS[opt.value]}</span>
						<span className="ml-1 text-muted-foreground text-xs">
							— {ALERT_TIER_DESCRIPTIONS[opt.value]}
						</span>
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
}

function BudgetRuleDialog({
	trigger,
	title,
	description,
	initial,
	agentIdReadOnly,
	agents,
	target,
	idLabel = "Agent ID",
	idPlaceholder = "e.g. claude or my-agent",
	idRequiredError = "Agent ID is required.",
	onSave,
}: {
	trigger: ReactElement;
	title: string;
	description: string;
	initial?: BudgetFormState;
	agentIdReadOnly?: boolean;
	agents?: AgentSummary[];
	/** Node target — powers the "Downgrade to model" catalog picker. */
	target: ApiTarget;
	/** Field label for the identity input (e.g. "Agent ID" or "User ID"). */
	idLabel?: string;
	/** Placeholder for the free-text identity input. */
	idPlaceholder?: string;
	/** Validation message when the identity is left blank. */
	idRequiredError?: string;
	onSave: (form: BudgetFormState) => Promise<void>;
}) {
	const [open, setOpen] = useState(false);
	const [form, setForm] = useState<BudgetFormState>(initial ?? DEFAULT_FORM);
	const [saving, setSaving] = useState(false);
	const [err, setErr] = useState<string | null>(null);

	const handleOpenChange = (next: boolean) => {
		if (next) {
			setForm(initial ?? DEFAULT_FORM);
			setErr(null);
		}
		setOpen(next);
	};

	const handleSave = async () => {
		if (!form.agentId.trim()) {
			setErr(idRequiredError);
			return;
		}
		if (budgetUsdToMicroUsd(form.limitUsd) === null) {
			setErr("Spend cap must be a non-negative USD amount (up to 6 decimals).");
			return;
		}
		if (form.action === "restrict") {
			const maxTokens = Number(form.restrict_max_tokens.trim());
			if (!Number.isSafeInteger(maxTokens) || maxTokens < 1) {
				setErr("Max tokens cap must be a positive whole number.");
				return;
			}
		}
		setSaving(true);
		setErr(null);
		try {
			await onSave(form);
			setOpen(false);
		} catch (e) {
			setErr(e instanceof Error ? e.message : "Failed to save budget rule.");
		} finally {
			setSaving(false);
		}
	};

	return (
		<Dialog onOpenChange={handleOpenChange} open={open}>
			<DialogTrigger render={trigger} />
			<DialogContent>
				<DialogHeader>
					<DialogTitle>{title}</DialogTitle>
					<DialogDescription>{description}</DialogDescription>
				</DialogHeader>
				<div className="flex flex-col gap-4 py-2">
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="budget-agent-id">{idLabel}</Label>
						{!agentIdReadOnly && agents && agents.length > 0 ? (
							<Select
								items={agents.map((a) => ({ value: a.id, label: a.name }))}
								onValueChange={(v) =>
									v && setForm((f) => ({ ...f, agentId: v }))
								}
								value={form.agentId}
							>
								<SelectTrigger id="budget-agent-id">
									<SelectValue placeholder="Select an agent" />
								</SelectTrigger>
								<SelectContent>
									{agents.map((a) => (
										<SelectItem key={a.id} value={a.id}>
											<span className="font-medium">{a.name}</span>
											<span className="ml-1 text-muted-foreground text-xs">
												— {a.id}
											</span>
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						) : (
							<Input
								disabled={agentIdReadOnly}
								id="budget-agent-id"
								onChange={(e) =>
									setForm((f) => ({ ...f, agentId: e.target.value }))
								}
								placeholder={idPlaceholder}
								value={form.agentId}
							/>
						)}
					</div>
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="budget-limit">Spend cap (USD)</Label>
						<Input
							id="budget-limit"
							min={0}
							onChange={(e) =>
								setForm((f) => ({ ...f, limitUsd: e.target.value }))
							}
							placeholder="1.00"
							step="0.000001"
							type="number"
							value={form.limitUsd}
						/>
						<p className="text-muted-foreground text-xs">
							Lifetime charged spend. 0 = unlimited. The Gateway stores this as
							micro-USD.
						</p>
					</div>
					<BudgetChargeInclusionFields
						idPrefix="budget-include"
						onChange={(include) => setForm((f) => ({ ...f, include }))}
						value={form.include}
					/>
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="budget-action">
							Action when spend cap is reached
						</Label>
						<Select
							items={ACTION_LABELS}
							onValueChange={(v) => v && setForm((f) => ({ ...f, action: v }))}
							value={form.action}
						>
							<SelectTrigger id="budget-action">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{
									/* SAFETY: This authored complete string-label map is checked against its closed native domain key union; Object.entries returns its own keys but erases their literal-key types. */ (
										Object.entries(ACTION_LABELS) as [BudgetAction, string][]
									).map(([val, label]) => (
										<SelectItem key={val} value={val}>
											<span className="font-medium">{label}</span>
											<span className="ml-1 text-muted-foreground text-xs">
												— {ACTION_DESCRIPTIONS[val]}
											</span>
										</SelectItem>
									))
								}
							</SelectContent>
						</Select>
					</div>
					{form.action === "downgrade" ? (
						<div className="flex flex-col gap-1.5">
							<Label htmlFor="budget-downgrade-to">Downgrade to model</Label>
							<AgentModelPickerField
								ariaLabel="Downgrade to model"
								mode="model"
								onChange={(next) =>
									setForm((f) => ({ ...f, downgrade_to: next }))
								}
								placeholder="e.g. gpt-4o-mini"
								target={target}
								value={form.downgrade_to}
							/>
							<p className="text-muted-foreground text-xs">
								Model to route to when the budget is exhausted. Falls back to
								Restrict if left empty.
							</p>
						</div>
					) : null}
					{form.action === "restrict" ? (
						<div className="flex flex-col gap-1.5">
							<Label htmlFor="budget-restrict-max">Max tokens cap</Label>
							<Input
								id="budget-restrict-max"
								min={1}
								onChange={(e) =>
									setForm((f) => ({
										...f,
										restrict_max_tokens: e.target.value,
									}))
								}
								placeholder="256"
								type="number"
								value={form.restrict_max_tokens}
							/>
						</div>
					) : null}
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="budget-alert">Notify when this rule fires</Label>
						<AlertTierSelect
							id="budget-alert"
							onChange={(next) => setForm((f) => ({ ...f, alert: next }))}
							value={form.alert}
						/>
						<p className="text-muted-foreground text-xs">
							{ALERT_TIER_TARGETS_NOTE}
						</p>
					</div>
					{err ? (
						<p className="text-sm text-status-destructive" role="alert">
							{err}
						</p>
					) : null}
				</div>
				<DialogFooter>
					<Button
						disabled={saving}
						onClick={() => setOpen(false)}
						variant="ghost"
					>
						Cancel
					</Button>
					<Button loading={saving} onClick={() => handleSave()}>
						Save
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

// ── RoutingCard ───────────────────────────────────────────────────────────────

const PROVIDER_LABELS = {
	openai: "OpenAI",
	anthropic: "Anthropic",
	local: "Local",
	openrouter: "OpenRouter",
	core: "Core",
	genai: "Gemini",
	mistral: "Mistral",
	huggingface: "Hugging Face",
	nvidia: "NVIDIA NIM",
	together: "Together AI",
	fireworks: "Fireworks AI",
} satisfies Record<ProviderKind, string>;

const NON_CHAT_POOL_PROVIDERS = new Set([
	"classify",
	"voyage",
	"jina",
	"cohere",
	"deepgram",
	"elevenlabs",
	"inworld",
	"fal",
	"replicate",
]);

interface ModelMappingFormState {
	model: string;
	provider: string;
	provider_model: string;
}

function mappingFromForm(form: ModelMappingFormState): ModelMapping {
	const providerModel = form.provider.startsWith("pool:")
		? ""
		: form.provider_model.trim();
	const mapping: ModelMapping = { provider: form.provider };
	if (providerModel) {
		mapping.provider_model = providerModel;
	}
	return mapping;
}

const DEFAULT_MAPPING_FORM: ModelMappingFormState = {
	model: "",
	provider: "openai",
	provider_model: "",
};

function ModelMappingDialog({
	trigger,
	title,
	description,
	initial,
	modelReadOnly,
	providers,
	onSave,
}: {
	trigger: ReactElement;
	title: string;
	description: string;
	initial?: ModelMappingFormState;
	modelReadOnly?: boolean;
	providers: string[];
	onSave: (form: ModelMappingFormState) => Promise<void>;
}) {
	const [open, setOpen] = useState(false);
	const [form, setForm] = useState<ModelMappingFormState>(
		initial ?? DEFAULT_MAPPING_FORM
	);
	const [saving, setSaving] = useState(false);
	const [err, setErr] = useState<string | null>(null);

	const handleOpenChange = (next: boolean) => {
		if (next) {
			setForm(initial ?? DEFAULT_MAPPING_FORM);
			setErr(null);
		}
		setOpen(next);
	};

	const handleSave = async () => {
		if (!form.model.trim()) {
			setErr("Model name is required.");
			return;
		}
		setSaving(true);
		setErr(null);
		try {
			await onSave(form);
			setOpen(false);
		} catch (e) {
			setErr(e instanceof Error ? e.message : "Failed to save mapping.");
		} finally {
			setSaving(false);
		}
	};

	return (
		<Dialog onOpenChange={handleOpenChange} open={open}>
			<DialogTrigger render={trigger} />
			<DialogContent>
				<DialogHeader>
					<DialogTitle>{title}</DialogTitle>
					<DialogDescription>{description}</DialogDescription>
				</DialogHeader>
				<div className="flex flex-col gap-4 py-2">
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="mapping-model">Model name (request)</Label>
						<Input
							disabled={modelReadOnly}
							id="mapping-model"
							onChange={(e) =>
								setForm((f) => ({ ...f, model: e.target.value }))
							}
							placeholder="e.g. gpt-4 or openrouter/auto"
							value={form.model}
						/>
						<p className="text-muted-foreground text-xs">
							Exact or prefix match against the model name in the request. Use{" "}
							<span className="font-mono">openrouter/auto</span> for general
							requests, or{" "}
							<span className="font-mono">openrouter/pareto-code</span> for
							coding-focused selection.
						</p>
					</div>
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="mapping-provider">Provider</Label>
						<Select
							items={providers.map((p) => ({
								value: p,
								label: modalityProviderLabel(p),
							}))}
							onValueChange={(v) =>
								v && setForm((f) => ({ ...f, provider: v }))
							}
							value={form.provider}
						>
							<SelectTrigger id="mapping-provider">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{providers.map((p) => (
									<SelectItem key={p} value={p}>
										{modalityProviderLabel(p)}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</div>
					{form.provider.startsWith("pool:") ? (
						<p className="text-muted-foreground text-xs">
							Each pool member uses the exact upstream model saved in that pool.
						</p>
					) : (
						<div className="flex flex-col gap-1.5">
							<Label htmlFor="mapping-provider-model">
								Provider model name (optional)
							</Label>
							<Input
								id="mapping-provider-model"
								onChange={(e) =>
									setForm((f) => ({
										...f,
										provider_model: e.target.value,
									}))
								}
								placeholder="e.g. gpt-4o (leave blank to keep original)"
								value={form.provider_model}
							/>
							<p className="text-muted-foreground text-xs">
								Rewrite the model name when forwarding to the provider.
							</p>
						</div>
					)}
					{err ? (
						<p className="text-sm text-status-destructive">{err}</p>
					) : null}
				</div>
				<DialogFooter>
					<Button
						disabled={saving}
						onClick={() => setOpen(false)}
						variant="ghost"
					>
						Cancel
					</Button>
					<Button loading={saving} onClick={() => handleSave()}>
						Save
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

// ── Modality routing ─────────────────────────────────────────────────────────

/**
 * Display names for every provider id that can appear in `routing.modality_map`,
 * which is a strictly WIDER set than {@link PROVIDER_LABELS}.
 *
 * `PROVIDER_LABELS` is `Record<ProviderKind, string>`, and `ProviderKind` covers
 * only the chat-capable passthroughs. The media providers registered in
 * `apps/gateway/src/providers/mod.rs` — `modal`, `replicate`, `fal` — plus the
 * `classify` tier alias are NOT in that union, so the model-map editor's
 * `configuredProviders.filter((p) => p in PROVIDER_LABELS)` drops them. Reusing
 * that filtered list here would have left the modality editor unable to select
 * the exact three providers the modality map exists to select. Unknown ids fall
 * through to the raw id rather than being hidden.
 *
 * DELIBERATE DIVERGENCE from the model-map rows directly above, so nobody
 * "tidies" the two back together: those rows filter, these do not. `provider` in
 * `ModalityMapping` is an open `ProviderId`, and this editor offers whatever
 * `available_providers()` reports. One visible consequence is `classify`, which
 * IS registered on every Core-spawned gateway (Core publishes
 * `RYU_CLASSIFY_LLM_URL` unconditionally) and so appears in this dropdown while
 * the model-map dropdown hides it. Offering it is honest — the gateway would
 * accept it — and hardcoding a media-only allowlist here is exactly the closed
 * list that broke `fal`/`replicate`/`modal` in the first place.
 */
const MODALITY_PROVIDER_LABELS = new Map<string, string>(
	Object.entries({
		...PROVIDER_LABELS,
		modal: "Modal",
		replicate: "Replicate",
		fal: "fal.ai",
		classify: "Classify tier",
		kiro: "Kiro",
		// Credit-pool providers: the Gateway registers these as ALIASES over the
		// OpenAI / Anthropic impls (`register_as` in `apps/gateway/src/providers/mod.rs`),
		// so they carry their own ids and belong here like any other selectable
		// provider. They are named for what an operator configured, not for the impl
		// underneath — an operator who set up a segregated Bedrock pool must not see
		// it presented as "Anthropic".
		cloudflare: "Cloudflare Workers AI",
		bedrock: "Amazon Bedrock",
		vertex: "Google Vertex AI",
		// The donated OpenAI allowance is its own id so its spend is never mixed
		// with the operator's own `openai` key; its label keeps the two apart too.
		"openai-credits": "OpenAI (donated credits)",
		voyage: "Voyage AI",
		jina: "Jina AI",
		cohere: "Cohere",
		deepgram: "Deepgram",
		assemblyai: "AssemblyAI",
		elevenlabs: "ElevenLabs",
		inworld: "Inworld",
		qwen: "Qwen",
	})
);

function modalityProviderLabel(id: string): string {
	if (id.startsWith("pool:")) {
		return `Pool · ${id.slice(5)}`;
	}
	return MODALITY_PROVIDER_LABELS.get(id) ?? id;
}

/**
 * Row copy for each `Modality` variant. Keyed by the enum's wire form, so a
 * variant added on the Rust side surfaces here as a type error rather than as a
 * quietly missing row.
 */
const MODALITY_COPY = {
	chat: {
		label: "Chat",
		note: "Rarely reached. Ordinary chat is routed by the model map above, not by this row. The router only consults the chat entry for an agent that carries a per-agent chat MODEL slot and no provider slot; with a provider slot set, that slot wins outright.",
	},
	image: {
		label: "Image generation",
		note: "Used by POST /v1/images/generations.",
	},
	tts: {
		label: "Audio",
		note: "Used by POST /v1/audio/speech.",
	},
	stt: {
		label: "Voice Recognition",
		note: "Used by POST /v1/audio/transcriptions.",
	},
	video: {
		label: "Video generation",
		note: "Used by POST /v1/videos/generations. It is job-based, so the client polls for the result.",
	},
	audio: {
		label: "Music and sound effects",
		note: "Used by POST /v1/audio/generations. It is job-based like video; speech from text stays on the Audio row.",
	},
} satisfies Record<Modality, { label: string; note: string }>;

interface ModalityMappingFormState {
	model: string;
	provider: string;
}

/**
 * Add/edit dialog for one modality row. Deliberately the same shape as
 * {@link ModelMappingDialog} — provider select, optional model override,
 * validate-on-save, inline error — so the two editors in this card read as one
 * mechanism. Only the two differences the wire format forces: the modality is
 * fixed (it is the map KEY, not a free-text field), and `providers` is
 * `string[]` because `ModalityMapping.provider` is an open `ProviderId`.
 */
function ModalityMappingDialog({
	trigger,
	modality,
	initial,
	providers,
	onSave,
}: {
	trigger: ReactElement;
	modality: Modality;
	initial: ModalityMappingFormState;
	/** Selectable provider ids: those this node reports, plus the stored one. */
	providers: string[];
	onSave: (form: ModalityMappingFormState) => Promise<void>;
}) {
	const [open, setOpen] = useState(false);
	const [form, setForm] = useState<ModalityMappingFormState>(initial);
	const [saving, setSaving] = useState(false);
	const [err, setErr] = useState<string | null>(null);

	const handleOpenChange = (next: boolean) => {
		if (next) {
			setForm(initial);
			setErr(null);
		}
		setOpen(next);
	};

	const handleSave = async () => {
		if (!form.provider.trim()) {
			setErr("Pick a provider, or clear the row to fall back to the default.");
			return;
		}
		setSaving(true);
		setErr(null);
		try {
			await onSave(form);
			setOpen(false);
		} catch (e) {
			setErr(e instanceof Error ? e.message : "Failed to save mapping.");
		} finally {
			setSaving(false);
		}
	};

	const label = MODALITY_COPY[modality].label;

	return (
		<Dialog onOpenChange={handleOpenChange} open={open}>
			<DialogTrigger render={trigger} />
			<DialogContent>
				<DialogHeader>
					<DialogTitle>{label} routing</DialogTitle>
					<DialogDescription>
						Send {label.toLowerCase()} requests to a specific provider. Checked
						before the model map; clear the row to fall back to the default
						provider.
					</DialogDescription>
				</DialogHeader>
				<div className="flex flex-col gap-4 py-2">
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="modality-provider">Provider</Label>
						<Select
							items={providers.map((p) => ({
								value: p,
								label: modalityProviderLabel(p),
							}))}
							onValueChange={(v) =>
								v && setForm((f) => ({ ...f, provider: v }))
							}
							value={form.provider}
						>
							<SelectTrigger id="modality-provider">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{providers.map((p) => (
									<SelectItem key={p} value={p}>
										{modalityProviderLabel(p)}
									</SelectItem>
								))}
								{providers.length === 0 ? (
									<SelectItem disabled value="__none__">
										No providers configured
									</SelectItem>
								) : null}
							</SelectContent>
						</Select>
					</div>
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="modality-model">Model (optional)</Label>
						<Input
							id="modality-model"
							onChange={(e) =>
								setForm((f) => ({ ...f, model: e.target.value }))
							}
							placeholder="e.g. dall-e-3 (blank keeps the request's model)"
							value={form.model}
						/>
						<p className="text-muted-foreground text-xs">
							Pins the model sent to the provider. Left blank, the model name
							from the request is forwarded unchanged.
						</p>
					</div>
					<p className="text-muted-foreground text-xs">
						{MODALITY_COPY[modality].note}
					</p>
					{err ? (
						<p className="text-sm text-status-destructive">{err}</p>
					) : null}
				</div>
				<DialogFooter>
					<Button
						disabled={saving}
						onClick={() => setOpen(false)}
						variant="ghost"
					>
						Cancel
					</Button>
					<Button loading={saving} onClick={() => handleSave()}>
						Save
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

/** One modality row's second line: what this modality actually does today. */
function ModalityRowDescription({
	mapping,
	defaultProvider,
	configuredProviders,
}: {
	mapping: ModalityMapping | undefined;
	defaultProvider: string;
	configuredProviders: string[];
}) {
	if (!mapping) {
		// An unmapped modality is not an empty setting, it is an explicit
		// fallback — say so. This is also the gateway's own vocabulary:
		// `GET /v1/modalities` reports `"provider": "default"` for exactly this
		// state (apps/gateway/src/api/multimodal.rs).
		//
		// Deliberately NOT "falls back to <default_provider>" full stop. Step 3 of
		// `route_modality` is ordinary MODEL routing, and `RoutingTables::route`
		// tries the exact model map, then the longest user prefix, then the
		// built-in prefix table, and only then `default_provider` — so an unmapped
		// image request for `dall-e-3` can land on a built-in prefix rule and never
		// reach the default at all. Naming the default as the destination would be
		// wrong for exactly the requests most likely to hit this row.
		return (
			<span className="text-muted-foreground">
				Falls back to the default provider; strictly, to ordinary model routing,
				which lands on {modalityProviderLabel(defaultProvider)} when no model
				mapping or built-in prefix rule matches the requested model.
			</span>
		);
	}
	// An EMPTY list means "we do not know yet", not "nothing is registered": the
	// card receives `health?.providers ?? []`, so a health query that is still in
	// flight or that failed is indistinguishable from a gateway with no providers.
	// Flagging on that would put "not configured on this node" under a perfectly
	// good mapping every time the dialog opens — the same false-alarm shape the
	// `served === null` gate exists to prevent one level up.
	const unavailable =
		configuredProviders.length > 0 &&
		!configuredProviders.includes(mapping.provider);
	return (
		<>
			{modalityProviderLabel(mapping.provider)}
			{mapping.model ? ` → ${mapping.model}` : null}
			{unavailable ? (
				<span className="text-status-warning">
					{" "}
					— not configured on this node
				</span>
			) : null}
		</>
	);
}

/**
 * The six modality rows. Extracted from {@link RoutingCard} so each editor in
 * that card stays independently readable, and because the row list comes from
 * `MODALITIES` (the Rust enum's wire form) rather than from whatever happens to
 * be configured — an UNMAPPED modality has to be visible to state what it falls
 * back to.
 *
 * `served` is the load-bearing prop; see `routingViewIncludesModalityMap`. When
 * it is false there is nothing safe to render, because this app cannot
 * round-trip a field the node never sent. It is strictly two-state here: the
 * caller must not mount this component until the config has actually loaded, or
 * "not loaded yet" and "unreachable" would both render the too-old-gateway
 * warning and accuse a perfectly healthy node of being about to lose data.
 */
function ModalityRoutingRows({
	served,
	modalityMap,
	defaultProvider,
	configuredProviders,
	disabled,
	onSave,
}: {
	served: boolean;
	modalityMap: Partial<Record<Modality, ModalityMapping>>;
	defaultProvider: string;
	configuredProviders: string[];
	disabled: boolean;
	onSave: (
		modality: Modality,
		mapping: { model?: string; provider: string } | null
	) => Promise<void>;
}) {
	if (!served) {
		return (
			<SettingsCard className="text-sm text-status-warning">
				This gateway does not report its modality map, so it cannot be edited
				here, and it cannot be preserved either: saving anything in this card
				replaces the whole routing section, so a{" "}
				<span className="font-mono">[routing.modality_map]</span> written by
				hand in <span className="font-mono">gateway.toml</span> is dropped.
				Update the gateway to route image, speech, video and generated audio
				from the app.
			</SettingsCard>
		);
	}
	return (
		<SettingsGroup>
			{MODALITIES.map((modality) => {
				const mapping = modalityMap[modality];
				// Keep the stored provider selectable even when this node no longer
				// reports it (key removed, sidecar uninstalled) so opening the row
				// cannot silently re-home a working mapping onto another provider.
				const options =
					mapping && !configuredProviders.includes(mapping.provider)
						? [...configuredProviders, mapping.provider]
						: configuredProviders;
				return (
					<SettingsItem
						actions={
							<div className="flex shrink-0 items-center gap-1">
								<ModalityMappingDialog
									initial={{
										provider: mapping?.provider ?? options[0] ?? "",
										model: mapping?.model ?? "",
									}}
									modality={modality}
									onSave={(form) =>
										onSave(modality, {
											provider: form.provider,
											model: form.model,
										})
									}
									providers={options}
									trigger={
										<Button disabled={disabled} size="icon" variant="ghost">
											<HugeiconsIcon
												className="size-3.5"
												icon={mapping ? PencilEdit01Icon : Add01Icon}
											/>
											<span className="sr-only">
												{mapping ? "Edit" : "Set"}{" "}
												{MODALITY_COPY[modality].label} routing
											</span>
										</Button>
									}
								/>
								<Button
									disabled={disabled || !mapping}
									onClick={() => onSave(modality, null)}
									size="icon"
									variant="ghost"
								>
									<HugeiconsIcon
										className="size-3.5 text-status-destructive"
										icon={Delete01Icon}
									/>
									<span className="sr-only">
										Clear {MODALITY_COPY[modality].label} routing
									</span>
								</Button>
							</div>
						}
						key={modality}
						title={
							<span className="flex min-w-0 flex-col">
								<span>{MODALITY_COPY[modality].label}</span>
								<span className="text-muted-foreground text-xs">
									<ModalityRowDescription
										configuredProviders={configuredProviders}
										defaultProvider={defaultProvider}
										mapping={mapping}
									/>
								</span>
							</span>
						}
					/>
				);
			})}
		</SettingsGroup>
	);
}

/** Editing row for a smart-routing rule, with a stable client-side id for keys. */
interface RuleRow {
	description: string;
	id: string;
	model: string;
	weight: string;
}

// ── Local classify tier (shared by the two "cheap model" fields) ──────────────
//
// Both the guardrail inspector and smart routing want a small, fast, free model
// that runs per turn. Core ships one — a lazy `llama.cpp` sidecar serving Gemma
// 3 270M, exposed by the gateway as the `classify` provider — but nothing in
// this dialog used to say so, so the fields read as "type a model id and hope".
// These two pieces make the tier visible: read its live state off the node, and
// offer its model id as a one-click value. The state MACHINE (and the copy, and
// the "can this node serve it" predicates) lives in `lib/api/gateway.ts` so it is
// testable without rendering the dialog; this file only owns the polling.

/** Matches the status cadence of the app-wide `useSystemStatus` poll. */
const CLASSIFY_STATUS_POLL_MS = 5000;

/**
 * The weights either exist or they don't; nothing but an install changes that,
 * and an install is minutes of download. Polled far slower than the run state so
 * a dialog left open doesn't re-stat the model directory every 5s.
 */
const CLASSIFY_WEIGHTS_POLL_MS = 30_000;

/**
 * Live state of the classify tier on the node this dialog is configuring, from
 * two independent probes:
 *
 *  - `/api/sidecar/status` — is the sidecar registered, and is it resident?
 *    Read through the shared system API client (the same endpoint the node
 *    selector and the Store's sidecar toggles use) because the sidecar is Core's,
 *    not the gateway's, and no gateway route reports it.
 *  - `/api/models/installed` — are its WEIGHTS on disk? Registered-but-idle is
 *    the sidecar's normal resting state, so the run state alone cannot tell a
 *    lazy tier apart from one whose non-fatal onboarding download failed and
 *    which will therefore bail on every start attempt. That failure is the whole
 *    reason this row exists, and it is invisible in the run state.
 *
 * Both are keyed by node URL, so every card in this dialog shares one poll of
 * each rather than one per card.
 */
function useClassifyTier(target: ApiTarget, enabled: boolean) {
	const status = useQuery({
		enabled,
		queryKey: ["sidecar-status", target.url],
		queryFn: () => fetchSidecarStatus(target),
		refetchInterval: CLASSIFY_STATUS_POLL_MS,
	});
	const weights = useQuery({
		enabled,
		queryKey: ["classify-weights", target.url],
		queryFn: () => fetchClassifyWeightsPresent(target),
		refetchInterval: CLASSIFY_WEIGHTS_POLL_MS,
	});
	// `undefined` for either probe while pending OR on failure (an older Core has
	// no `/api/models/installed`), which keeps the row silent instead of crying
	// "not downloaded" — the derivation, not this hook, decides what that means.
	return deriveClassifyTierState({
		sidecarStatus: status.isSuccess ? status.data : undefined,
		weightsPresent: weights.isSuccess ? weights.data : undefined,
	});
}

/**
 * Badge tone per tier state: `running` reads as active, `unweighted` is the one
 * state that is a genuine fault on this node (the sidecar can never start), and
 * `idle`/`absent` are neutral facts.
 */
function classifyBadgeVariant(
	state: Exclude<ClassifyTierState, "unknown">
): "default" | "destructive" | "secondary" {
	if (state === "running") {
		return "default";
	}
	if (state === "unweighted") {
		return "destructive";
	}
	return "secondary";
}

/**
 * Status + one-click adopt row for the local classify tier, rendered under a
 * "cheap model" picker. The button only appears when this node can actually
 * serve the tier and it isn't already the selected value — offering it otherwise
 * would hand the user a model id whose call is guaranteed to fail.
 */
function ClassifyTierNote({
	disabled,
	onUse,
	state,
	value,
}: {
	disabled: boolean;
	onUse: () => void;
	state: ClassifyTierState;
	value: string;
}) {
	if (state === "unknown") {
		return null;
	}
	const copy = CLASSIFY_TIER_COPY[state];
	const servable = classifyTierServable(state);
	return (
		<div className="flex flex-wrap items-center gap-2">
			<Badge variant={classifyBadgeVariant(state)}>{copy.badge}</Badge>
			<span className="text-muted-foreground text-xs">{copy.hint}</span>
			{servable && value.trim() !== CLASSIFY_MODEL_ID ? (
				<Button
					disabled={disabled}
					onClick={onUse}
					size="sm"
					type="button"
					variant="ghost"
				>
					Use it
				</Button>
			) : null}
		</div>
	);
}

export function SmartRoutingCard({
	target,
	reachable,
	canConfigure,
}: {
	target: ApiTarget;
	reachable: boolean;
	/** When false the caller lacks `gateway.configure`; controls read-only. */
	canConfigure: boolean;
}) {
	// The app-wide "Friendly names" toggle picks which of the two vocabularies this
	// picker speaks. Read per-surface rather than threaded through props: all three
	// places that render this control now share one copy table, so each just asks.
	const [friendly] = useFriendlyMode();
	const strategyCopy = routeStrategyCopy(friendly);
	const [config, setConfig] = useState<SmartRoutingConfig | null>(null);
	const [draft, setDraft] = useState<SmartRoutingConfig | null>(null);
	const [rules, setRules] = useState<RuleRow[]>([]);
	// The pool fields are edited as typed text and parsed on save, so a trailing
	// comma or space survives the keystroke that types it.
	const [poolModels, setPoolModels] = useState("");
	const [poolProviders, setPoolProviders] = useState("");
	const [loadAttempt, setLoadAttempt] = useState(0);
	// Did this gateway actually report `routing.smart_routing`? Three-state on
	// purpose, exactly like `modalityMapServed`: `null` = not loaded yet. Folding
	// "unknown" into `false` would flash a data-loss warning at every healthy,
	// current gateway for the duration of the first fetch.
	//
	// This exists because the card cannot otherwise tell "the node says smart
	// routing is off" from "the node never mentioned smart routing". Both render
	// as a switch in the off position, but only one of them is a fact. Saving in
	// the second case WRITES that fabricated off — `put_config` replaces the
	// routing section wholesale and `RoutingConfig::smart_routing` is
	// `#[serde(default)]`, so a hand-written `[routing.smart_routing]` in
	// `gateway.toml` is silently turned off by a user who came here to change a
	// rule. `fetchGatewayConfig` no longer coalesces the field precisely so this
	// distinction survives the client; consuming it here is the other half.
	const [served, setServed] = useState<boolean | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);
	const [saveError, setSaveError] = useState<string | null>(null);
	const [saveOk, setSaveOk] = useState(false);
	// Only polled while the node answers at all — a down node would otherwise
	// retry the sidecar status every 5s behind an already-explained error.
	const classifyTier = useClassifyTier(target, reachable);

	useEffect(() => {
		if (!reachable || config !== null) {
			return;
		}
		let cancelled = false;
		fetchGatewayConfig(target)
			.then((cfg) => {
				if (cancelled) {
					return;
				}
				setServed(routingViewIncludesSmartRouting(cfg.routing));
				// The `??` stays: React Selects and Switches bound to `undefined`
				// go uncontrolled. It is now only a *rendering* stand-in — `served`
				// carries the truth, and the save path refuses to write this
				// stand-in back.
				const sr = cfg.routing.smart_routing ?? DEFAULT_SMART_ROUTING;
				setConfig(sr);
				setDraft(sr);
				setPoolModels(formatPoolList(sr.allowed_models));
				setPoolProviders(formatPoolList(sr.allowed_providers));
				setRules(
					sr.rules.map((r) => ({
						id: crypto.randomUUID(),
						description: r.description,
						model: r.model,
						weight: String(r.weight ?? 1),
					}))
				);
				setLoadError(null);
			})
			.catch((e) => {
				if (!cancelled) {
					setLoadError(
						e instanceof Error ? e.message : "Failed to load smart routing"
					);
				}
			});
		return () => {
			cancelled = true;
		};
	}, [reachable, config, target, loadAttempt]);

	const patch = (p: Partial<SmartRoutingConfig>) => {
		setDraft((prev) => (prev ? { ...prev, ...p } : prev));
		setSaveOk(false);
		setSaveError(null);
	};

	const updateRule = (
		id: string,
		field: "description" | "model" | "weight",
		value: string
	) => {
		setRules((prev) =>
			prev.map((r) => (r.id === id ? { ...r, [field]: value } : r))
		);
		setSaveOk(false);
		setSaveError(null);
	};

	const addRule = () => {
		setRules((prev) => [
			...prev,
			{ id: crypto.randomUUID(), description: "", model: "", weight: "1" },
		]);
		setSaveOk(false);
	};

	const removeRule = (id: string) => {
		setRules((prev) => prev.filter((r) => r.id !== id));
		setSaveOk(false);
		setSaveError(null);
	};

	const handleSave = async () => {
		// `served === false` is a hard refusal, not belt-and-braces behind a
		// disabled button: writing here replaces a section this app never received
		// with a fabricated default — destroying config in order to "save" it.
		// `null` (not loaded yet) is refused for the same reason.
		if (!draft || served !== true) {
			return;
		}
		// A newly added rule starts blank. Silently filtering that row in
		// `cleanRules` makes Save look successful while discarding the user's
		// unfinished target. Random routing also requires two positive-weight
		// targets to be active, so do not report a successful one-target save.
		const ruleEditorVisible =
			routerType === "random" || routerType === "llm_classifier";
		const hasInvalidRule =
			ruleEditorVisible &&
			rules.some((rule) => {
				const weight = Number(rule.weight);
				return (
					(routerType !== "random" && !rule.description.trim()) ||
					!rule.model.trim() ||
					!Number.isFinite(weight) ||
					(routerType === "random" ? weight <= 0 : weight < 0)
				);
			});
		if (hasInvalidRule) {
			setSaveError(
				"Complete or remove each incomplete rule. Classifier rules need a description and model. Random targets need a model and positive weight."
			);
			setSaveOk(false);
			return;
		}
		if (
			routerType === "random" &&
			rules.filter((rule) => {
				const weight = Number(rule.weight);
				return rule.model.trim() && Number.isFinite(weight) && weight > 0;
			}).length < 2
		) {
			setSaveError(
				"Weighted random needs at least two targets with positive weights. Add a target before saving."
			);
			setSaveOk(false);
			return;
		}
		setSaving(true);
		setSaveError(null);
		setSaveOk(false);
		try {
			// Re-fetch so the PUT carries the full routing object (preserving
			// default_provider / model_map / fallback_chain) with only the
			// smart_routing section replaced.
			const cfg = await fetchGatewayConfig(target);
			// Re-checked against the FRESH config, not the one from mount. The
			// gateway can be restarted (or swapped for an older build) between the
			// two fetches, and it is this object that is about to be written back.
			if (!routingViewIncludesSmartRouting(cfg.routing)) {
				setServed(false);
				setSaveError(
					"This gateway no longer reports its smart-routing config, so saving would overwrite it. Nothing was changed."
				);
				return;
			}
			const cleanRules = rules
				.map((r) => ({
					description: r.description.trim(),
					model: r.model.trim(),
					weight: Number(r.weight),
				}))
				.filter(
					(r) =>
						(routerType === "random" || r.description) &&
						r.model &&
						Number.isFinite(r.weight) &&
						r.weight >= 0
				);
			const defaultModel = draft.default_model?.trim();
			const escalationConfirmations = draft.escalation_confirmations;
			const smart_routing: SmartRoutingConfig = {
				...draft,
				router_type: draft.router_type ?? "llm_classifier",
				strategy: draft.strategy ?? "llm",
				classifier_model: draft.classifier_model.trim(),
				embedding_model: draft.embedding_model?.trim() ?? "",
				similarity_threshold: Number.isFinite(draft.similarity_threshold)
					? draft.similarity_threshold
					: 0.35,
				random_seed:
					draft.random_seed === null || draft.random_seed === undefined
						? null
						: Number.isSafeInteger(draft.random_seed) && draft.random_seed >= 0
							? draft.random_seed
							: null,
				stage_capable_model: draft.stage_capable_model?.trim() ?? "",
				stage_efficient_model: draft.stage_efficient_model?.trim() ?? "",
				stage_picker: draft.stage_picker ?? "capable_first",
				stage_confidence_threshold: Number.isFinite(
					draft.stage_confidence_threshold
				)
					? draft.stage_confidence_threshold
					: 0.5,
				stage_recent_message_window: Number.isInteger(
					draft.stage_recent_message_window
				)
					? draft.stage_recent_message_window
					: 3,
				escalation_weak_model: draft.escalation_weak_model?.trim() ?? "",
				escalation_strong_model: draft.escalation_strong_model?.trim() ?? "",
				escalation_judge_model: draft.escalation_judge_model?.trim() ?? "",
				escalation_confirmations:
					isNativeNumber(escalationConfirmations) &&
					Number.isInteger(escalationConfirmations) &&
					escalationConfirmations >= 1
						? escalationConfirmations
						: 2,
				escalation_recent_message_window: Number.isInteger(
					draft.escalation_recent_message_window
				)
					? draft.escalation_recent_message_window
					: 28,
				escalation_message_chars: Number.isInteger(
					draft.escalation_message_chars
				)
					? draft.escalation_message_chars
					: 500,
				rules: cleanRules,
				default_model: defaultModel ? defaultModel : null,
				allowed_models: parsePoolList(poolModels),
				allowed_providers: parsePoolList(poolProviders),
				// Agent pools and overrides are edited per agent, so take them from
				// the fresh config rather than this card's possibly stale draft.
				agent_pools:
					cfg.routing.smart_routing?.agent_pools ?? draft.agent_pools ?? {},
				agent_routes:
					cfg.routing.smart_routing?.agent_routes ?? draft.agent_routes ?? {},
			};
			const next: GatewayRoutingConfig = { ...cfg.routing, smart_routing };
			await updateGatewayConfig(target, {
				routing: next,
				expectedRevision: cfg.configRevision ?? undefined,
			});
			setConfig(smart_routing);
			setDraft(smart_routing);
			setPoolModels(formatPoolList(smart_routing.allowed_models));
			setPoolProviders(formatPoolList(smart_routing.allowed_providers));
			setRules(
				smart_routing.rules.map((rule) => ({
					id: crypto.randomUUID(),
					description: rule.description,
					model: rule.model,
					weight: String(rule.weight ?? 1),
				}))
			);
			setSaveOk(true);
			setTimeout(() => setSaveOk(false), 3000);
		} catch (e) {
			setSaveError(
				e instanceof Error ? e.message : "Failed to save smart routing"
			);
		} finally {
			setSaving(false);
		}
	};

	// `served === false` disables every control for the same reason the modality
	// rows render nothing: this app cannot round-trip a field the node never sent,
	// so an editable control here is an affordance that can only lose data.
	const isDisabled =
		!reachable || draft === null || !canConfigure || served === false;

	// Smart routing's one remaining enabled-but-broken state, plus the blank the
	// gateway now fills in for us.
	//
	//  - a blank classifier model is NO LONGER inert. `classifier_model` carries
	//    `deserialize_with = "de_classifier_model"`, which resolves a blank to the
	//    classify tier's id as the config comes off the wire — the same treatment
	//    `inspector.model` has always had. It used to be genuinely inert
	//    (`is_active` required a non-empty id), and this card's copy still said so
	//    for a while after the field changed; saying "it never runs" about a
	//    feature that now runs is the more expensive kind of wrong, because the
	//    user acts on it. It is an informational default now, not a warning.
	//  - a classifier model served only by the local classify tier on a node that
	//    cannot serve it — either no such tier at all, or (the reachable case) the
	//    tier's weights were never downloaded so its sidecar can never start. The
	//    classification call errors, and smart routing fails open by design. THIS
	//    is the one that stayed a warning, and resolving the blank made it strictly
	//    more important: a cleared box now lands on the local tier by default, so
	//    the unreachable case is easier to hit than it was.
	const classifierModel = draft?.classifier_model.trim() ?? "";
	const routerType: ModelRouterType = draft?.router_type ?? "llm_classifier";
	const smartLlm =
		draft?.enabled === true &&
		routerType === "llm_classifier" &&
		(draft.strategy ?? "llm") === "llm";
	// What the GATEWAY will actually use. `de_classifier_model` resolves a blank
	// `classifier_model` to the classify tier's id as it comes off the wire, so a
	// cleared box is not "off" — it is "the local classifier". Both the note and
	// the reachability probe below have to reason about the RESOLVED id, or a
	// cleared box silently skips the one warning that still matters.
	const classifierDefaulted = smartLlm && classifierModel === "";
	const resolvedClassifier = classifierModel || CLASSIFY_MODEL_ID;
	const classifierUnserved =
		smartLlm && classifyTierCannotServeModel(classifyTier, resolvedClassifier);
	const classifierUnservedReason =
		classifyTier === "absent" || classifyTier === "unweighted"
			? CLASSIFY_TIER_COPY[classifyTier].reason
			: null;

	return (
		<SettingsSection
			caption="Choose how Gateway selects a model for each chat request. The selected model then follows Ryu's normal provider routing, governance, budgets, and audit path."
			headerAction={
				<Button
					disabled={isDisabled}
					loading={saving}
					onClick={() => handleSave()}
					size="sm"
					variant="ghost"
				>
					Save
				</Button>
			}
			title="Smart routing"
		>
			<div className="flex flex-col gap-3">
				{reachable && loadError ? (
					<div role="alert">
						<SettingsCard className="flex flex-wrap items-center justify-between gap-3">
							<p className="min-w-0 flex-1 break-words text-muted-foreground text-sm">
								{loadError}
							</p>
							<Button
								onClick={() => {
									setLoadError(null);
									setLoadAttempt((attempt) => attempt + 1);
								}}
								size="sm"
								variant="secondary"
							>
								Retry
							</Button>
						</SettingsCard>
					</div>
				) : null}
				{reachable ? null : (
					<SettingsCard className="text-muted-foreground text-sm">
						Gateway unreachable. Start the gateway and refresh to configure
						smart routing.
					</SettingsCard>
				)}
				{served === false ? (
					<SettingsCard className="text-sm text-status-warning">
						This gateway does not report its smart-routing config, so it cannot
						be edited here, and it cannot be preserved either: saving anything
						in this card replaces the whole routing section, so a{" "}
						<span className="font-mono">[routing.smart_routing]</span> written
						by hand in <span className="font-mono">gateway.toml</span> would be
						dropped. The switch below shows off because nothing was reported,
						not because routing is off. Update the gateway to configure smart
						routing from the app.
					</SettingsCard>
				) : null}

				<SettingsGroup>
					<SettingsItem
						actions={
							<Switch
								aria-label="Enable smart routing"
								checked={draft?.enabled ?? false}
								disabled={isDisabled}
								onCheckedChange={(v) => patch({ enabled: v })}
							/>
						}
						description="Enable one model-selection algorithm for unpinned chat requests."
						title="Enable smart routing"
					/>
				</SettingsGroup>

				{/* The router form is one card: each algorithm's fields stack inside it
				    rather than in a bordered box of their own. */}
				<SettingsCard className="flex flex-col gap-5">
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="smart-router-type">Router type</Label>
						<Select
							items={MODEL_ROUTER_TYPE_LABELS}
							onValueChange={(v) => v && patch({ router_type: v })}
							value={routerType}
						>
							<SelectTrigger disabled={isDisabled} id="smart-router-type">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{
									/* SAFETY: This authored complete string-label map is checked against its closed native domain key union; Object.entries returns its own keys but erases their literal-key types. */ (
										Object.entries(MODEL_ROUTER_TYPE_LABELS) as [
											ModelRouterType,
											string,
										][]
									).map(([value, label]) => (
										<SelectItem key={value} value={value}>
											<span className="font-medium">{label}</span>
											<span className="ml-1 text-muted-foreground text-xs">
												— {MODEL_ROUTER_TYPE_DESCRIPTIONS[value]}
											</span>
										</SelectItem>
									))
								}
							</SelectContent>
						</Select>
						<p className="text-muted-foreground text-xs">
							Choose the model-selection algorithm. The normal provider routing,
							governance, budgets, and audit path still run after this choice.
						</p>
					</div>

					{routerType === "llm_classifier" ? (
						<div className="flex flex-col gap-1.5">
							<Label htmlFor="smart-strategy">Strategy</Label>
							<Select
								items={strategyCopy.labels}
								onValueChange={(v) => v && patch({ strategy: v })}
								value={draft?.strategy ?? "llm"}
							>
								<SelectTrigger disabled={isDisabled} id="smart-strategy">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{
										/* SAFETY: This authored complete string-label map is checked against its closed native domain key union; Object.entries returns its own keys but erases their literal-key types. */ (
											Object.entries(strategyCopy.labels) as [
												RouteStrategy,
												string,
											][]
										).map(([val, label]) => (
											<SelectItem key={val} value={val}>
												<span className="font-medium">{label}</span>
												<span className="ml-1 text-muted-foreground text-xs">
													— {strategyCopy.descriptions[val]}
												</span>
											</SelectItem>
										))
									}
								</SelectContent>
							</Select>
							<p className="text-muted-foreground text-xs">
								How the matching rule is chosen. LLM asks a cheap classifier;
								Embedding cosine-matches rule text; Keyword is a zero-cost word
								match.
							</p>
						</div>
					) : null}

					{routerType === "llm_classifier" &&
					(draft?.strategy ?? "llm") === "llm" ? (
						<div className="flex flex-col gap-1.5">
							<Label htmlFor="smart-classifier-model">Classifier model</Label>
							<AgentModelPickerField
								ariaLabel="Classifier model"
								disabled={isDisabled}
								mode="model"
								onChange={(next) => patch({ classifier_model: next })}
								placeholder="e.g. gpt-4o-mini, or a local model"
								target={target}
								value={draft?.classifier_model ?? ""}
							/>
							<p className="text-muted-foreground text-xs">
								A cheap, fast model used only to sort requests. Any routable
								model id works (including local models or openrouter/ slugs).
							</p>
							{classifierDefaulted ? (
								<p className="text-muted-foreground text-xs">
									No classifier model is picked, so smart routing uses this
									node's local classifier ({CLASSIFY_MODEL_ID}). Enter a model
									id to route with something else.
								</p>
							) : null}
							{classifierUnserved ? (
								<p className="text-status-destructive text-xs">
									Smart routing is on with the local classify tier as its
									classifier, but {classifierUnservedReason}, so the
									classification call will fail and every request will quietly
									keep the model it asked for. Pick a model this node can reach.
								</p>
							) : null}
							<ClassifyTierNote
								disabled={isDisabled}
								onUse={() => patch({ classifier_model: CLASSIFY_MODEL_ID })}
								state={classifyTier}
								value={draft?.classifier_model ?? ""}
							/>
						</div>
					) : null}

					{routerType === "llm_classifier" &&
					draft?.strategy === "embedding" ? (
						<>
							<div className="flex flex-col gap-1.5">
								<Label htmlFor="smart-embedding-model">Embedding model</Label>
								<Input
									disabled={isDisabled}
									id="smart-embedding-model"
									onChange={(e) => patch({ embedding_model: e.target.value })}
									placeholder="nomic-embed-text-v1.5 (default local)"
									value={draft?.embedding_model ?? ""}
								/>
								<p className="text-muted-foreground text-xs">
									Embedder used to match rules by meaning. Leave blank for the
									default local embedder.
								</p>
							</div>
							<div className="flex flex-col gap-1.5">
								<FluidSlider
									disabled={isDisabled}
									format={(v) => v.toFixed(2)}
									label="Similarity threshold"
									max={1}
									min={0}
									onValueChange={(similarity_threshold) =>
										patch({ similarity_threshold })
									}
									step={0.05}
									value={draft?.similarity_threshold ?? 0.35}
								/>
								<p className="text-muted-foreground text-xs">
									Minimum cosine similarity for a rule to match. Higher is
									stricter.
								</p>
							</div>
						</>
					) : null}

					{routerType === "random" ? (
						<div className="flex flex-col gap-1.5">
							<Label htmlFor="smart-random-seed">Seed (optional)</Label>
							<Input
								disabled={isDisabled}
								id="smart-random-seed"
								inputMode="numeric"
								onChange={(event) => {
									const raw = event.target.value.trim();
									const seed = Number(raw);
									patch({
										random_seed:
											raw === "" || !Number.isSafeInteger(seed) || seed < 0
												? null
												: seed,
									});
								}}
								placeholder="Leave blank for normal traffic"
								value={draft?.random_seed ?? ""}
							/>
							<p className="text-muted-foreground text-xs">
								Targets are selected independently per request. A seed
								reproduces the sequence for tests and benchmarks; it does not
								make a conversation sticky.
							</p>
						</div>
					) : null}

					{routerType === "stage_router" ? (
						<div className="flex flex-col gap-4">
							<div className="flex flex-col gap-1.5">
								<Label htmlFor="smart-stage-capable">Capable model</Label>
								<AgentModelPickerField
									ariaLabel="Stage capable model"
									disabled={isDisabled}
									mode="model"
									onChange={(next) => patch({ stage_capable_model: next })}
									placeholder="Model for exploration and recovery"
									target={target}
									value={draft?.stage_capable_model ?? ""}
								/>
							</div>
							<div className="flex flex-col gap-1.5">
								<Label htmlFor="smart-stage-efficient">Efficient model</Label>
								<AgentModelPickerField
									ariaLabel="Stage efficient model"
									disabled={isDisabled}
									mode="model"
									onChange={(next) => patch({ stage_efficient_model: next })}
									placeholder="Model for settled mechanical work"
									target={target}
									value={draft?.stage_efficient_model ?? ""}
								/>
							</div>
							<div className="flex flex-col gap-1.5">
								<Label htmlFor="smart-stage-picker">
									Ambiguous-turn default
								</Label>
								<Select
									items={{
										capable_first: "Capable first",
										efficient_first: "Efficient first",
									}}
									onValueChange={(value) =>
										value && patch({ stage_picker: value })
									}
									value={draft?.stage_picker ?? "capable_first"}
								>
									<SelectTrigger disabled={isDisabled} id="smart-stage-picker">
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										<SelectItem value="capable_first">Capable first</SelectItem>
										<SelectItem value="efficient_first">
											Efficient first
										</SelectItem>
									</SelectContent>
								</Select>
							</div>
							<FluidSlider
								disabled={isDisabled}
								format={(value) => value.toFixed(2)}
								label="Signal confidence threshold"
								max={1}
								min={0}
								onValueChange={(stage_confidence_threshold) =>
									patch({ stage_confidence_threshold })
								}
								step={0.05}
								value={draft?.stage_confidence_threshold ?? 0.5}
							/>
							<p className="text-muted-foreground text-xs">
								Ryu reads recent tool/result history. Errors and exploration
								favor the capable model; writes and passing tests favor the
								efficient model.
							</p>
						</div>
					) : null}

					{routerType === "escalation" ? (
						<div className="flex flex-col gap-4">
							<div className="flex flex-col gap-1.5">
								<Label htmlFor="smart-escalation-weak">Weak model</Label>
								<AgentModelPickerField
									ariaLabel="Escalation weak model"
									disabled={isDisabled}
									mode="model"
									onChange={(next) => patch({ escalation_weak_model: next })}
									placeholder="Default model for routine turns"
									target={target}
									value={draft?.escalation_weak_model ?? ""}
								/>
							</div>
							<div className="flex flex-col gap-1.5">
								<Label htmlFor="smart-escalation-strong">Strong model</Label>
								<AgentModelPickerField
									ariaLabel="Escalation strong model"
									disabled={isDisabled}
									mode="model"
									onChange={(next) => patch({ escalation_strong_model: next })}
									placeholder="Model for confirmed trouble"
									target={target}
									value={draft?.escalation_strong_model ?? ""}
								/>
							</div>
							<div className="flex flex-col gap-1.5">
								<Label htmlFor="smart-escalation-judge">Judge model</Label>
								<AgentModelPickerField
									ariaLabel="Escalation judge model"
									disabled={isDisabled}
									mode="model"
									onChange={(next) => patch({ escalation_judge_model: next })}
									placeholder="Small model that returns ESCALATE or DECLINE"
									target={target}
									value={draft?.escalation_judge_model ?? ""}
								/>
							</div>
							<div className="flex flex-col gap-1.5">
								<Label htmlFor="smart-escalation-confirmations">
									Confirmations before escalation
								</Label>
								<Input
									disabled={isDisabled}
									id="smart-escalation-confirmations"
									inputMode="numeric"
									min={1}
									onChange={(event) =>
										patch({
											escalation_confirmations: Number(event.target.value),
										})
									}
									placeholder="2"
									value={draft?.escalation_confirmations ?? 2}
								/>
							</div>
							<p className="text-muted-foreground text-xs">
								The judge sees the current transcript before routing.
								Consecutive ESCALATE verdicts latch sessions to the strong
								model; judge failures use the weak model. This preflight mode
								does not replay a completed weak response through the strong
								model.
							</p>
						</div>
					) : null}

					{routerType === "llm_classifier" || routerType === "random" ? (
						<>
							<div className="flex flex-col gap-2">
								<div className="flex items-center justify-between">
									<Label>Rules</Label>
									<Button
										disabled={isDisabled}
										onClick={addRule}
										size="sm"
										variant="ghost"
									>
										<HugeiconsIcon className="size-4" icon={Add01Icon} />
										Add rule
									</Button>
								</div>
								{rules.length === 0 ? (
									<p className="text-muted-foreground text-sm">
										No targets yet. Add a model below
										{routerType === "random"
											? " and give it a relative weight"
											: " with a matching rule"}
										.
									</p>
								) : (
									<div className="flex flex-col gap-3">
										{rules.map((rule, idx) => (
											<div className="flex items-start gap-2" key={rule.id}>
												<div className="flex flex-1 flex-col gap-1.5">
													<Input
														aria-label={`Rule ${idx + 1} description`}
														disabled={isDisabled}
														onChange={(e) =>
															updateRule(rule.id, "description", e.target.value)
														}
														placeholder={
															routerType === "random"
																? "Optional target label"
																: "When the request is about… (plain language)"
														}
														value={rule.description}
													/>
													<AgentModelPickerField
														ariaLabel={`Route to model for rule ${idx + 1}`}
														disabled={isDisabled}
														mode="model"
														onChange={(next) =>
															updateRule(rule.id, "model", next)
														}
														placeholder="Route to model id (e.g. claude-sonnet-4-5)"
														target={target}
														value={rule.model}
													/>
													{routerType === "random" ? (
														<Input
															aria-label={`Rule ${idx + 1} weight`}
															disabled={isDisabled}
															inputMode="decimal"
															min={0}
															onChange={(e) =>
																updateRule(rule.id, "weight", e.target.value)
															}
															placeholder="Relative weight (default 1)"
															value={rule.weight}
														/>
													) : null}
												</div>
												<Button
													disabled={isDisabled}
													onClick={() => removeRule(rule.id)}
													size="icon"
													variant="ghost"
												>
													<HugeiconsIcon
														className="size-3.5 text-status-destructive"
														icon={Delete01Icon}
													/>
													<span className="sr-only">Remove rule {idx + 1}</span>
												</Button>
											</div>
										))}
									</div>
								)}
							</div>

							{routerType === "llm_classifier" ? (
								<div className="flex flex-col gap-1.5">
									<Label htmlFor="smart-default-model">
										Default model when no rule matches
									</Label>
									<AgentModelPickerField
										ariaLabel="Default model when no rule matches"
										disabled={isDisabled}
										mode="model"
										onChange={(next) => patch({ default_model: next })}
										placeholder="Leave blank to keep the originally requested model"
										target={target}
										value={draft?.default_model ?? ""}
									/>
								</div>
							) : null}
						</>
					) : null}
				</SettingsCard>

				<SettingsCard className="flex flex-col gap-3">
					<div className="flex flex-col gap-0.5">
						<span className="text-sm">Routing pool</span>
						<p className="text-muted-foreground text-xs">
							Limit which targets smart routing may pick on this node. Rules and
							tiers outside the pool are skipped. Each agent can narrow this
							pool further in its own settings, but never widen it.
						</p>
					</div>
					<RoutePoolFields
						disabled={isDisabled}
						idPrefix="smart-routing"
						models={poolModels}
						onModelsChange={(next) => {
							setSaveError(null);
							setPoolModels(next);
						}}
						onProvidersChange={(next) => {
							setSaveError(null);
							setPoolProviders(next);
						}}
						providers={poolProviders}
					/>
				</SettingsCard>

				{saveError ? (
					<p className="px-3.5 text-sm text-status-destructive" role="alert">
						{saveError}
					</p>
				) : null}
				{saveOk ? (
					<p className="px-3.5 text-sm text-status-success">
						Saved. New requests use the updated router.
					</p>
				) : null}
			</div>
		</SettingsSection>
	);
}

export function RoutingCard({
	target,
	reachable,
	configuredProviders,
	canConfigure,
}: {
	target: ApiTarget;
	reachable: boolean;
	configuredProviders: string[];
	/** When false the caller lacks `gateway.configure`; controls read-only. */
	canConfigure: boolean;
}) {
	const [config, setConfig] = useState<GatewayRoutingConfig | null>(null);
	const [configError, setConfigError] = useState<string | null>(null);
	const [configReadAttempt, setConfigReadAttempt] = useState(0);
	const [draft, setDraft] = useState<GatewayRoutingConfig | null>(null);
	const [supportedPoolStrategies, setSupportedPoolStrategies] = useState<
		ProviderPoolStrategy[] | undefined
	>();
	const [saving, setSaving] = useState(false);
	const [saveError, setSaveError] = useState<string | null>(null);
	const [saveOk, setSaveOk] = useState(false);
	const [mappingError, setMappingError] = useState<string | null>(null);

	const providers: ProviderKind[] = configuredProviders.filter(
		(p): p is ProviderKind => p in PROVIDER_LABELS
	);
	const poolProviders = configuredProviders.filter(
		(provider) => !NON_CHAT_POOL_PROVIDERS.has(provider)
	);
	const poolAliases = Object.keys(draft?.provider_pools ?? {}).map(
		(name) => `pool:${name}`
	);
	const mappingProviders = [
		...configuredProviders.filter((provider) => provider !== "classify"),
		...poolAliases,
	];

	useEffect(() => {
		if (!reachable || config !== null) {
			return;
		}
		let cancelled = false;
		fetchGatewayConfig(target)
			.then((cfg) => {
				if (!cancelled) {
					setConfig(cfg.routing);
					setDraft(cfg.routing);
					setSupportedPoolStrategies(cfg.strategyCapabilities?.chat);
					setConfigError(null);
				}
			})
			.catch((e) => {
				if (!cancelled) {
					setConfigError(
						e instanceof Error ? e.message : "Failed to load routing config"
					);
				}
			});
		return () => {
			cancelled = true;
		};
	}, [reachable, config, configReadAttempt, target]);

	/**
	 * Save the draft's default provider, fallback chain and cost tiers. Like the
	 * row savers below, the body is rebuilt from a fresh `GET` (only the fields
	 * this draft changed since it loaded are applied) and carries that read's
	 * revision, so Smart Routing, eval routing or tier edits saved elsewhere are
	 * kept, and a concurrent write surfaces as a conflict instead of a revert.
	 */
	const handleSave = async () => {
		if (!(draft && config)) {
			return;
		}
		setSaving(true);
		setSaveError(null);
		setSaveOk(false);
		try {
			const cfg = await fetchGatewayConfig(target);
			const next = withRoutingDraftEdits(cfg.routing, config, draft);
			await updateGatewayConfig(target, {
				routing: next,
				expectedRevision: cfg.configRevision ?? undefined,
			});
			setConfig(next);
			setDraft(next);
			setSaveOk(true);
			setTimeout(() => setSaveOk(false), 3000);
		} catch (e) {
			setSaveError(
				e instanceof ApiError && e.status === 409
					? "Routing changed elsewhere while saving. Save again to apply your edits on top of it."
					: e instanceof Error
						? e.message
						: "Failed to save routing config"
			);
		} finally {
			setSaving(false);
		}
	};

	const patchDraft = (patch: Partial<GatewayRoutingConfig>) => {
		setDraft((prev) => (prev ? { ...prev, ...patch } : prev));
		setSaveOk(false);
		setSaveError(null);
	};

	const addMapping = async (form: ModelMappingFormState) => {
		const cfg = await fetchGatewayConfig(target);
		const mapping = mappingFromForm(form);
		const next: GatewayRoutingConfig = {
			...cfg.routing,
			model_map: { ...cfg.routing.model_map, [form.model.trim()]: mapping },
		};
		await updateGatewayConfig(target, {
			routing: next,
			expectedRevision: cfg.configRevision ?? undefined,
		});
		setConfig(next);
		setDraft(next);
	};

	const removeMapping = async (model: string) => {
		setMappingError(null);
		try {
			const cfg = await fetchGatewayConfig(target);
			const model_map = { ...cfg.routing.model_map };
			delete model_map[model];
			const next: GatewayRoutingConfig = { ...cfg.routing, model_map };
			await updateGatewayConfig(target, {
				routing: next,
				expectedRevision: cfg.configRevision ?? undefined,
			});
			setConfig(next);
			setDraft(next);
		} catch (e) {
			setMappingError(
				e instanceof Error ? e.message : "Failed to remove model mapping."
			);
		}
	};

	/**
	 * Author or clear one `modality_map` row. Same read-modify-write shape as
	 * {@link addMapping}/{@link removeMapping} above, and for the same two
	 * reasons: `PUT /v1/config { routing }` replaces the section wholesale, and
	 * the gateway persists routing WITHOUT updating its startup snapshot — so the
	 * body has to be built from a fresh `GET`, not from `draft`, or this save
	 * spreads stale values back over the file.
	 *
	 * `withModalityMapping` does the spread, which is what carries `eval_routing`,
	 * `smart_routing`, `provider_tiers` and the rest through untouched.
	 *
	 * Inherited from that shape, and worth stating rather than discovering: the
	 * re-seeded `draft` is server state, so an UNSAVED edit to the default
	 * provider or fallback chain sitting in the draft is discarded by this save.
	 * The model-map rows have always behaved this way; the two row editors and the
	 * draft-plus-Save controls are deliberately not merged, because merging them
	 * would mean a row edit could also commit a half-finished chain reorder.
	 */
	const saveModalityMapping = async (
		modality: Modality,
		mapping: { model?: string; provider: string } | null
	) => {
		const cfg = await fetchGatewayConfig(target);
		const next = withModalityMapping(cfg.routing, modality, mapping);
		await updateGatewayConfig(target, {
			routing: next,
			expectedRevision: cfg.configRevision ?? undefined,
		});
		setConfig(next);
		setDraft(next);
	};

	const saveProviderPool = async (
		name: string,
		pool: NonNullable<GatewayRoutingConfig["provider_pools"]>[string] | null
	) => {
		const cfg = await fetchGatewayConfig(target);
		if (cfg.routing.provider_pools === undefined) {
			throw new Error("This Gateway does not report named provider pools.");
		}
		setSupportedPoolStrategies(cfg.strategyCapabilities?.chat);
		const provider_pools = { ...cfg.routing.provider_pools };
		if (pool) {
			provider_pools[name] = pool;
		} else {
			const alias = `pool:${name}`;
			if (
				Object.values(cfg.routing.model_map).some(
					(mapping) => mapping.provider === alias
				)
			) {
				throw new Error(`Remove model mappings to ${alias} first.`);
			}
			delete provider_pools[name];
		}
		const next: GatewayRoutingConfig = { ...cfg.routing, provider_pools };
		await updateGatewayConfig(target, {
			routing: next,
			expectedRevision: cfg.configRevision ?? undefined,
		});
		setConfig(next);
		setDraft(next);
	};

	const moveFallback = (index: number, direction: "up" | "down") => {
		if (!draft) {
			return;
		}
		const chain = [...draft.fallback_chain];
		const swapIndex = direction === "up" ? index - 1 : index + 1;
		if (swapIndex < 0 || swapIndex >= chain.length) {
			return;
		}
		const tmp = chain[index];
		chain[index] = chain[swapIndex];
		chain[swapIndex] = tmp;
		patchDraft({ fallback_chain: chain });
	};

	const addFallback = (provider: ProviderKind) => {
		if (!draft) {
			return;
		}
		if (draft.fallback_chain.includes(provider)) {
			return;
		}
		patchDraft({ fallback_chain: [...draft.fallback_chain, provider] });
	};

	// `fallback_chain` holds open `ProviderId` registry ids, not only `ProviderKind`.
	const removeFallback = (provider: string) => {
		if (!draft) {
			return;
		}
		patchDraft({
			fallback_chain: draft.fallback_chain.filter((p) => p !== provider),
		});
	};

	const isDisabled = !reachable || draft === null || !canConfigure;
	const mappingEntries = Object.entries(draft?.model_map ?? {});
	// Presence is read off `config` — the last thing the NODE actually said —
	// rather than off `draft`, which is that same object plus local edits.
	//
	// THREE states, not two, and the third is why this is a `null` and not a
	// boolean: `config === null` covers both "gateway unreachable" (the fetch
	// effect returns early on `!reachable`) and "fetch still in flight", neither
	// of which says anything about what the node serves. Collapsing either into
	// "not served" would flash a warning accusing a healthy, current gateway of
	// being about to drop its modality map every time this dialog opens.
	const modalityMapServed =
		config === null ? null : routingViewIncludesModalityMap(config);
	// Coalesce only at the render site — never in `fetchGatewayConfig`, which
	// would erase the difference between "not served" and "served, empty".
	const modalityMap = draft?.modality_map ?? {};

	return (
		<div className="flex flex-col gap-4">
			<SettingsSection
				caption={
					<>
						Ryu's user-level model routing, which runs before any upstream
						provider routing. Pick which provider handles requests by default,
						map specific models to providers, and order the fallback chain for
						when a provider is unavailable.{" "}
						<span className="font-medium text-foreground">
							Two-layer guardrail model:
						</span>{" "}
						Ryu evaluates firewall rules, PII/DLP, and per-agent budgets here,
						at the gateway, before the request leaves to any upstream provider.
						When you route to OpenRouter, OpenRouter's own auto-routing and
						guardrails run as an additional layer on top; they do not replace
						Ryu's user-level controls. Use{" "}
						<span className="font-mono">openrouter/auto</span> to let OpenRouter
						pick the best available model, or{" "}
						<span className="font-mono">openrouter/pareto-code</span> to pick a
						coding model; any{" "}
						<span className="font-mono">openrouter/&lt;model&gt;</span> slug is
						supported.
					</>
				}
				title="Routing"
			>
				<div className="flex flex-col gap-3">
					{reachable && configError ? (
						<SettingsCard className="flex flex-wrap items-center justify-between gap-3">
							<p
								className="min-w-0 flex-1 break-words text-muted-foreground text-sm"
								role="alert"
							>
								{configError}
							</p>
							<Button
								onClick={() => setConfigReadAttempt((attempt) => attempt + 1)}
								size="sm"
								variant="secondary"
							>
								Retry
							</Button>
						</SettingsCard>
					) : null}
					{reachable ? null : (
						<SettingsCard className="text-muted-foreground text-sm">
							Gateway unreachable, so controls are disabled. Start the gateway
							and refresh to configure routing.
						</SettingsCard>
					)}

					<SettingsGroup>
						<SettingsItem
							actions={
								<Select
									disabled={isDisabled || providers.length === 0}
									items={providers.map((p) => ({
										value: p,
										label: PROVIDER_LABELS[p] ?? p,
									}))}
									onValueChange={(v) =>
										v && patchDraft({ default_provider: v })
									}
									value={draft?.default_provider ?? "openai"}
								>
									<SelectTrigger className="w-48" id="routing-default-provider">
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										{providers.map((p) => (
											<SelectItem key={p} value={p}>
												{PROVIDER_LABELS[p] ?? p}
											</SelectItem>
										))}
										{providers.length === 0 ? (
											<SelectItem disabled value="__none__">
												No providers configured
											</SelectItem>
										) : null}
									</SelectContent>
								</Select>
							}
							description="Used when no model-map entry matches the requested model name."
							title={
								<Label htmlFor="routing-default-provider">
									Default provider
								</Label>
							}
						/>
					</SettingsGroup>
				</div>
			</SettingsSection>

			<SettingsSection
				caption={
					poolAliases.length > 0
						? "Named chat pools from Gateway configuration are available as mapping targets."
						: undefined
				}
				headerAction={
					mappingProviders.length > 0 ? (
						<ModelMappingDialog
							description="Route a model name (exact or prefix) to a specific provider. Optionally rewrite the model name before forwarding."
							onSave={addMapping}
							providers={mappingProviders}
							title="Add model mapping"
							trigger={
								<Button disabled={isDisabled} size="sm" variant="ghost">
									<HugeiconsIcon className="size-4" icon={Add01Icon} />
									Add mapping
								</Button>
							}
						/>
					) : (
						<Button disabled size="sm" variant="ghost">
							<HugeiconsIcon className="size-4" icon={Add01Icon} />
							Add mapping
						</Button>
					)
				}
				title="Model mappings"
			>
				{mappingError ? (
					<p className="px-3.5 text-sm text-status-destructive" role="alert">
						{mappingError}
					</p>
				) : null}
				{mappingEntries.length === 0 ? (
					<SettingsCard className="text-center text-muted-foreground text-sm">
						No model mappings. Requests are routed by built-in prefix rules then
						fall back to the default provider.
					</SettingsCard>
				) : (
					<SettingsGroup>
						{mappingEntries.map(([model, mapping]) => (
							<SettingsItem
								actions={
									<div className="flex shrink-0 items-center gap-1">
										<ModelMappingDialog
											description="Update the provider or model name for this mapping."
											initial={{
												model,
												provider: mapping.provider,
												provider_model: mapping.provider_model ?? "",
											}}
											modelReadOnly
											onSave={async (form) => {
												const cfg = await fetchGatewayConfig(target);
												const updated = mappingFromForm(form);
												const next: GatewayRoutingConfig = {
													...cfg.routing,
													model_map: {
														...cfg.routing.model_map,
														[model]: updated,
													},
												};
												await updateGatewayConfig(target, {
													routing: next,
													expectedRevision: cfg.configRevision ?? undefined,
												});
												setConfig(next);
												setDraft(next);
											}}
											providers={mappingProviders}
											title="Edit model mapping"
											trigger={
												<Button
													disabled={isDisabled}
													size="icon"
													variant="ghost"
												>
													<HugeiconsIcon
														className="size-3.5"
														icon={PencilEdit01Icon}
													/>
													<span className="sr-only">
														Edit mapping for {model}
													</span>
												</Button>
											}
										/>
										<Button
											disabled={isDisabled}
											onClick={() => removeMapping(model)}
											size="icon"
											variant="ghost"
										>
											<HugeiconsIcon
												className="size-3.5 text-status-destructive"
												icon={Delete01Icon}
											/>
											<span className="sr-only">
												Remove mapping for {model}
											</span>
										</Button>
									</div>
								}
								key={model}
								title={
									<span className="flex min-w-0 flex-col">
										<span className="truncate font-mono">{model}</span>
										<span className="text-muted-foreground text-xs">
											{modalityProviderLabel(mapping.provider)}
											{mapping.provider_model
												? ` → ${mapping.provider_model}`
												: null}
										</span>
									</span>
								}
							/>
						))}
					</SettingsGroup>
				)}
			</SettingsSection>

			{draft?.provider_pools === undefined ? null : (
				<ProviderPoolsEditor
					disabled={isDisabled}
					modelMap={draft.model_map}
					onSave={saveProviderPool}
					pools={draft.provider_pools}
					providers={poolProviders}
					supportedStrategies={supportedPoolStrategies}
				/>
			)}

			{modalityMapServed === null ? null : (
				<SettingsSection
					caption="Which provider serves image, speech and video requests. Consulted BEFORE the model mappings above for any non-chat request, so this is the swap point for media providers such as fal, Replicate and Modal. A per-agent slot forwarded by Core still outranks it. Each row saves immediately."
					title="Modality routing"
				>
					<ModalityRoutingRows
						configuredProviders={configuredProviders}
						defaultProvider={draft?.default_provider ?? "openai"}
						disabled={isDisabled}
						modalityMap={modalityMap}
						onSave={saveModalityMapping}
						served={modalityMapServed}
					/>
				</SettingsSection>
			)}

			<SettingsSection
				caption="Providers tried when the primary is unavailable. Lower cost tiers go first; use the arrows to order providers within a tier."
				title="Fallback chain"
			>
				{(draft?.fallback_chain ?? []).length === 0 ? (
					<SettingsCard className="text-center text-muted-foreground text-sm">
						No fallback chain configured. Add providers below to enable
						automatic fallback.
					</SettingsCard>
				) : (
					<SettingsGroup>
						{(draft?.fallback_chain ?? []).map((provider, i) => (
							<SettingsItem
								actions={
									<div className="flex items-center gap-1">
										<Select
											disabled={isDisabled}
											items={[
												{ value: "0", label: "Subscription" },
												{ value: "1", label: "Low cost" },
												{ value: "2", label: "Free" },
											]}
											onValueChange={(value) => {
												if (value && draft) {
													patchDraft({
														provider_tiers: {
															...draft.provider_tiers,
															[provider]: Number(value),
														},
													});
												}
											}}
											value={String(draft?.provider_tiers?.[provider] ?? 0)}
										>
											<SelectTrigger
												aria-label={`Cost tier for ${provider}`}
												className="w-32"
											>
												<SelectValue />
											</SelectTrigger>
											<SelectContent>
												<SelectItem value="0">Subscription</SelectItem>
												<SelectItem value="1">Low cost</SelectItem>
												<SelectItem value="2">Free</SelectItem>
											</SelectContent>
										</Select>
										<Button
											disabled={isDisabled || i === 0}
											onClick={() => moveFallback(i, "up")}
											size="icon"
											variant="ghost"
										>
											<HugeiconsIcon
												className="size-3.5"
												icon={ArrowUp01Icon}
											/>
											<span className="sr-only">Move up</span>
										</Button>
										<Button
											disabled={
												isDisabled ||
												i === (draft?.fallback_chain ?? []).length - 1
											}
											onClick={() => moveFallback(i, "down")}
											size="icon"
											variant="ghost"
										>
											<HugeiconsIcon
												className="size-3.5"
												icon={ArrowDown01Icon}
											/>
											<span className="sr-only">Move down</span>
										</Button>
										<Button
											disabled={isDisabled}
											onClick={() => removeFallback(provider)}
											size="icon"
											variant="ghost"
										>
											<HugeiconsIcon
												className="size-3.5 text-status-destructive"
												icon={Delete01Icon}
											/>
											<span className="sr-only">
												Remove {provider} from fallback chain
											</span>
										</Button>
									</div>
								}
								key={provider}
								title={modalityProviderLabel(provider)}
							/>
						))}
					</SettingsGroup>
				)}
				{providers.length > 0 ? (
					<div className="flex flex-wrap gap-2 px-1.5">
						{providers
							.filter((p) => !(draft?.fallback_chain ?? []).includes(p))
							.map((p) => (
								<Button
									disabled={isDisabled}
									key={p}
									onClick={() => addFallback(p)}
									size="sm"
									variant="ghost"
								>
									<HugeiconsIcon className="size-3.5" icon={Add01Icon} />
									{PROVIDER_LABELS[p] ?? p}
								</Button>
							))}
					</div>
				) : null}
			</SettingsSection>

			<div className="flex flex-wrap items-center gap-3 px-3.5">
				<Button
					disabled={isDisabled || draft === config}
					loading={saving}
					onClick={() => handleSave()}
					size="sm"
				>
					Save
				</Button>
				{saveOk ? (
					<span className="text-sm text-status-success">
						Saved. Gateway will apply on next restart.
					</span>
				) : null}
				{saveError ? (
					<span className="text-sm text-status-destructive">{saveError}</span>
				) : null}
			</div>
		</div>
	);
}

const SPEND_POLL_MS = 5000;
const MAX_SESSION_ROWS = 8;

/** One id → spent (/ limit) row list for a single spend scope, spend-sorted. */
function SpendRows({
	spend,
	limits,
	max,
	idPrefix,
}: {
	spend: Record<string, number>;
	/** Configured caps keyed by the same ids (0 / absent = unlimited). */
	limits: Record<string, number>;
	/** Cap the number of rows (ephemeral session ids can be many). */
	max?: number;
	/** Stable prefix for React keys. */
	idPrefix: string;
}) {
	const sorted = Object.entries(spend).sort(([, a], [, b]) => b - a);
	const rows = max ? sorted.slice(0, max) : sorted;
	return (
		<SettingsGroup>
			{rows.map(([id, spent]) => {
				const cap = limits[id] ?? 0;
				return (
					<SettingsItem
						actions={
							<span className="font-mono text-muted-foreground text-xs tabular-nums">
								{formatBudgetUsd(spent)}
								{cap > 0 ? ` / ${formatBudgetUsd(cap)}` : ""}
							</span>
						}
						key={`${idPrefix}-${id}`}
						title={
							<span className="truncate font-mono text-xs" title={id}>
								{id}
							</span>
						}
					/>
				);
			})}
		</SettingsGroup>
	);
}

/**
 * Live budget spend readout (M2 control-layer UX). Polls Core's proxy of the
 * gateway's in-memory per-user / per-agent / per-session charged-spend counters and
 * shows spend-vs-limit. The gateway only tracks ids with a CONFIGURED budget
 * (a session cap of 0 records nothing), so with no budget set the maps are
 * empty and this renders a hint instead of an empty pane. Counters are
 * in-memory: a gateway restart resets them.
 */
function LiveSpendCard({ target }: { target: ApiTarget }) {
	const [spend, setSpend] = useState<BudgetSpend | null>(null);
	const [loading, setLoading] = useState(true);

	useEffect(() => {
		let cancelled = false;
		const controller = new AbortController();
		const tick = async () => {
			try {
				const next = await fetchBudgetSpend(target, {}, controller.signal);
				if (!cancelled) {
					setSpend(next);
				}
			} catch {
				// Core unreachable — leave the last snapshot; the status card owns
				// the reachability surface.
			} finally {
				if (!cancelled) {
					setLoading(false);
				}
			}
		};
		tick();
		const timer = setInterval(tick, SPEND_POLL_MS);
		return () => {
			cancelled = true;
			controller.abort();
			clearInterval(timer);
		};
	}, [target]);

	const userEntries = Object.entries(spend?.users ?? {});
	const agentEntries = Object.entries(spend?.agents ?? {});
	const sessionEntries = Object.entries(spend?.sessions ?? {});
	const anySpend =
		userEntries.length > 0 ||
		agentEntries.length > 0 ||
		sessionEntries.length > 0;
	const sessionLimit = spend?.limits.session ?? 0;

	return (
		<SettingsSection
			caption="Live charged spend per user, per agent, and per session, read from the gateway's in-memory counters. Only scopes with a configured budget are tracked; counters reset when the gateway restarts."
			title="Live spend"
		>
			{loading && !spend ? (
				<SettingsCard>
					<SkeletonRows label="Loading…" spacing="budget" />
				</SettingsCard>
			) : null}
			{!loading && spend && !spend.reachable ? (
				<SettingsCard className="text-center text-muted-foreground text-sm">
					Gateway unreachable. Live spend appears once it is running.
				</SettingsCard>
			) : null}
			{!loading && spend?.reachable && !anySpend ? (
				<SettingsCard className="text-center text-muted-foreground text-sm">
					No spend tracked yet. Configure a budget above, then spend appears
					here as traffic flows.
				</SettingsCard>
			) : null}
			{spend?.reachable && anySpend ? (
				<div className="flex flex-col gap-4">
					{userEntries.length > 0 ? (
						<SettingsSection title="Per-user">
							<SpendRows
								idPrefix="user"
								limits={spend.limits.users}
								spend={spend.users}
							/>
						</SettingsSection>
					) : null}
					{agentEntries.length > 0 ? (
						<SettingsSection title="Per-agent">
							<SpendRows
								idPrefix="agent"
								limits={spend.limits.agents}
								spend={spend.agents}
							/>
						</SettingsSection>
					) : null}
					{sessionEntries.length > 0 ? (
						<SettingsSection title="Per-session">
							<SpendRows
								idPrefix="session"
								limits={sessionEntries.reduce<Record<string, number>>(
									(acc, [id]) => {
										acc[id] = sessionLimit;
										return acc;
									},
									{}
								)}
								max={MAX_SESSION_ROWS}
								spend={spend.sessions}
							/>
						</SettingsSection>
					) : null}
				</div>
			) : null}
		</SettingsSection>
	);
}

export function BudgetsCard({
	target,
	canConfigure,
}: {
	target: ApiTarget;
	/** When false the caller lacks `gateway.configure`; controls read-only. */
	canConfigure: boolean;
}) {
	const [budgets, setBudgets] = useState<GatewayBudgetConfig | null>(null);
	const [agents, setAgents] = useState<AgentSummary[]>([]);
	const [loading, setLoading] = useState(true);
	const [err, setErr] = useState<string | null>(null);

	const load = useCallback(async () => {
		setLoading(true);
		setErr(null);
		try {
			const [cfg, agentList] = await Promise.all([
				fetchGatewayConfig(target),
				fetchAgents(target).catch(() => []),
			]);
			setBudgets(cfg.budgets);
			setAgents(agentList);
		} catch (e) {
			setErr(e instanceof Error ? e.message : "Failed to load config.");
		} finally {
			setLoading(false);
		}
	}, [target]);

	useEffect(() => {
		load();
	}, [load]);

	// Every budgets PUT replaces the WHOLE BudgetConfig server-side, so each save
	// path must re-fetch and spread all three dimensions (users / agents /
	// session). Skipping one silently wipes it (e.g. an agent save clearing the
	// session cap).
	const saveRule = useCallback(
		async (scope: "users" | "agents", id: string, rule: BudgetRule) => {
			const cfg = await fetchGatewayConfig(target);
			const next: GatewayBudgetConfig = {
				users: { ...cfg.budgets.users },
				agents: { ...cfg.budgets.agents },
				session: cfg.budgets.session ?? DEFAULT_SESSION_BUDGET,
			};
			next[scope][id] = rule;
			await updateGatewayConfig(target, {
				budgets: next,
				expectedRevision: cfg.configRevision ?? undefined,
			});
			setBudgets(next);
		},
		[target]
	);

	const removeRule = useCallback(
		async (scope: "users" | "agents", id: string) => {
			const cfg = await fetchGatewayConfig(target);
			const next: GatewayBudgetConfig = {
				users: { ...cfg.budgets.users },
				agents: { ...cfg.budgets.agents },
				session: cfg.budgets.session ?? DEFAULT_SESSION_BUDGET,
			};
			delete next[scope][id];
			await updateGatewayConfig(target, {
				budgets: next,
				expectedRevision: cfg.configRevision ?? undefined,
			});
			setBudgets(next);
		},
		[target]
	);

	const saveSession = useCallback(
		async (rule: BudgetRule) => {
			const cfg = await fetchGatewayConfig(target);
			const next: GatewayBudgetConfig = {
				users: { ...cfg.budgets.users },
				agents: { ...cfg.budgets.agents },
				session: rule,
			};
			await updateGatewayConfig(target, {
				budgets: next,
				expectedRevision: cfg.configRevision ?? undefined,
			});
			setBudgets(next);
		},
		[target]
	);

	const userEntries = Object.entries(budgets?.users ?? {});
	const agentEntries = Object.entries(budgets?.agents ?? {});

	return (
		<SettingsSection caption="Spend caps per user, per agent, and a single global per-session cap. Choose whether model, media, or paid-tool charges count. When a cap is reached the gateway applies the configured action (notify / downgrade / restrict / stop) and, separately, the rule's notification tier decides who is told. Changes take effect immediately.">
			{loading ? (
				<SettingsCard>
					<SkeletonRows label="Loading…" spacing="panel" />
				</SettingsCard>
			) : null}
			{!loading && err ? (
				<SettingsCard className="flex flex-wrap items-center justify-between gap-3">
					<p
						className="min-w-0 flex-1 break-words text-muted-foreground text-sm"
						role="alert"
					>
						{err}
					</p>
					<Button onClick={() => load()} size="sm" variant="secondary">
						Retry
					</Button>
				</SettingsCard>
			) : null}
			{loading || err ? null : (
				<div className="flex flex-col gap-6">
					<BudgetScopeSection
						addDialog={
							<BudgetRuleDialog
								description="Set a charged-spend cap and action for a user. The limit is in USD."
								idLabel="User ID"
								idPlaceholder="e.g. user_123 (the x-ryu-user-id value)"
								idRequiredError="User ID is required."
								onSave={async (form) => {
									await saveRule(
										"users",
										form.agentId.trim(),
										formToRule(form)
									);
								}}
								target={target}
								title="Add user budget"
								trigger={
									<Button disabled={!canConfigure} size="sm" variant="ghost">
										<HugeiconsIcon className="size-4" icon={Add01Icon} />
										Add
									</Button>
								}
							/>
						}
						canConfigure={canConfigure}
						editIdLabel="User ID"
						emptyText="No per-user budgets set. Add one to cap a user's spend."
						entries={userEntries}
						label="Per-user"
						onRemove={(id) => removeRule("users", id)}
						onSave={(id, rule) => saveRule("users", id, rule)}
						target={target}
					/>
					<BudgetScopeSection
						addDialog={
							<BudgetRuleDialog
								agents={agents}
								description="Set a charged-spend cap and action for an agent. The limit is in USD."
								onSave={async (form) => {
									await saveRule(
										"agents",
										form.agentId.trim(),
										formToRule(form)
									);
								}}
								target={target}
								title="Add agent budget"
								trigger={
									<Button disabled={!canConfigure} size="sm" variant="ghost">
										<HugeiconsIcon className="size-4" icon={Add01Icon} />
										Add
									</Button>
								}
							/>
						}
						canConfigure={canConfigure}
						editIdLabel="Agent ID"
						emptyText="No per-agent budgets set. Add one to cap an agent's spend."
						entries={agentEntries}
						label="Per-agent"
						onRemove={(id) => removeRule("agents", id)}
						onSave={(id, rule) => saveRule("agents", id, rule)}
						target={target}
					/>
					<SessionBudgetEditor
						canConfigure={canConfigure}
						onSave={saveSession}
						rule={budgets?.session ?? DEFAULT_SESSION_BUDGET}
						target={target}
					/>
				</div>
			)}
		</SettingsSection>
	);
}

/**
 * A keyed budget scope (per-user or per-agent): a labelled header with an add
 * button, then a list of rules each with inline edit + delete dialogs. Mirrors
 * the agent-budget UX the card previously inlined.
 */
function BudgetScopeSection({
	label,
	entries,
	emptyText,
	addDialog,
	editIdLabel,
	onSave,
	onRemove,
	canConfigure,
	target,
}: {
	label: string;
	entries: [string, BudgetRule][];
	emptyText: string;
	addDialog: ReactElement;
	editIdLabel: string;
	onSave: (id: string, rule: BudgetRule) => Promise<void>;
	onRemove: (id: string) => Promise<void>;
	/** When false the caller lacks `gateway.configure`; edit/remove disabled. */
	canConfigure: boolean;
	/** Node target — threaded to each row's edit dialog for the model picker. */
	target: ApiTarget;
}) {
	const [removingId, setRemovingId] = useState<string | null>(null);
	const [removeError, setRemoveError] = useState<{
		id: string;
		message: string;
	} | null>(null);

	const remove = async (id: string) => {
		setRemovingId(id);
		setRemoveError(null);
		try {
			await onRemove(id);
		} catch (e) {
			setRemoveError({
				id,
				message: e instanceof Error ? e.message : "Failed to remove budget.",
			});
		} finally {
			setRemovingId(null);
		}
	};

	return (
		<SettingsSection headerAction={addDialog} title={label}>
			{entries.length === 0 ? (
				<SettingsCard className="text-center text-muted-foreground text-sm">
					{emptyText}
				</SettingsCard>
			) : (
				<SettingsGroup>
					{entries.map(([id, rule]) => (
						<SettingsItem
							actions={
								<div className="flex shrink-0 items-center gap-1">
									<BudgetRuleDialog
										agentIdReadOnly
										description="Update the charged-spend cap, categories, or action for this entry."
										idLabel={editIdLabel}
										initial={{
											agentId: id,
											include: {
												...DEFAULT_BUDGET_INCLUSION,
												...rule.include,
											},
											limitUsd: microUsdToBudgetInput(rule.limit),
											action: rule.action,
											// Seeded, not defaulted: without this the edit dialog opens
											// at `silent` and Save demotes a rule that was fanning out.
											alert: rule.alert ?? "silent",
											downgrade_to: rule.downgrade_to ?? "",
											restrict_max_tokens: String(
												rule.restrict_max_tokens ?? 256
											),
										}}
										onSave={async (form) => {
											await onSave(id, formToRule(form));
										}}
										target={target}
										title="Edit budget"
										trigger={
											<Button
												disabled={!canConfigure}
												size="icon"
												variant="ghost"
											>
												<HugeiconsIcon
													className="size-3.5"
													icon={PencilEdit01Icon}
												/>
												<span className="sr-only">Edit budget for {id}</span>
											</Button>
										}
									/>
									<Button
										disabled={!canConfigure || removingId === id}
										onClick={() => void remove(id)}
										size="icon"
										variant="ghost"
									>
										<HugeiconsIcon
											className="size-3.5 text-status-destructive"
											icon={Delete01Icon}
										/>
										<span className="sr-only">Remove budget for {id}</span>
									</Button>
									{removeError?.id === id ? (
										<div className="flex items-center gap-2">
											<p
												className="text-status-destructive text-xs"
												role="alert"
											>
												Couldn't remove budget: {removeError.message}
											</p>
											<Button
												disabled={removingId === id}
												loading={removingId === id}
												onClick={() => void remove(id)}
												size="sm"
												variant="ghost"
											>
												Retry
											</Button>
										</div>
									) : null}
								</div>
							}
							key={id}
							title={
								<span className="flex min-w-0 flex-col">
									<span className="truncate">{id}</span>
									<span className="text-muted-foreground text-xs">
										{rule.limit === 0
											? "unlimited"
											: `${formatBudgetUsd(rule.limit)} spend`}
										{" · "}
										{ACTION_LABELS[rule.action] ?? rule.action}
										{rule.action === "downgrade" && rule.downgrade_to
											? ` → ${rule.downgrade_to}`
											: null}
										{rule.action === "restrict" && rule.restrict_max_tokens
											? ` (max ${rule.restrict_max_tokens})`
											: null}
										{/* Only shown once raised: `silent` is every rule's default, so
										    printing it on every row would be noise. */}
										{rule.alert && rule.alert !== "silent"
											? ` · notifies ${ALERT_TIER_LABELS[rule.alert]}`
											: null}
									</span>
								</span>
							}
						/>
					))}
				</SettingsGroup>
			)}
		</SettingsSection>
	);
}

/**
 * The single global per-session charged-spend cap (#510). Unlike user/agent budgets
 * this is one rule, not a map, so it renders as an inline field set (limit +
 * action + conditional downgrade/restrict) with its own Save button.
 */
function SessionBudgetEditor({
	rule,
	onSave,
	canConfigure,
	target,
}: {
	rule: BudgetRule;
	onSave: (rule: BudgetRule) => Promise<void>;
	/** When false the caller lacks `gateway.configure`; save disabled. */
	canConfigure: boolean;
	/** Node target — powers the "Downgrade to model" catalog picker. */
	target: ApiTarget;
}) {
	const [limitUsd, setLimitUsd] = useState(microUsdToBudgetInput(rule.limit));
	const [action, setAction] = useState<BudgetAction>(rule.action);
	const [include, setInclude] = useState<BudgetChargeInclusion>({
		...DEFAULT_BUDGET_INCLUSION,
		...rule.include,
	});
	// `SessionBudgetConfig.alert` exists in Rust (crates/gateway/budget/src/lib.rs)
	// and the pipeline folds a session decision's tier into the same `max_tier` as
	// user/agent rules, so leaving it out of this editor made the session cap's tier
	// reachable only by hand-editing gateway.toml — and wiped it on every save.
	const [alert, setAlert] = useState<GatewayAlertTier>(rule.alert ?? "silent");
	const [downgradeTo, setDowngradeTo] = useState(rule.downgrade_to ?? "");
	const [restrictMax, setRestrictMax] = useState(
		String(rule.restrict_max_tokens ?? 256)
	);
	const [saving, setSaving] = useState(false);
	const [saveError, setSaveError] = useState<string | null>(null);
	const [saveOk, setSaveOk] = useState(false);

	const handleSave = async () => {
		const limitMicroUsd = budgetUsdToMicroUsd(limitUsd);
		if (limitMicroUsd === null) {
			setSaveError(
				"Spend cap must be a non-negative USD amount (up to 6 decimals)."
			);
			return;
		}
		const next = buildBudgetRule({
			limit: limitMicroUsd,
			action,
			alert,
			downgradeTo,
			include,
			restrictMaxTokens: restrictMax,
		});
		setSaving(true);
		setSaveError(null);
		setSaveOk(false);
		try {
			await onSave(next);
			setSaveOk(true);
			setTimeout(() => setSaveOk(false), 3000);
		} catch (e) {
			setSaveError(
				e instanceof Error ? e.message : "Failed to save session budget."
			);
		} finally {
			setSaving(false);
		}
	};

	return (
		<SettingsSection
			caption="One spend cap applied to every chat session (keyed by session id). Set the cap to 0 to turn it off."
			headerAction={
				<Button
					disabled={!canConfigure}
					loading={saving}
					onClick={() => handleSave()}
					size="sm"
					variant="ghost"
				>
					Save
				</Button>
			}
			title="Per-session (global)"
		>
			<SettingsGroup>
				<SettingsItem
					actions={
						<Input
							className="w-32"
							id="session-budget-limit"
							min={0}
							onChange={(e) => {
								setLimitUsd(e.target.value);
								setSaveOk(false);
							}}
							placeholder="0 = off"
							step="0.01"
							type="number"
							value={limitUsd}
						/>
					}
					description="Lifetime charged spend per session. 0 = unlimited (off). The Gateway stores this as micro-USD."
					title={<Label htmlFor="session-budget-limit">Spend cap (USD)</Label>}
				/>
			</SettingsGroup>
			{/* The inclusion fields are a plain list of checkbox rows; the card
			    gives them the same surface as the rows above. */}
			<SettingsCard className="py-2.5">
				<BudgetChargeInclusionFields
					idPrefix="session-budget-include"
					onChange={(next) => {
						setInclude(next);
						setSaveOk(false);
					}}
					value={include}
				/>
			</SettingsCard>
			<SettingsGroup>
				<SettingsItem
					actions={
						<Select
							items={ACTION_LABELS}
							onValueChange={(v) => {
								if (v) {
									setAction(v);
									setSaveOk(false);
								}
							}}
							value={action}
						>
							<SelectTrigger id="session-budget-action">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{
									/* SAFETY: This authored complete string-label map is checked against its closed native domain key union; Object.entries returns its own keys but erases their literal-key types. */ (
										Object.entries(ACTION_LABELS) as [BudgetAction, string][]
									).map(([val, label]) => (
										<SelectItem key={val} value={val}>
											<span className="font-medium">{label}</span>
											<span className="ml-1 text-muted-foreground text-xs">
												— {ACTION_DESCRIPTIONS[val]}
											</span>
										</SelectItem>
									))
								}
							</SelectContent>
						</Select>
					}
					title={
						<Label htmlFor="session-budget-action">
							Action when spend cap is reached
						</Label>
					}
				/>
				{action === "downgrade" ? (
					<SettingsItem
						actions={
							<AgentModelPickerField
								ariaLabel="Downgrade to model"
								mode="model"
								onChange={(next) => {
									setDowngradeTo(next);
									setSaveOk(false);
								}}
								placeholder="e.g. gpt-4o-mini"
								target={target}
								value={downgradeTo}
							/>
						}
						description="Model to route to once the session cap is exhausted. Falls back to Restrict if left empty."
						title={
							<Label htmlFor="session-budget-downgrade-to">
								Downgrade to model
							</Label>
						}
					/>
				) : null}
				{action === "restrict" ? (
					<SettingsItem
						actions={
							<Input
								className="w-32"
								id="session-budget-restrict-max"
								min={1}
								onChange={(e) => {
									setRestrictMax(e.target.value);
									setSaveOk(false);
								}}
								placeholder="256"
								type="number"
								value={restrictMax}
							/>
						}
						title={
							<Label htmlFor="session-budget-restrict-max">
								Max tokens cap
							</Label>
						}
					/>
				) : null}
				<SettingsItem
					actions={
						<AlertTierSelect
							id="session-budget-alert"
							onChange={(next) => {
								setAlert(next);
								setSaveOk(false);
							}}
							value={alert}
						/>
					}
					description={ALERT_TIER_TARGETS_NOTE}
					title={
						<Label htmlFor="session-budget-alert">
							Notify when this cap fires
						</Label>
					}
				/>
			</SettingsGroup>
			{saveError ? (
				<p className="px-3.5 text-sm text-status-destructive">{saveError}</p>
			) : null}
			{saveOk ? (
				<p className="px-3.5 text-sm text-status-success">
					Saved. Changes take effect immediately.
				</p>
			) : null}
		</SettingsSection>
	);
}

/**
 * Command-approval gate: scan every ACP agent's native tool calls (Claude/Codex
 * `Bash`/`Write`/`Edit`, …) through the gateway command-approval scanner at the
 * `request_permission` seam before they run. Backed by the `exec-approval-mode`
 * Core preference; Core applies preference writes to the live scanner unless an
 * operator environment override takes precedence. When on, the scan is fail-closed and defers to the
 * firewall / allow-deny rules configured in the cards above.
 */
function CommandApprovalCard({
	target,
	canConfigure,
}: {
	target: ApiTarget;
	canConfigure: boolean;
}) {
	// Armed by default (matches Core: unset pref scans; explicit off disarms).
	const [enabled, setEnabled] = useState(true);
	const [loaded, setLoaded] = useState(false);
	const [saving, setSaving] = useState(false);
	const [status, setStatus] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		setLoaded(false);
		getExecApprovalEnabled(target)
			.then((value) => {
				if (!cancelled) {
					setEnabled(value);
					setLoaded(true);
				}
			})
			.catch(() => {
				if (!cancelled) {
					setStatus(
						"Could not load command approval. Reopen settings to retry."
					);
				}
			});
		return () => {
			cancelled = true;
		};
	}, [target]);

	const handleToggle = async (next: boolean) => {
		if (!(canConfigure && loaded) || saving) {
			return;
		}
		const previous = enabled;
		setSaving(true);
		setEnabled(next);
		setStatus(null);
		try {
			await setExecApprovalEnabled(target, next);
			setStatus(
				next
					? "Enabled. Saved for this node."
					: "Disabled. Saved for this node."
			);
		} catch {
			setEnabled(previous);
			setStatus("Failed to update.");
		} finally {
			setSaving(false);
		}
	};

	return (
		<SettingsSection
			caption="Pre-scan every agent's native tool calls (Claude/Codex Bash, Write, Edit, and the rest) through the command-approval scanner before they run, closing the gap where an agent's own file/shell tools bypassed the gateway. On by default and fail-closed: it defers to the firewall and allow/deny rules above, headless runs reject commands that need human approval. Changes apply immediately unless an operator environment override takes precedence."
			title="Command approval"
		>
			<div className="flex flex-col gap-3">
				<SettingsGroup>
					<SettingsItem
						actions={
							<Switch
								checked={enabled}
								disabled={!(canConfigure && loaded) || saving}
								id="exec-approval-enabled"
								onCheckedChange={handleToggle}
							/>
						}
						description="Scan native agent tool calls at the ACP permission seam"
						title="Scan agent tool commands"
					/>
				</SettingsGroup>
				{status ? (
					<p className="px-3.5 text-muted-foreground text-sm">{status}</p>
				) : null}
			</div>
		</SettingsSection>
	);
}

// ── Hierarchical firewall / DLP cascade (node → org → agent) ──────────────────
//
// The guardrails surface edits a THREE-LEVEL policy cascade. The node base
// (`config.firewall`) is the box admin's baseline; per-org and per-agent
// overlays (`firewall_org_overlays` / `firewall_agent_overlays`) tighten it.
// Every overlay scalar is tri-state: set (override) or unset (inherit the
// broader scope). A broader scope can freeze a field (`locked_fields`); a
// narrower scope then sees it read-only. The gateway resolver is the
// enforcement truth — the lock indicators here are advisory (they can only see
// node → org / node → agent locally, not the request-time org binding).

type FwScope = "node" | "org" | "agent";

/**
 * Everything a scoped guardrail control needs: the shared editor context from
 * `@ryu/blocks`, bound to this dialog's gateway wire types so the desktop-only
 * cards below (inspector, evaluators) can read the inspector and evaluator
 * slots the shared shape leaves out.
 */
type ScopeCtx = GuardrailScopeCtx<GatewayFirewallView, GatewayFirewallOverlay>;

const INSPECTOR_MODE_ITEMS: { value: InspectorMode; label: string }[] = [
	{ value: "injection", label: "Injection — jailbreak / prompt-injection" },
	{ value: "dlp", label: "DLP — PII / secret leaks" },
	{ value: "both", label: "Both" },
];

/** Clamp a numeric text input to a non-negative integer. */
function clampInt(raw: string, min: number): number {
	const n = Number.parseInt(raw, 10);
	if (Number.isNaN(n) || n < min) {
		return min;
	}
	return n;
}

function InspectorCard({
	ctx,
	target,
	pipelineStages,
}: {
	ctx: ScopeCtx;
	target: ApiTarget;
	pipelineStages?: string[];
}) {
	const nodeInspector = ctx.node.inspector ?? DEFAULT_INSPECTOR;
	const broaderLocked = ctx.broaderLocked.has("inspector");
	const overlayInspector = ctx.overlay.inspector ?? null;
	const overriding = overlayInspector !== null;
	const effective = overriding ? overlayInspector : nodeInspector;

	const patchInspector = (patch: Partial<InspectorConfig>) => {
		if (ctx.isOverlay) {
			ctx.setOverlayField({ inspector: { ...effective, ...patch } });
		} else {
			ctx.setNodeField({ inspector: { ...nodeInspector, ...patch } });
		}
	};

	const setOverride = (on: boolean) => {
		ctx.setOverlayField({ inspector: on ? { ...nodeInspector } : null });
	};

	const editorDisabled =
		ctx.disabled || (ctx.isOverlay && !(ctx.overlayReady && overriding));

	const classifyTier = useClassifyTier(target, !broaderLocked);
	// What the gateway will ACTUALLY ask, mirrored so this card judges the model the
	// gateway uses rather than the empty string in the box: `de_inspector_model`
	// (apps/gateway/src/config.rs) resolves a blank to the classify-tier classifier
	// as it reads the wire.
	//
	// DISPLAY ONLY — and that is exactly how a real bug hid here. This line made the
	// card behave as if a blank box were already the classifier, while the save path
	// shipped the literal blank; Core reads the proxied body BEFORE the gateway
	// resolves anything (`maybe_start_classify_tier`), took the blank as "no classify
	// selection", and never started the sidecar — so with weights on disk the tier
	// stayed `idle`, `unservedModel` below stayed false, and nothing warned. The save
	// path now normalizes for real (`withResolvedInspectorModels` in lib/api/gateway),
	// so this mirror and the persisted value finally agree.
	const resolvedModel = effective.model.trim() || CLASSIFY_MODEL_ID;
	// The trap the empty box used to be, in its remaining form: the inspector is
	// pointed at the LOCAL classifier on a node that cannot serve it. The call then
	// errors, and the inspector fails open by design (a timeout or provider error is
	// treated as not-flagged), so the guardrail reports "on", shows a Block action,
	// and allows every single turn. Nothing else in this card can reveal that — it is
	// a property of the node, not of the config.
	//
	// The REACHABLE form of it is `unweighted`: the classifier GGUF's onboarding
	// download is non-fatal, and the sidecar it feeds is registered either way, so a
	// node whose download failed looks identical in the run state and bails on every
	// start attempt (logged at `debug`, so nothing surfaces it).
	const unservedModel =
		effective.enabled &&
		classifyTierCannotServeModel(classifyTier, resolvedModel);
	const unservedReason =
		classifyTier === "absent" || classifyTier === "unweighted"
			? CLASSIFY_TIER_COPY[classifyTier].reason
			: null;

	return (
		<SettingsSection
			caption="An optional cheap-LLM traffic inspector that runs alongside the regex scanner on inbound turns. It is a swappable detection method, orthogonal to the policy action. Fail-open: any timeout or error allows the turn."
			headerAction={
				<div className="flex items-center gap-2">
					<PipelineBadge
						active={pipelineStages?.includes("inspector") ?? true}
					/>
					{ctx.isOverlay ? null : (
						<LockToggle
							disabled={ctx.disabled}
							fieldLabel="LLM inspector"
							locked={ctx.lockedHere.has("inspector")}
							onToggle={() => ctx.toggleLock("inspector")}
						/>
					)}
				</div>
			}
			title="LLM inspector"
		>
			{broaderLocked ? (
				<SettingsCard>
					<LockedByBroader
						summary={`Inspector locked (${effective.enabled ? "on" : "off"})`}
					/>
				</SettingsCard>
			) : (
				<SettingsGroup>
					{ctx.isOverlay ? (
						<SettingsItem
							actions={
								<Switch
									aria-label="Override inspector"
									checked={overriding}
									disabled={ctx.disabled || !ctx.overlayReady}
									id="inspector-override"
									onCheckedChange={setOverride}
								/>
							}
							description={
								overriding
									? "Override the inherited inspector for this scope"
									: `Inherits the node inspector (${nodeInspector.enabled ? "on" : "off"})`
							}
							title="Override inspector"
						/>
					) : null}
					<SettingsItem
						actions={
							<Switch
								aria-label="Enable LLM inspector"
								checked={effective.enabled}
								disabled={editorDisabled}
								id="inspector-enabled"
								onCheckedChange={(c: boolean) => patchInspector({ enabled: c })}
							/>
						}
						description="Run the inspector on inbound turns"
						title="Enabled"
					/>
					{/* The description describes the WIRE, not the box: the substitution
					    happens in the save transport (`withResolvedInspectorModels`), so
					    the field itself still renders empty until the next refetch. The
					    old copy promised "the box is never really blank" and credited a
					    gateway-side substitution that lands too late to keep the local
					    classifier running. */}
					<SettingsItem
						actions={
							<AgentModelPickerField
								ariaLabel="Inspector model"
								disabled={editorDisabled}
								mode="model"
								onChange={(next) => patchInspector({ model: next })}
								placeholder="Local classifier (Gemma 3 270M)"
								target={target}
								value={effective.model}
							/>
						}
						description="Any routable model id. Leave empty for this node's local classifier (Gemma 3 270M). Saving writes that id explicitly, because a blank value would leave the local classifier stopped."
						title={<Label htmlFor="inspector-model">Model</Label>}
					>
						{unservedModel ? (
							<p className="text-status-destructive text-xs">
								The inspector is on and pointed at the local classifier, but{" "}
								{unservedReason}. The inspection call will fail, and the
								inspector fails open, so it will allow every turn while still
								reporting as enabled. Pick a model this node can reach.
							</p>
						) : null}
						{/* Judged on the RESOLVED model, so a blank box doesn't offer
						    "Use it" for the model the gateway already substitutes. */}
						<ClassifyTierNote
							disabled={editorDisabled}
							onUse={() => patchInspector({ model: CLASSIFY_MODEL_ID })}
							state={classifyTier}
							value={resolvedModel}
						/>
					</SettingsItem>
					<SettingsItem
						actions={
							<Select
								disabled={editorDisabled}
								items={INSPECTOR_MODE_ITEMS}
								onValueChange={(v) => patchInspector({ mode: v ?? "both" })}
								value={effective.mode}
							>
								<SelectTrigger className="w-64" id="inspector-mode">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{INSPECTOR_MODE_ITEMS.map((it) => (
										<SelectItem key={it.value} value={it.value}>
											{it.label}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						}
						title={<Label htmlFor="inspector-mode">Mode</Label>}
					/>
					<SettingsItem
						actions={
							<Select
								disabled={editorDisabled}
								items={POLICY_OPTIONS}
								onValueChange={(v) =>
									patchInspector({
										action: v ?? "warn_and_continue",
									})
								}
								value={effective.action}
							>
								<SelectTrigger className="w-64" id="inspector-action">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{POLICY_OPTIONS.map((opt) => (
										<SelectItem key={opt.value} value={opt.value}>
											{opt.label}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						}
						title={<Label htmlFor="inspector-action">Action on flag</Label>}
					/>
					<SettingsItem
						actions={
							<Input
								className="w-28"
								disabled={editorDisabled}
								id="inspector-min-chars"
								inputMode="numeric"
								onChange={(e) =>
									patchInspector({ min_chars: clampInt(e.target.value, 0) })
								}
								value={String(effective.min_chars)}
							/>
						}
						title={<Label htmlFor="inspector-min-chars">Min characters</Label>}
					/>
					<SettingsItem
						actions={
							<Input
								className="w-28"
								disabled={editorDisabled}
								id="inspector-timeout"
								inputMode="numeric"
								onChange={(e) =>
									patchInspector({ timeout_ms: clampInt(e.target.value, 0) })
								}
								value={String(effective.timeout_ms)}
							/>
						}
						title={<Label htmlFor="inspector-timeout">Timeout (ms)</Label>}
					/>
				</SettingsGroup>
			)}
		</SettingsSection>
	);
}

// ── Evaluators card (inline guardrail surface) ────────────────────────────────
//
// The shared evaluator catalog, filtered to inline-capable entries. Enabling an
// evaluator writes an `EvaluatorBinding` into the current scope's firewall
// config (`ctx.node.evaluators` / the overlay's `evaluators`), so it persists
// through the same "Save guardrails" PUT as the firewall dials — no separate
// save. A binding a broader scope locked renders read-only (cannot loosen).
// Create-from-scratch launches the shared editor dialog; that path DOES restart
// the gateway (custom evaluators are a startup snapshot), so the catalog reloads
// after a save.

function evalBindingFor(
	bindings: EvaluatorBinding[],
	id: string
): EvaluatorBinding | undefined {
	return bindings.find((b) => b.id === id);
}

function EvaluatorsCard({
	target,
	ctx,
	pipelineStages,
}: {
	target: ApiTarget;
	ctx: ScopeCtx;
	pipelineStages?: string[];
}) {
	const [catalog, setCatalog] = useState<Evaluator[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [search, setSearch] = useState("");
	const [editorMode, setEditorMode] = useState<EvaluatorEditorMode | null>(
		null
	);
	const [reloadKey, setReloadKey] = useState(0);
	const [deletingId, setDeletingId] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		setLoading(true);
		fetchEvaluators(target)
			.then((list) => {
				if (!cancelled) {
					setCatalog(list);
					setError(null);
				}
			})
			.catch((e) => {
				if (!cancelled) {
					setError(
						e instanceof Error ? e.message : "Failed to load evaluator catalog"
					);
				}
			})
			.finally(() => {
				if (!cancelled) {
					setLoading(false);
				}
			});
		return () => {
			cancelled = true;
		};
	}, [target, reloadKey]);

	const byId = useMemo(() => new Map(catalog.map((e) => [e.id, e])), [catalog]);
	const items = useMemo(() => catalog.map(toCatalogItem), [catalog]);
	const customSet = useMemo(() => catalog.filter((e) => !e.builtin), [catalog]);
	const allIds = useMemo(() => catalog.map((e) => e.id), [catalog]);

	const bindings: EvaluatorBinding[] = ctx.isOverlay
		? (ctx.overlay.evaluators ?? [])
		: (ctx.node.evaluators ?? []);

	const setBindings = (next: EvaluatorBinding[]) => {
		if (ctx.isOverlay) {
			ctx.setOverlayField({ evaluators: next });
		} else {
			ctx.setNodeField({ evaluators: next });
		}
	};

	// Node bindings that a narrower (overlay) scope sees as locked-by-broader.
	const broaderLocked = useMemo(() => {
		const m = new Map<string, EvaluatorBinding>();
		if (ctx.isOverlay) {
			for (const b of ctx.node.evaluators ?? []) {
				if (b.locked) {
					m.set(b.id, b);
				}
			}
		}
		return m;
	}, [ctx.isOverlay, ctx.node.evaluators]);

	const upsert = (id: string, patch: Partial<EvaluatorBinding>) => {
		const existing = evalBindingFor(bindings, id);
		const base: EvaluatorBinding = existing ?? {
			id,
			enabled: false,
			inlineAction: byId.get(id)?.inline?.action ?? "warn_and_continue",
			locked: false,
		};
		const next = bindings.filter((b) => b.id !== id);
		next.push({ ...base, ...patch });
		setBindings(next);
	};

	const handleDeleteCustom = async (id: string) => {
		setDeletingId(id);
		try {
			await deleteCustomEvaluator(target, id, customSet);
			setReloadKey((k) => k + 1);
		} catch (e) {
			setError(e instanceof Error ? e.message : "Failed to delete evaluator");
		} finally {
			setDeletingId(null);
		}
	};

	const renderControl = (item: EvaluatorCatalogItem) => {
		const locked = broaderLocked.get(item.id);
		if (locked) {
			const label = POLICY_LABELS[locked.inlineAction ?? "warn_and_continue"];
			return <LockedByBroader summary={`Locked (${label})`} />;
		}
		const binding = evalBindingFor(bindings, item.id);
		const enabled = binding?.enabled ?? false;
		const action =
			binding?.inlineAction ??
			byId.get(item.id)?.inline?.action ??
			"warn_and_continue";
		return (
			<div className="flex items-center gap-1.5">
				{enabled ? (
					<Select
						disabled={ctx.disabled}
						items={POLICY_OPTIONS}
						onValueChange={(v) =>
							upsert(item.id, {
								inlineAction: v ?? "warn_and_continue",
							})
						}
						value={action}
					>
						<SelectTrigger
							appearance="gateway-action"
							aria-label={`${item.name} action`}
							className="w-28"
						>
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{POLICY_OPTIONS.map((opt) => (
								<SelectItem key={opt.value} value={opt.value}>
									{POLICY_LABELS[opt.value]}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				) : null}
				<Switch
					aria-label={`Enable ${item.name}`}
					checked={enabled}
					disabled={ctx.disabled || deletingId === item.id}
					onCheckedChange={(c: boolean) =>
						upsert(item.id, { enabled: c, inlineAction: action })
					}
				/>
				{ctx.isOverlay || !enabled ? null : (
					<LockToggle
						disabled={ctx.disabled}
						fieldLabel={item.name}
						locked={binding?.locked ?? false}
						onToggle={() =>
							upsert(item.id, { locked: !(binding?.locked ?? false) })
						}
					/>
				)}
			</div>
		);
	};

	return (
		<SettingsSection
			caption="Enable typed evaluators as inline guardrails at this scope. Each runs on the request/response path with a Block / Warn / Sanitize action. Offline-only evaluators (quality, conversation, trajectory, voice) are not shown here; they live on the agent Evals surface. A ‘not yet enforced’ evaluator is catalogued but not wired to execution yet."
			headerAction={
				<PipelineBadge
					active={pipelineStages?.includes("inline-input") ?? true}
				/>
			}
			title="Evaluators"
		>
			{/* This list shows only inline-capable evaluators and the Gateway never
			    runs code inline, so it offers the judge editor alone; a code
			    evaluator would be saved but never listed here. The agent Evals
			    surface creates code evaluators. */}
			<EvaluatorCatalog
				disabled={ctx.disabled}
				error={error}
				items={items}
				loading={loading}
				mode="inline"
				onCreateJudge={() => setEditorMode("judge")}
				onDeleteCustom={(id) => {
					handleDeleteCustom(id).catch(() => undefined);
				}}
				onSearchChange={setSearch}
				renderControl={renderControl}
				search={search}
			/>
			<EvaluatorEditorDialog
				existingCustom={customSet}
				existingIds={allIds}
				mode={editorMode ?? "judge"}
				onOpenChange={(o) => {
					if (!o) {
						setEditorMode(null);
					}
				}}
				onSaved={() => setReloadKey((k) => k + 1)}
				open={editorMode !== null}
				target={target}
			/>
		</SettingsSection>
	);
}

const SCOPE_ITEMS: { value: FwScope; label: string }[] = [
	{ value: "node", label: "Node (baseline)" },
	{ value: "org", label: "Org overlay" },
	{ value: "agent", label: "Agent overlay" },
];

/** Scope-aware copy for the Guardrails card (replaces the old global caption). */
function scopeCaption(scope: FwScope, id: string): string {
	if (scope === "org") {
		const who = id ? `org "${id}"` : "an org";
		return `Editing the overlay for ${who}. Unset fields inherit the node baseline; set fields apply to every session in this org. A field the node locked is read-only here.`;
	}
	if (scope === "agent") {
		const who = id ? `agent "${id}"` : "an agent";
		return `Editing the overlay for ${who}. Unset fields inherit the node baseline; set fields apply only to this agent. A field a broader scope locked is read-only here.`;
	}
	return "Node baseline: applies to every session on this node unless a narrower scope (org or agent) overrides it. Lock a field so narrower scopes cannot loosen it. Changes persist to gateway.toml.";
}

/**
 * The Guardrails surface: one source of truth (the full gateway config) feeding
 * the Firewall, DLP, and Inspector cards across the node → org → agent scope
 * cascade. Editing a scope writes that scope's overlay (or the node base); Save
 * PUTs the node firewall plus BOTH overlay stores in one full-replacement patch,
 * so the cards can never clobber each other's slice.
 */
function GuardrailsSection({
	target,
	reachable,
	canConfigure,
}: {
	target: ApiTarget;
	reachable: boolean;
	/** When false the caller lacks `gateway.configure`; controls read-only. */
	canConfigure: boolean;
}) {
	const [config, setConfig] = useState<GatewayConfig | null>(null);
	const [draft, setDraft] = useState<GatewayConfig | null>(null);
	const [configError, setConfigError] = useState<string | null>(null);
	const [scope, setScope] = useState<FwScope>("node");
	const [orgId, setOrgId] = useState("");
	const [agentId, setAgentId] = useState("");
	const [reloadKey, setReloadKey] = useState(0);
	const [saving, setSaving] = useState(false);
	const [saveError, setSaveError] = useState<string | null>(null);
	const [saveOk, setSaveOk] = useState(false);

	useEffect(() => {
		if (!reachable || config !== null) {
			return;
		}
		let cancelled = false;
		setConfigError(null);
		fetchGatewayConfig(target)
			.then((cfg) => {
				if (!cancelled) {
					setConfig(cfg);
					setDraft(cfg);
					setConfigError(null);
				}
			})
			.catch((e) => {
				if (!cancelled) {
					setConfigError(
						e instanceof ApiError && e.serverMessage
							? e.serverMessage
							: e instanceof Error
								? e.message
								: "Failed to load guardrails config"
					);
				}
			});
		return () => {
			cancelled = true;
		};
	}, [reachable, config, reloadKey, target]);

	const clearSaveState = () => {
		setSaveOk(false);
		setSaveError(null);
	};

	const overlayStoreKey =
		scope === "org" ? "firewall_org_overlays" : "firewall_agent_overlays";
	const activeId = (scope === "org" ? orgId : agentId).trim();
	const overlayReady = scope === "node" ? true : activeId.length > 0;

	const setNodeField = (patch: Partial<GatewayFirewallConfig>) => {
		setDraft((prev) =>
			prev ? { ...prev, firewall: { ...prev.firewall, ...patch } } : prev
		);
		clearSaveState();
	};

	const setOverlayField = (patch: Partial<GatewayFirewallOverlay>) => {
		if (scope === "node" || !overlayReady) {
			return;
		}
		setDraft((prev) => {
			if (!prev) {
				return prev;
			}
			const store = { ...prev[overlayStoreKey] };
			store[activeId] = { ...store[activeId], ...patch };
			return { ...prev, [overlayStoreKey]: store };
		});
		clearSaveState();
	};

	const toggleLock = (field: string) => {
		setDraft((prev) => {
			if (!prev) {
				return prev;
			}
			const locked = new Set(prev.firewall.locked_fields ?? []);
			if (locked.has(field)) {
				locked.delete(field);
			} else {
				locked.add(field);
			}
			return {
				...prev,
				firewall: { ...prev.firewall, locked_fields: Array.from(locked) },
			};
		});
		clearSaveState();
	};

	/** Another surface changed the guardrails: reload the settings that won. */
	const showSaveConflict = () => {
		setConfig(null);
		setDraft(null);
		setSaveError(
			"Guardrails changed elsewhere. The latest settings were reloaded; reapply your changes."
		);
	};

	const handleSave = async () => {
		if (!(draft && config)) {
			return;
		}
		setSaving(true);
		setSaveError(null);
		setSaveOk(false);
		try {
			// The draft is loaded once and replaces all three sections, so re-read
			// first: saving over a change made elsewhere meanwhile (the posture card,
			// another window) would silently revert it. Changes to other sections
			// also move the revision but do not conflict with this save. The read's
			// revision then guards the gap between this read and the write.
			const current = await fetchGatewayConfig(target);
			if (!sameGuardrailSections(config, current)) {
				showSaveConflict();
				return;
			}
			// Sent as-drafted on purpose: `updateGatewayConfig` runs every patch through
			// `withResolvedInspectorModels`, so a blank `inspector.model` becomes the
			// classify id before it reaches Core — which reads this body to decide
			// whether to start `llamacpp-classify` and treats a blank as "no". Do not
			// re-implement that here; the transport is the one seam every firewall save
			// in the app (node base and both overlay stores) passes through.
			await updateGatewayConfig(target, {
				firewall: draft.firewall,
				firewall_org_overlays: draft.firewall_org_overlays,
				firewall_agent_overlays: draft.firewall_agent_overlays,
				expectedRevision: current.configRevision ?? undefined,
			});
			// Re-read the stored result as the baseline the next save compares.
			const saved = await fetchGatewayConfig(target).catch(() => null);
			setConfig(saved ?? draft);
			if (saved) {
				setDraft(saved);
			}
			setSaveOk(true);
			setTimeout(() => setSaveOk(false), 3000);
		} catch (e) {
			if (e instanceof ApiError && e.status === 409) {
				showSaveConflict();
				return;
			}
			setSaveError(
				e instanceof ApiError && e.serverMessage
					? e.serverMessage
					: e instanceof Error
						? e.message
						: "Failed to save guardrails config"
			);
		} finally {
			setSaving(false);
		}
	};

	const overlay: GatewayFirewallOverlay =
		scope === "node" ? {} : (draft?.[overlayStoreKey]?.[activeId] ?? {});
	const broaderLocked = new Set(
		scope === "node" ? [] : (draft?.firewall.locked_fields ?? [])
	);
	const lockedHere = new Set(
		scope === "node"
			? (draft?.firewall.locked_fields ?? [])
			: (overlay.locked_fields ?? [])
	);

	const ctx: ScopeCtx | null = draft
		? {
				scope,
				isOverlay: scope !== "node",
				overlayReady,
				overlayId: scope === "node" ? "" : activeId,
				node: draft.firewall,
				overlay,
				broaderLocked,
				lockedHere,
				disabled: !(reachable && canConfigure),
				setNodeField,
				setOverlayField,
				toggleLock,
			}
		: null;

	const dirty = draft !== config;

	return (
		<div className="flex flex-col gap-4">
			<SettingsSection
				caption="Scope the firewall, DLP, and inspector policy. The node baseline applies everywhere; org and agent overlays tighten it per the node → org → agent cascade."
				title="Policy scope"
			>
				<div className="flex flex-col gap-3">
					{reachable ? null : (
						<SettingsCard className="text-muted-foreground text-sm">
							Gateway unreachable, so controls are disabled. Start the gateway
							and refresh to configure guardrails.
						</SettingsCard>
					)}
					{reachable && configError ? (
						<div role="alert">
							<SettingsCard className="flex flex-wrap items-center justify-between gap-3">
								<p className="min-w-0 flex-1 break-words text-muted-foreground text-sm">
									{configError}
								</p>
								<Button
									onClick={() => setReloadKey((current) => current + 1)}
									size="sm"
									variant="secondary"
								>
									Retry
								</Button>
							</SettingsCard>
						</div>
					) : null}

					<SettingsGroup>
						<SettingsItem
							actions={
								<Select
									disabled={!reachable}
									items={SCOPE_ITEMS}
									onValueChange={(v) => setScope(v ?? "node")}
									value={scope}
								>
									<SelectTrigger className="w-48" id="fw-scope">
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										{SCOPE_ITEMS.map((it) => (
											<SelectItem key={it.value} value={it.value}>
												{it.label}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							}
							title={<Label htmlFor="fw-scope">Scope</Label>}
						/>
						{scope === "org" ? (
							<SettingsItem
								actions={
									<>
										<Input
											className="w-56"
											disabled={!reachable}
											id="fw-org-id"
											list="fw-org-ids"
											onChange={(e) => setOrgId(e.target.value)}
											placeholder="Org id (x-ryu-org-id)"
											value={orgId}
										/>
										<datalist id="fw-org-ids">
											{Object.keys(draft?.firewall_org_overlays ?? {}).map(
												(id) => (
													<option key={id} value={id} />
												)
											)}
										</datalist>
									</>
								}
								description={
									overlayReady
										? undefined
										: "Enter an org id to author its overlay."
								}
								title={<Label htmlFor="fw-org-id">Org id</Label>}
							/>
						) : null}
						{scope === "agent" ? (
							<SettingsItem
								actions={
									<AgentModelPickerField
										ariaLabel="Agent"
										disabled={!reachable}
										mode="agent"
										onChange={setAgentId}
										placeholder="Agent id (x-ryu-agent-id)"
										target={target}
										value={agentId}
									/>
								}
								description={
									overlayReady
										? undefined
										: "Choose or enter an agent id to author its overlay."
								}
								title={<Label htmlFor="fw-agent-id">Agent</Label>}
							/>
						) : null}
					</SettingsGroup>
				</div>
			</SettingsSection>

			{ctx ? (
				<>
					<FirewallCard
						alertNote={ALERT_TIER_TARGETS_NOTE}
						caption={scopeCaption(scope, activeId)}
						ctx={ctx}
					/>
					<DlpCard ctx={ctx} />
					<InspectorCard
						ctx={ctx}
						pipelineStages={draft?.pipeline_stages}
						target={target}
					/>
					<EvaluatorsCard
						ctx={ctx}
						pipelineStages={draft?.pipeline_stages}
						target={target}
					/>
					<div className="flex flex-wrap items-center gap-3 px-3.5">
						<Button
							disabled={!(reachable && dirty && canConfigure)}
							loading={saving}
							onClick={() => handleSave()}
							size="sm"
						>
							Save guardrails
						</Button>
						{saveOk ? (
							<span
								aria-live="polite"
								className="text-sm text-status-success"
								role="status"
							>
								Saved.
							</span>
						) : null}
						{saveError ? (
							<span className="text-sm text-status-destructive" role="alert">
								{saveError}
							</span>
						) : null}
					</div>
				</>
			) : null}

			<CommandApprovalCard canConfigure={canConfigure} target={target} />
			<TrustedFoldersCard canConfigure={canConfigure} target={target} />
			<CatalogScannerCard canConfigure={canConfigure} target={target} />

			{/* Which agents these filters actually see. Every rule above only
			    applies to model calls that traverse the gateway, and three of the
			    four agent families route through it only when opted in — so a
			    guardrails page without this list overstates its own reach. */}
			<AgentEgressSection target={target} />
		</div>
	);
}

/** Gateway-owned choice of which registered, read-only agent reviews catalog
 *  listings after the deterministic scorecard. Stored as a node preference so
 *  every catalog surface and the Security Scanner command share one choice. */
function CatalogScannerCard({
	target,
	canConfigure,
}: {
	target: ApiTarget;
	canConfigure: boolean;
}) {
	const [agentId, setAgentId] = useState("");
	const [loaded, setLoaded] = useState(false);
	const [saving, setSaving] = useState(false);
	const [status, setStatus] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		setLoaded(false);
		getPreference(target, CATALOG_SCAN_AGENT_PREF)
			.then((value) => {
				if (cancelled) {
					return;
				}
				setAgentId(value?.trim() || "");
				setLoaded(true);
			})
			.catch(() => {
				if (!cancelled) {
					setStatus(
						"Could not load the audit agent. Reopen settings to retry."
					);
				}
			});
		return () => {
			cancelled = true;
		};
	}, [target]);

	const updateAgent = async (next: string) => {
		if (saving) {
			return;
		}
		const trimmed = next.trim();
		const previous = agentId;
		setSaving(true);
		setAgentId(trimmed);
		setStatus(null);
		try {
			await setPreference(target, CATALOG_SCAN_AGENT_PREF, trimmed);
			setStatus("Saved for this node.");
		} catch {
			setAgentId(previous);
			setStatus("Could not save the audit agent. Try again.");
		} finally {
			setSaving(false);
		}
	};

	return (
		<div data-testid="catalog-scanner-settings">
			<SettingsSection
				caption="On-demand audits run the health audit skill with your default chat agent. Optionally choose a reviewer for Marketplace, agent health, and Doctor. Normal runtime permissions and approvals apply; static checks remain the default."
				title="Health audit agent"
			>
				<div className="flex flex-col gap-3">
					<SettingsGroup>
						<SettingsItem
							actions={
								<div className="flex items-center gap-1">
									<AgentModelPickerField
										ariaLabel="Catalog scanning agent"
										className="min-w-[220px]"
										disabled={!(canConfigure && loaded) || saving}
										mode="agent"
										onChange={(next) => {
											void updateAgent(next);
										}}
										placeholder="Use default agent"
										target={target}
										value={agentId}
									/>
									<Button
										disabled={!(canConfigure && loaded && agentId) || saving}
										onClick={() => void updateAgent("")}
										size="sm"
										variant="ghost"
									>
										Use default agent
									</Button>
								</div>
							}
							description="Used by Audit with agent across all Health views. Leave unset to follow the default chat agent."
							settingsId="catalog-scan-agent"
							title="Scanning agent"
						/>
					</SettingsGroup>
					{status ? (
						<p className="px-3.5 text-muted-foreground text-sm">{status}</p>
					) : null}
				</div>
			</SettingsSection>
		</div>
	);
}

// ── Audit table panel (M4 / #177) ────────────────────────────────────────────
//
// Read-only view of the gateway's audit log, proxied through Core.
// Columns: timestamp · provider · model · tokens (in/out) · latency ·
// eval_score · error. The api_key column is always "***" from the gateway and
// is intentionally not shown (use the keys card instead).

function formatLatency(ms: number | null): string {
	if (ms === null) {
		return "—";
	}
	if (ms < 1000) {
		return `${ms}ms`;
	}
	return `${(ms / 1000).toFixed(1)}s`;
}

function formatTokens(input: number | null, output: number | null): string {
	if (input === null && output === null) {
		return "—";
	}
	const i = input ?? 0;
	const o = output ?? 0;
	return `${formatNumber(i)} / ${formatNumber(o)}`;
}

function auditEventLabel(entry: AuditEntry): string {
	switch (entry.event_type) {
		case "model_call":
			return "Model call";
		case "exec_call":
			return "Tool execution";
		case "credential_read":
			return "Credential read";
		case "widget_follow_up":
			return "Widget follow-up";
		case "control_change":
			return "Control change";
		default:
			return entry.event_type ?? "Activity";
	}
}

function AuditTable({ entries }: { entries: AuditEntry[] }) {
	return (
		<div className="overflow-x-auto">
			<table className="w-full text-sm">
				<thead>
					<tr className="border-b text-left text-muted-foreground text-xs">
						<th className="pr-3 pb-2 font-medium">Time</th>
						<th className="pr-3 pb-2 font-medium">Event / target</th>
						<th className="pr-3 pb-2 font-medium">Agent / caller</th>
						<th className="pr-3 pb-2 font-medium">Trace IDs</th>
						<th className="pr-3 pb-2 font-medium">Usage</th>
						<th className="pb-2 font-medium">Result</th>
					</tr>
				</thead>
				<tbody>
					{entries.map((entry) => {
						const ts = new Date(entry.timestamp);
						const timeStr = Number.isNaN(ts.getTime())
							? entry.timestamp
							: formatTime(ts);
						return (
							<tr className="border-b last:border-0" key={entry.id}>
								<Tooltip>
									<TooltipTrigger
										render={
											<td className="py-2 pr-3 font-mono text-xs tabular-nums">
												{timeStr}
											</td>
										}
									/>
									<TooltipContent>{entry.timestamp}</TooltipContent>
								</Tooltip>
								<td className="min-w-40 py-2 pr-3">
									<Badge variant="outline">{auditEventLabel(entry)}</Badge>
									<div className="mt-1 max-w-48 truncate font-mono text-xs">
										{entry.command ?? entry.model ?? entry.provider ?? "—"}
									</div>
									<div className="type-compact text-muted-foreground">
										{entry.provider ?? entry.backend ?? "Gateway"}
									</div>
								</td>
								<td className="min-w-40 py-2 pr-3 text-xs">
									<div className="break-all font-mono">
										agent {entry.agent_id ?? "—"}
									</div>
									<div className="mt-1 break-all text-muted-foreground">
										{entry.user_name ?? entry.user_id ?? "system / gateway"}
									</div>
								</td>
								<td className="type-compact min-w-44 py-2 pr-3 font-mono text-muted-foreground">
									<div className="break-all">request {entry.request_id}</div>
									{entry.session_id ? (
										<div className="mt-1 break-all">
											session {entry.session_id}
										</div>
									) : null}
								</td>
								<td className="min-w-32 py-2 pr-3 font-mono text-xs tabular-nums">
									<div>
										{formatTokens(entry.input_tokens, entry.output_tokens)}{" "}
										tokens
									</div>
									<div className="mt-1 text-muted-foreground">
										{formatLatency(entry.latency_ms)}
										{entry.eval_score === null
											? ""
											: ` · ${Math.round(entry.eval_score * 100)}% score`}
									</div>
								</td>
								<td className="max-w-48 py-2 text-xs">
									<Badge variant={entry.error ? "destructive" : "secondary"}>
										{entry.error ? "Failed" : "Recorded"}
									</Badge>
									{entry.error ? (
										<div className="mt-1 max-w-48 break-words text-status-destructive">
											{entry.error}
										</div>
									) : null}
								</td>
							</tr>
						);
					})}
				</tbody>
			</table>
		</div>
	);
}

function AuditPanel({ target }: { target: ApiTarget }) {
	const [entries, setEntries] = useState<AuditEntry[]>([]);
	const [reachable, setReachable] = useState<boolean | null>(null);
	const [loading, setLoading] = useState(false);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [errorsOnly, setErrorsOnly] = useState(false);
	// GatewayDialog rebuilds its ApiTarget object on parent renders (for example,
	// when the status poll or scoped-settings roster resolves). Keep this panel's
	// fetch identity tied to the actual node credentials so those unrelated
	// renders don't re-read the audit log or hide a transient read failure.
	const auditTarget = useMemo(
		() => ({
			token: target.token,
			url: target.url,
			userJwt: target.userJwt ?? null,
		}),
		[target.token, target.url, target.userJwt]
	);

	const load = useCallback(
		async (opts: { errorsOnly: boolean }) => {
			setLoading(true);
			setLoadError(null);
			try {
				const result = await fetchGatewayAudit(auditTarget, {
					errorsOnly: opts.errorsOnly,
					limit: 100,
				});
				setReachable(result.reachable);
				setEntries(result.entries);
			} catch (e) {
				setLoadError(
					e instanceof Error ? e.message : "Failed to load audit log"
				);
			} finally {
				setLoading(false);
			}
		},
		[auditTarget]
	);

	useEffect(() => {
		load({ errorsOnly });
	}, [load, errorsOnly]);

	const handleToggleErrors = (checked: boolean) => {
		setErrorsOnly(checked);
	};

	return (
		<SettingsSection
			caption="Every governed model, tool, credential, widget, and control event. Agent IDs, caller IDs, request IDs, and session IDs make each row followable; API keys, prompts, and tool payloads are always redacted. Newest first."
			headerAction={
				<div className="flex items-center gap-3">
					<div className="flex items-center gap-2">
						<Switch
							checked={errorsOnly}
							id="audit-errors-only"
							onCheckedChange={handleToggleErrors}
						/>
						<Label
							className="cursor-pointer"
							htmlFor="audit-errors-only"
							variant="choice"
						>
							Errors only
						</Label>
					</div>
					<Button
						disabled={loading}
						onClick={() => load({ errorsOnly })}
						size="sm"
						variant="ghost"
					>
						<HugeiconsIcon className="size-4" icon={Refresh01Icon} />
						Refresh
					</Button>
				</div>
			}
			title="Audit log"
		>
			<AuditBody
				entries={entries}
				loadError={loadError}
				loading={loading}
				onRefresh={() => load({ errorsOnly })}
				reachable={reachable}
			/>
		</SettingsSection>
	);
}

// ── Run-evals panel (M4 / #180) ──────────────────────────────────────────────
//
// v1 scorers: latency / token_efficiency / policy_pass / optional substring_match.
// LLM-judge scorers have since shipped, but not on this panel: it posts
// `dataset: []`, so every run replays the gateway's built-in 3-case set, and
// those cases carry no assertions — there is nothing here for a judge to score.
// Authoring cases with an `llm_judge` rubric, and picking the judge model, is
// Prompt Studio's surface; this panel still has no dataset import of its own.

function AuditBody({
	loading,
	loadError,
	onRefresh,
	reachable,
	entries,
}: {
	loading: boolean;
	loadError: string | null;
	onRefresh: () => void;
	reachable: boolean | null;
	entries: AuditEntry[];
}) {
	if (loading) {
		return (
			<SettingsCard>
				<SkeletonRows label="Loading…" spacing="comfortable" />
			</SettingsCard>
		);
	}
	if (loadError) {
		return (
			<AuditNotice
				action={
					<Button onClick={onRefresh} size="sm" variant="secondary">
						Try again
					</Button>
				}
				detail={loadError}
				title="Could not load audit log"
			/>
		);
	}
	if (reachable === false) {
		return (
			<AuditNotice
				action={
					<Button onClick={onRefresh} size="sm" variant="secondary">
						Try again
					</Button>
				}
				detail={
					<>
						The gateway is unreachable or audit logging is disabled. Start the
						gateway with <span className="font-mono">RYU_AUDIT_LOG=1</span> to
						enable audit logging.
					</>
				}
				title="Audit log unavailable"
			/>
		);
	}
	if (entries.length === 0) {
		return (
			<AuditNotice
				action={
					<Button onClick={onRefresh} size="sm" variant="secondary">
						Refresh audit log
					</Button>
				}
				detail="Run a model, tool, or control action through the gateway and refresh to see its trace."
				title="No audit entries yet"
			/>
		);
	}
	return (
		<SettingsCard>
			<AuditTable entries={entries} />
		</SettingsCard>
	);
}

/**
 * The audit panel's non-table states: one card holding a plain sentence, its
 * muted detail, and the recovery action on the right.
 */
function AuditNotice({
	action,
	detail,
	title,
}: {
	action: ReactNode;
	detail: ReactNode;
	title: string;
}) {
	return (
		<SettingsCard className="flex flex-wrap items-center justify-between gap-3">
			<div className="flex min-w-0 flex-1 flex-col gap-0.5">
				<p className="text-sm">{title}</p>
				<p className="break-words text-muted-foreground text-xs">{detail}</p>
			</div>
			{action}
		</SettingsCard>
	);
}

function scoreBarColor(pct: number): string {
	if (pct >= 80) {
		return "bg-success";
	}
	if (pct >= 50) {
		return "bg-warning";
	}
	return "bg-destructive";
}

function scoreBar(value: number) {
	const pct = Math.round(value * 100);
	const color = scoreBarColor(pct);
	const gatewayScoreVariables1: CSSProperties & {
		"--gateway-score-width": string;
	} = { "--gateway-score-width": `${pct}%` };
	return (
		<div className="flex items-center gap-2">
			<div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
				<div
					className={`h-full rounded-full ${color}`}
					data-gateway-score-bar=""
					style={gatewayScoreVariables1}
				/>
			</div>
			<span className="w-10 text-right font-mono text-xs tabular-nums">
				{pct}%
			</span>
		</div>
	);
}

function AggregateCard({ agg }: { agg: EvalRunAggregate }) {
	return (
		<SettingsSection
			caption={`Summary across all ${agg.total_cases} case${agg.total_cases === 1 ? "" : "s"}.`}
			title="Aggregate"
		>
			<SettingsCard className="grid grid-cols-2 gap-x-8 gap-y-3">
				<div>
					<div className="mb-1 text-muted-foreground text-xs">Overall</div>
					{scoreBar(agg.mean_overall)}
				</div>
				<div>
					<div className="mb-1 text-muted-foreground text-xs">Latency</div>
					{agg.latency_available_cases === 0 ? (
						<span className="text-muted-foreground text-sm">Not measured</span>
					) : (
						scoreBar(agg.mean_latency)
					)}
				</div>
				<div>
					<div className="mb-1 text-muted-foreground text-xs">
						Token efficiency
					</div>
					{scoreBar(agg.mean_token_efficiency)}
				</div>
				<div>
					<div className="mb-1 text-muted-foreground text-xs">
						Policy pass rate
					</div>
					{agg.policy_available_cases === 0 ? (
						<span className="text-muted-foreground text-sm">Not measured</span>
					) : (
						scoreBar(agg.policy_pass_rate)
					)}
				</div>
				{agg.mean_substring_match === null ? null : (
					<div>
						<div className="mb-1 text-muted-foreground text-xs">
							Substring match
						</div>
						{scoreBar(agg.mean_substring_match)}
					</div>
				)}
			</SettingsCard>
		</SettingsSection>
	);
}

function CasesTable({ cases }: { cases: EvalCaseScore[] }) {
	return (
		<SettingsSection caption="Per-prompt scores." title="Cases">
			<SettingsCard className="overflow-x-auto">
				<table className="w-full text-sm">
					<thead>
						<tr className="border-b text-left text-muted-foreground text-xs">
							<th className="pr-4 pb-2 font-medium">Prompt</th>
							<th className="pr-4 pb-2 font-medium">Overall</th>
							<th className="pr-4 pb-2 font-medium">Latency</th>
							<th className="pr-4 pb-2 font-medium">Token eff.</th>
							<th className="pr-4 pb-2 font-medium">Policy</th>
							<th className="pb-2 font-medium">Substr.</th>
						</tr>
					</thead>
					<tbody>
						{cases.map((c) => (
							<tr className="border-b last:border-0" key={c.prompt}>
								<td className="max-w-48 truncate py-2 pr-4">
									<Tooltip>
										<TooltipTrigger render={<span>{c.prompt}</span>} />
										<TooltipContent>{c.prompt}</TooltipContent>
									</Tooltip>
								</td>
								<td className="py-2 pr-4 font-mono text-xs tabular-nums">
									{Math.round(c.overall * 100)}%
								</td>
								<td className="py-2 pr-4 font-mono text-xs tabular-nums">
									{c.latency_available === false
										? "—"
										: `${Math.round(c.latency_score * 100)}%`}
								</td>
								<td className="py-2 pr-4 font-mono text-xs tabular-nums">
									{Math.round(c.token_efficiency * 100)}%
								</td>
								<td className="py-2 pr-4">
									{c.policy_available === false ? (
										<span className="text-muted-foreground text-xs">
											not measured
										</span>
									) : (
										<Badge variant={c.policy_pass ? "default" : "destructive"}>
											{c.policy_pass ? "pass" : "fail"}
										</Badge>
									)}
								</td>
								<td className="py-2 font-mono text-xs tabular-nums">
									{c.substring_match === null
										? "—"
										: `${Math.round(c.substring_match * 100)}%`}
								</td>
							</tr>
						))}
					</tbody>
				</table>
			</SettingsCard>
		</SettingsSection>
	);
}

function RunEvalsPanel({ target }: { target: ApiTarget }) {
	const [running, setRunning] = useState(false);
	const [result, setResult] = useState<EvalRunResult | null>(null);
	const [runError, setRunError] = useState<string | null>(null);
	const nodeDefault = useNodeDefaultModel(target);
	const [model, setModel] = useState("");
	// Pre-fill the node's default model once it resolves; a typed id wins.
	const modelEditedRef = useRef(false);
	useEffect(() => {
		if (nodeDefault.model && !modelEditedRef.current) {
			setModel(nodeDefault.model);
		}
	}, [nodeDefault.model]);
	const abortRef = useRef<AbortController | null>(null);
	const runModel = model.trim();

	const handleRun = async () => {
		if (!runModel) {
			return;
		}
		abortRef.current?.abort();
		const ac = new AbortController();
		abortRef.current = ac;
		setRunning(true);
		setRunError(null);
		setResult(null);
		try {
			const res = await runGatewayEvals(
				target,
				{ model: runModel, dataset: [] },
				ac.signal
			);
			setResult(res);
		} catch (e) {
			if (!(e instanceof DOMException && e.name === "AbortError")) {
				setRunError(
					e instanceof ApiError && e.serverMessage
						? e.serverMessage
						: e instanceof Error
							? e.message
							: "Eval run failed."
				);
			}
		} finally {
			setRunning(false);
		}
	};

	return (
		<>
			<SettingsSection
				caption="Replay the built-in 3-case dataset through the gateway pipeline and get a scorecard: latency, token efficiency, policy pass, and optional substring match. LLM-judge scoring needs a per-case rubric; it lives in Prompt Studio."
				title="Run evals"
			>
				<div className="flex flex-col gap-4">
					<SettingsGroup>
						<SettingsItem
							actions={
								<div className="flex items-center gap-2">
									<Input
										className="w-48"
										id="eval-model"
										onChange={(e) => {
											modelEditedRef.current = true;
											setModel(e.target.value);
										}}
										placeholder="Model id"
										value={model}
									/>
									<Button
										disabled={!runModel}
										loading={running}
										onClick={() => {
											handleRun().catch((_e) => undefined);
										}}
										size="sm"
									>
										{running ? "Running…" : "Run"}
									</Button>
								</div>
							}
							description={
								runModel || nodeDefault.loading
									? undefined
									: NO_DEFAULT_MODEL_INPUT_HINT
							}
							title={<Label htmlFor="eval-model">Model</Label>}
						/>
					</SettingsGroup>

					{runError ? (
						<SettingsCard className="text-sm text-status-destructive">
							{runError}
						</SettingsCard>
					) : null}
				</div>
			</SettingsSection>
			{result ? (
				<>
					<AggregateCard agg={result.aggregate} />
					<CasesTable cases={result.cases} />
				</>
			) : null}
		</>
	);
}

/**
 * The built-in gateway sections.
 *
 * `value` is a deep-link key (`openGateway("keys")`, `?section=privacy`, the
 * command palette) — **never rename one**. `label` and `hint` are free to change
 * and are written for someone who has never read a routing doc: the label says
 * what it is, the hint says what it's for, and `keywords` keeps the old
 * developer-facing names ("guardrails", "BYOK", "evals", "audit") searchable so
 * renaming costs nobody their muscle memory.
 */
const GATEWAY_SECTIONS: {
	hint: string;
	icon: IconSvgElement;
	keywords?: string;
	label: string;
	value: GatewaySection;
}[] = [
	{
		value: "overview",
		label: "Overview",
		hint: "Is everything running, and how much has it done.",
		icon: Activity01Icon,
		keywords: "health status metrics requests cache",
	},
	{
		value: "workspace",
		label: "Team & workspace",
		hint: "Who can use this node, and what they're allowed to do.",
		icon: UserGroupIcon,
		keywords: "members seats roles org permissions",
	},
	{
		value: "defaults",
		label: "Default agent & model",
		hint: "What every new chat and agent starts with.",
		icon: SparklesIcon,
		keywords: "defaults fallback global agent model",
	},
	{
		value: "providers",
		label: "AI providers",
		hint: "The AI services this node can use, and which models they offer.",
		icon: CpuIcon,
		keywords: "providers llm openai anthropic local models",
	},
	{
		value: "keys",
		label: "API keys",
		hint: "Your own provider keys, and the keys apps use to reach this node.",
		icon: Key01Icon,
		keywords: "keys byok api token composio replicate fal secrets",
	},
	{
		value: "access",
		label: "Connections",
		hint: "Legacy route for the unified Connections hub.",
		icon: Key01Icon,
		keywords:
			"pair pairing device token access approve revoke browser remote security auth",
	},
	{
		value: "computer",
		label: "Device settings",
		hint: "Choose how Ghost may use this device, including locked-session access.",
		icon: LaptopIcon,
		keywords:
			"computer computers ghost computer use locked lock background accessibility screen recording",
	},
	{
		value: "permissions",
		label: "Permissions",
		hint: "Give a team access to one space, or take it away from someone.",
		icon: UserGroupIcon,
		keywords:
			"permissions acl roles teams grant deny access overwrite rbac who can",
	},
	{
		value: "budgets",
		label: "Spending limits",
		hint: "Cap what can be spent, and what happens when a cap is hit.",
		icon: Dollar01Icon,
		keywords: "budget spend limit cost cap alerts",
	},
	{
		value: "guardrails",
		label: "Safety filters",
		hint: "Block unsafe or private content before it reaches a model.",
		icon: Shield01Icon,
		keywords:
			"guardrails firewall pii moderation safety filter egress agents routing governed bypass",
	},
	{
		value: "traffic-map",
		label: "Traffic map",
		hint: "Watch requests flow through every check to a provider, and open any layer's settings from the map.",
		icon: FlowConnectionIcon,
		keywords:
			"traffic map canvas live topology flow requests blocked layer floor policy provider pulses",
	},
	{
		value: "policies",
		label: "Guardrail policies",
		hint: "Write a policy once and assign it to your organization, teams, members, keys, or agents.",
		icon: PolicyIcon,
		keywords:
			"guardrail policy policies named assign organization team member key agent permissions effective",
	},
	{
		value: "runtime",
		label: "Agent runtime",
		hint: "Bound ACP session lifetime, parallel agents, and sleep behavior on this node.",
		icon: CpuIcon,
		keywords:
			"acp agents idle timeout garbage collection memory oom concurrency parallel keep awake sleep power",
	},
	{
		value: "hooks",
		label: "Hooks",
		hint: "Review and control lifecycle automation from config and plugins.",
		icon: CodeCircleIcon,
		keywords:
			"hooks lifecycle trust plugin config automation review enable disable",
	},
	{
		value: "routing",
		label: "Model routing",
		hint: "Rules that send a request to a different model than the one asked for.",
		icon: GitBranchIcon,
		keywords:
			"routing smart route fallback rewrite mapping credit balance quota low threshold cheaper",
	},
	{
		value: "integrations",
		label: "Integrations",
		hint: "Third-party apps your agents can act through.",
		icon: Share08Icon,
		keywords: "integrations composio apps oauth connect",
	},
	{
		value: "network",
		label: "Network",
		hint: "Connect this node with Tailscale, Headscale, or a short-lived Tailcat address.",
		icon: Share08Icon,
		keywords:
			"network mesh tailscale headscale tailcat tailnet vpn remote peers",
	},
	// Moved from the App Settings dialog (node-level Core infra, not apps).
	{
		value: "connections",
		label: "Connections",
		hint: "Control this device, connect other nodes, and manage SSH hosts.",
		icon: Share08Icon,
		keywords: "connections accounts linked identities devices nodes ssh remote",
	},
	{
		value: "email-alerts",
		label: "Email & alerts",
		hint: "Where this node sends mail, and what it notifies you about.",
		icon: BubbleChatIcon,
		keywords: "email smtp alerts notifications",
	},
	{
		value: "usage",
		label: "Usage & cost",
		hint: "What has been spent, by whom, on which model.",
		icon: Dollar01Icon,
		keywords: "usage cost spend tokens billing report",
	},
	{
		value: "audit",
		label: "Activity log",
		hint: "Every request this node handled, in raw form.",
		icon: Activity01Icon,
		keywords: "audit log trace requests history",
	},
	{
		value: "api",
		label: "API & traffic",
		hint: "Point OpenAI, Anthropic or Gemini clients at this node, manage its API keys, and watch requests live.",
		icon: ApiIcon,
		keywords:
			"api endpoint url server compatible openai anthropic gemini base copy token keys live traffic dashboard sse",
	},
	{
		value: "mcp",
		label: "MCP server",
		hint: "The Model Context Protocol servers this node runs, and the tools they expose.",
		icon: Plug01Icon,
		keywords: "mcp model context protocol server tools claude cursor stdio",
	},
	{
		value: "git",
		label: "Git",
		hint: "Choose defaults for branches, commits, pushes, and pull requests.",
		icon: GitBranchIcon,
		keywords:
			"git branch prefix merge squash force push draft review commit pull request",
	},
	{
		value: "worktrees",
		label: "Worktrees",
		hint: "Choose where managed worktrees live and when old ones are removed.",
		icon: GitBranchIcon,
		keywords: "worktree root fetch upstream auto delete cleanup retention",
	},
	{
		value: "environments",
		label: "Environments",
		hint: "Set up project environments for worktrees and agent actions.",
		icon: Package01Icon,
		keywords: "environment setup cleanup variables actions project worktree",
	},
	{
		value: "cloud-environments",
		label: "Cloud environments",
		hint: "Configure repository setup, internet access, and personal vault entries.",
		icon: Package01Icon,
		keywords: "cloud environment repository install script vault secret vpn",
	},
	{
		value: "import",
		label: "Import agents",
		hint: "Preview setup from Claude, Codex, Cursor, OpenClaw, Hermes, and more before bringing it into Ryu.",
		icon: ArrowDown01Icon,
		keywords:
			"import sync claude codex cursor skills mcp plugins threads sessions",
	},
	{
		value: "export",
		label: "Export Ryu",
		hint: "Write an explicit, versioned Ryu bundle to a selected agent root.",
		icon: ArrowUp01Icon,
		keywords: "export sync bundle conversations sessions acp resume replay",
	},
	{
		value: "evals",
		label: "Quality tests",
		hint: "Score models against a set of prompts and compare the results.",
		icon: Activity01Icon,
		keywords: "evals eval quality benchmark scoring tests",
	},
	{
		value: "privacy",
		label: "Privacy",
		hint: "What leaves this device, and what stays on it.",
		icon: SquareLock01Icon,
		keywords: "privacy telemetry analytics learning data",
	},
	{
		value: "storage",
		label: "Storage",
		hint: "Where files, models, and databases are kept on this device.",
		icon: Key01Icon,
		// "parsing"/"parser"/"pdf" search here on purpose. There is no Document
		// parsing section any more — the parser is bound from the node dropdown's
		// Toolkits row like every other swappable capability, and the only thing
		// that tab owned alone (the node's upload ceiling) is a card on this one.
		keywords:
			"storage disk path database models cache upload limit size parsing parser document pdf docx",
	},
	{
		value: "encryption",
		label: "Encryption",
		hint: "How this device holds its key, and what is encrypted at rest.",
		icon: SquareLock01Icon,
		keywords:
			"encryption encrypted at rest master key keychain custody sealed plaintext coverage",
	},
	{
		value: "updates",
		label: "Updates",
		hint: "Which version each part is on, and how updates are installed.",
		icon: Refresh01Icon,
		keywords: "updates version upgrade channel release",
	},
	{
		value: "health",
		label: "Diagnostics",
		hint: "Start, stop, and check each part when something looks wrong.",
		icon: Shield01Icon,
		keywords: "health diagnostics preflight restart status logs",
	},
	{
		value: "onboarding",
		label: "Onboarding",
		hint: "Choose personal or team context for this node, or run setup again.",
		icon: SparklesIcon,
		keywords: "onboarding setup personal team company context reset first run",
	},
	{
		value: "danger",
		label: "Danger zone",
		hint: "Reset or wipe this node. Read twice before clicking.",
		icon: Delete01Icon,
		keywords: "danger reset wipe delete factory",
	},
];

/** Health + metrics observability block, shown on the Overview tab. */
function OverviewSection({
	canConfigure,
	reachable,
	status,
	metrics,
	target,
}: {
	canConfigure: boolean;
	reachable: boolean;
	status: GatewayStatus | null;
	metrics: GatewayMetrics | null;
	target: ApiTarget;
}) {
	if (!reachable) {
		return (
			<SettingsSection title="Gateway unreachable">
				<SettingsCard className="text-muted-foreground text-sm">
					{`Core is up but could not reach a healthy gateway${status?.url ? ` at ${status.url}` : ""}. Start the gateway, then refresh.`}
				</SettingsCard>
			</SettingsSection>
		);
	}

	const h = status?.health ?? null;

	return (
		<>
			<GatewayPostureCard
				canConfigure={canConfigure}
				reachable={reachable}
				target={target}
			/>
			<SettingsSection
				caption={`${status?.url ?? "gateway"}${h?.version ? ` · v${h.version}` : ""}`}
				title="Health"
			>
				<SettingsGroup>
					<SettingsItem
						actions={
							<Badge variant={h?.status === "ok" ? "default" : "secondary"}>
								{h?.status ?? "unknown"}
							</Badge>
						}
						title="Status"
					/>
					<SettingsItem
						actions={
							<Badge variant="secondary">
								{h?.authRequired ? "auth required" : "no auth"}
							</Badge>
						}
						title="Authentication"
					/>
					<SettingsItem
						actions={
							<span className="text-muted-foreground text-sm tabular-nums">
								{h?.providers.length ?? 0} provider
								{(h?.providers.length ?? 0) === 1 ? "" : "s"}
							</span>
						}
						title="Providers"
					/>
				</SettingsGroup>
			</SettingsSection>

			{metrics ? (
				<>
					<SettingsSection title="Traffic">
						<SettingsCard className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
							<MetricTile
								label="Requests"
								value={formatNumber(metrics.requests.total)}
							/>
							<MetricTile
								label="Errors"
								value={formatNumber(metrics.requests.errors)}
							/>
							<MetricTile
								label="Cache hit rate"
								value={formatPercent(metrics.cache.hitRate)}
							/>
							<MetricTile
								label="Tokens (in/out)"
								value={`${formatNumber(metrics.tokens.input)} / ${formatNumber(metrics.tokens.output)}`}
							/>
						</SettingsCard>
					</SettingsSection>

					<SettingsSection
						caption="Exact and semantic cache hits reduce upstream calls."
						title="Cache"
					>
						<SettingsCard className="grid grid-cols-3 gap-x-4 gap-y-3">
							<MetricTile
								label="Exact hits"
								value={formatNumber(metrics.cache.exactHits)}
							/>
							<MetricTile
								label="Semantic hits"
								value={formatNumber(metrics.cache.semanticHits)}
							/>
							<MetricTile
								label="Misses"
								value={formatNumber(metrics.cache.misses)}
							/>
						</SettingsCard>
					</SettingsSection>

					<SettingsSection
						caption="Requests affected by budget controls and the firewall. (Eval scoring is not yet exposed by the gateway.)"
						title="Budget & policy"
					>
						<SettingsCard className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
							<MetricTile
								label="Budget exceeded"
								value={formatNumber(metrics.requests.budgetExceeded)}
							/>
							<MetricTile
								label="Budget downgraded"
								value={formatNumber(metrics.requests.budgetDowngraded)}
							/>
							<MetricTile
								label="Budget restricted"
								value={formatNumber(metrics.requests.budgetRestricted)}
							/>
							<MetricTile
								label="Budget notified"
								value={formatNumber(metrics.requests.budgetNotified)}
							/>
							<MetricTile
								label="Firewall blocked"
								value={formatNumber(metrics.requests.firewallBlocked)}
							/>
							<MetricTile
								label="Rate limited"
								value={formatNumber(metrics.requests.rateLimited)}
							/>
						</SettingsCard>
					</SettingsSection>
				</>
			) : (
				<SettingsSection title="Metrics">
					<SettingsCard className="text-center text-muted-foreground text-sm">
						The gateway is healthy but did not return a metrics snapshot.
					</SettingsCard>
				</SettingsSection>
			)}

			<ProvidersCard metrics={metrics} providers={h?.providers ?? []} />
		</>
	);
}

/**
 * Sidebar-grouped layout for the gateway sections, mirroring the main
 * SettingsDialog (inset sidebar + scrollable content pane).
 */
/**
 * Nav groups, retitled around the question each group answers rather than the
 * subsystem it belongs to ("Policy" / "Observability" / "Node" meant nothing to
 * anyone who hadn't read the code). Order is by how often a person needs it.
 *
 * The "Node" group's position is load-bearing: {@link buildEntityNavGroups}
 * output (manifest-registered app/plugin settings tabs) is spliced in directly
 * before it, so app tabs land above the computer-level infra and below the
 * gateway's own sections.
 */
const GATEWAY_NAV_GROUPS: { items: GatewaySection[]; title?: string }[] = [
	{ items: ["overview", "workspace", "permissions", "defaults"] },
	{
		title: "AI & models",
		items: ["providers", "keys", "routing"],
	},
	{
		title: "Limits & safety",
		items: [
			"budgets",
			"guardrails",
			"traffic-map",
			"policies",
			"runtime",
			"hooks",
		],
	},
	{
		title: "Connect",
		items: ["api", "network", "integrations", "connections", "email-alerts"],
	},
	{
		title: "Developer",
		items: ["git", "worktrees", "environments", "cloud-environments", "mcp"],
	},
	{
		title: "Transfer",
		items: ["import", "export"],
	},
	{ title: "Reports", items: ["usage", "audit", "evals"] },
	// Node-level Core-infra tabs moved out of the App Settings dialog (not apps —
	// apps register their own tabs dynamically under the Apps/Plugins headers).
	{
		title: "This device",
		// A section listed in GATEWAY_SECTIONS but missing from a group here renders
		// NOWHERE, with no type error and no warning, so the two lists move together.
		items: [
			"computer",
			"onboarding",
			"privacy",
			"storage",
			"encryption",
			"updates",
			"health",
		],
	},
	{ title: "Danger", items: ["danger"] },
];

/**
 * Tile colour per section, kept as one map rather than a field on each of the
 * entries so the palette can be read — and kept sane — in one glance.
 *
 * The colour carries meaning by GROUP, the way iOS/macOS Settings does it:
 * money is green, anything destructive or blocking is red, keys and access are
 * yellow/orange, the model stack is purple, connectivity is blue/teal, reports
 * are grey. A section with no entry falls back to grey, which is correct for
 * "infrastructure" and wrong for nothing.
 */
const SECTION_TINTS = {
	overview: "blue",
	workspace: "indigo",
	permissions: "orange",
	defaults: "purple",
	providers: "purple",
	keys: "yellow",
	routing: "teal",
	budgets: "green",
	guardrails: "red",
	"traffic-map": "teal",
	policies: "red",
	runtime: "purple",
	hooks: "red",
	network: "blue",
	integrations: "indigo",
	connections: "teal",
	api: "blue",
	mcp: "teal",
	git: "blue",
	worktrees: "indigo",
	environments: "gray",
	"cloud-environments": "gray",
	import: "blue",
	export: "indigo",
	"email-alerts": "orange",
	usage: "green",
	audit: "gray",
	evals: "pink",
	privacy: "blue",
	computer: "indigo",
	access: "orange",
	storage: "gray",
	encryption: "indigo",
	updates: "teal",
	health: "green",
	onboarding: "purple",
	danger: "red",
} satisfies Partial<Record<GatewaySection, SettingsTint>>;

/** Case-insensitive match of a query against a section's label, hint, keywords. */
function sectionMatches(
	section: (typeof GATEWAY_SECTIONS)[number],
	query: string
): boolean {
	const haystack =
		`${section.label} ${section.hint} ${section.keywords ?? ""} ${section.value}`.toLowerCase();
	return query
		.toLowerCase()
		.split(/\s+/)
		.filter(Boolean)
		.every((term) => haystack.includes(term));
}

interface GatewayDialogProps {
	defaultSection?: string;
	onOpenChange: (open: boolean) => void;
	open: boolean;
}

/**
 * Gateway settings rendered as a dialog with the same inset-sidebar design and
 * layout as the main {@link SettingsDialog}. Self-contained: it loads its own
 * gateway status and renders every gateway section in the content pane.
 *
 * The "Settings for <computer>" picker scopes the dialog, not the app: this
 * shell holds the chosen computer and provides it to every section through
 * {@link NodeScopeProvider}, so `useActiveNode()` below resolves to it while
 * chats keep using the app-wide active computer. Each opening starts on the
 * app-wide computer, and a scoped computer that is removed falls back to it.
 */
export function GatewayDialog(props: GatewayDialogProps) {
	const [scopeName, setScopeName] = useState<string | undefined>();
	const [wasOpen, setWasOpen] = useState(props.open);
	if (props.open !== wasOpen) {
		setWasOpen(props.open);
		if (props.open) {
			setScopeName(undefined);
		}
	}
	const scopeExists = useNodeStore((s) =>
		s.nodes.some((n) => n.name === scopeName)
	);
	useEffect(() => {
		if (scopeName !== undefined && !scopeExists) {
			setScopeName(undefined);
		}
	}, [scopeName, scopeExists]);
	const scope = scopeExists ? scopeName : undefined;
	return (
		<NodeScopeProvider nodeName={scope}>
			<GatewayDialogContent
				{...props}
				onScopeChange={setScopeName}
				scope={scope}
			/>
		</NodeScopeProvider>
	);
}

function GatewayDialogContent({
	open,
	onOpenChange,
	defaultSection = "overview",
	scope,
	onScopeChange,
}: GatewayDialogProps & {
	onScopeChange: (name: string) => void;
	scope: string | undefined;
}) {
	const { status, loading, error, refresh } = useGatewayStatus(open);
	const canConfigure = useGatewayConfigurable();
	const canViewTraffic = useCanManagePermission("audit.view");
	const getActiveNode = useActiveNodeGetter();
	const [configProviders, setConfigProviders] =
		useState<GatewayProvidersConfig | null>(null);
	const [configRevision, setConfigRevision] = useState<string | null>(null);
	const [webServiceSchema, setWebServiceSchema] = useState<
		number | undefined
	>();
	const [appliedProviderRevision, setAppliedProviderRevision] = useState<
		string | null | undefined
	>(undefined);
	// Section is a string, not just GatewaySection: dynamic app/plugin entities use
	// `app:<id>` / `plugin:<id>` values that aren't part of the static union.
	const [section, setSection] = useState<string>(defaultSection);
	// Twenty built-in sections plus one nav row per node-scoped app means the
	// list outgrew "just read it" — a filter is the shortest path from "I know
	// what I want" to the pane that holds it.
	const [search, setSearch] = useState("");
	const openSettings = useSettingsDialog((s) => s.openSettings);
	const contentRef = useSettingReveal(section, "gateway");

	// Node-scoped app/plugin settings tabs (user-scoped ones render in the App
	// Settings dialog instead). Each becomes its own nav item under Apps / Plugins.
	const { apps: appEntities, plugins: pluginEntities } =
		useScopedSettingsNav("node");
	const entityById = useMemo(() => {
		const map = new Map<string, ScopedNavEntity>();
		for (const e of appEntities) {
			map.set(`${APP_SECTION_PREFIX}${e.id}`, e);
		}
		for (const e of pluginEntities) {
			map.set(`${PLUGIN_SECTION_PREFIX}${e.id}`, e);
		}
		return map;
	}, [appEntities, pluginEntities]);

	// Cross-link back to the desktop App Settings dialog. Both are 85vw/85vh
	// modals, so close this one before opening the other to avoid stacking two
	// focus traps.
	const handleOpenSettings = () => {
		onOpenChange(false);
		openSettings();
	};

	// A search result may name a setting owned by the App Settings dialog. Same
	// rule as the manual cross-link above: close this modal before opening that
	// one so two focus traps never stack. The reveal request is module state, so
	// it survives the swap.
	const handleSelectResult = (entry: SettingsEntry) => {
		requestSettingReveal(entry);
		setSearch("");
		if (entry.dialog === "app") {
			onOpenChange(false);
			openSettings(entry.section);
			return;
		}
		setSection(entry.section);
	};

	useEffect(() => {
		if (open) {
			setSection(defaultSection);
		}
	}, [open, defaultSection]);

	// If the selected app/plugin entity disappears (disabled/uninstalled) while its
	// tab is open, fall back to the overview so the pane never shows nothing.
	useEffect(() => {
		if (isEntitySection(section) && !entityById.has(section)) {
			setSection("overview");
		}
	}, [section, entityById]);

	// Static gateway nav (labels resolved from GATEWAY_SECTIONS) + the dynamic
	// Apps/Plugins groups for node-scoped app settings.
	// Apps/Plugins are placed before the Node group for quicker access.
	const entityGroups = useMemo(
		() => buildEntityNavGroups(appEntities, pluginEntities),
		[appEntities, pluginEntities]
	);
	const navGroups = useMemo(() => {
		const query = search.trim();
		// Every section is in the nav by default; a search narrows it to the ones
		// whose label, hint or legacy keywords match what was typed.
		const visible = (value: GatewaySection) => {
			const meta = GATEWAY_SECTIONS.find((s) => s.value === value);
			if (!meta) {
				return false;
			}
			if (query) {
				return sectionMatches(meta, query);
			}
			return true;
		};
		const toGroup = (group: (typeof GATEWAY_NAV_GROUPS)[number]) => ({
			title: group.title,
			items: group.items.filter(visible).map((value) => {
				const meta = GATEWAY_SECTIONS.find((s) => s.value === value);
				return {
					value,
					label: meta?.label ?? value,
					// The tile is a landmark, not information: every row still says what
					// it is in words, so a section with no tint just renders grey.
					icon: meta?.icon,
					tint: SECTION_TINTS[value],
				};
			}),
		});
		const nodeIdx = GATEWAY_NAV_GROUPS.findIndex(
			(g) => g.title === "This device"
		);
		const before = GATEWAY_NAV_GROUPS.slice(0, nodeIdx).map(toGroup);
		const nodeAndAfter = GATEWAY_NAV_GROUPS.slice(nodeIdx).map(toGroup);
		// App/plugin tabs are matched on their own labels when searching.
		// They carry no icon of their own — a manifest declares a settings tab, not
		// a glyph — so both headers get one stand-in tile each, in grey, which reads
		// as "contributed" rather than pretending to identify the app.
		const withEntityIcon = (group: (typeof entityGroups)[number]) => ({
			title: group.title,
			items: group.items
				.filter(
					(item) =>
						!query || item.label.toLowerCase().includes(query.toLowerCase())
				)
				.map(
					(item) =>
						({
							...item,
							icon: group.title === "Apps" ? Package01Icon : PlugSocketIcon,
							tint: "gray",
						}) satisfies (typeof group.items)[number] &
							ComponentProps<typeof SettingsIconTile>
				),
		});
		const entities = entityGroups
			.map(withEntityIcon)
			.filter((group) => group.items.length > 0);
		return [...before, ...entities, ...nodeAndAfter].filter(
			(group) => group.items.length > 0
		);
	}, [entityGroups, search]);

	const node = useActiveNode();
	const target: ApiTarget = useMemo(
		() => ({
			url: node.url,
			token: node.token ?? null,
			userJwt: node.userJwt ?? null,
		}),
		[node.url, node.token, node.userJwt]
	);
	const reachable = status?.reachable ?? false;
	// The loaded config belongs to one dialog session on one node: forget it only
	// when the dialog opens/closes or the target changes (reset during render, so
	// no frame shows another node's config). A status poll that briefly reports
	// the gateway unreachable (e.g. while it restarts after "Apply saved
	// connections") keeps the last-known config mounted; clearing it would unmount
	// the account sections and discard typed-but-unsaved credential drafts.
	const configOwner = open ? target : null;
	const [loadedConfigOwner, setLoadedConfigOwner] = useState(configOwner);
	if (loadedConfigOwner !== configOwner) {
		setLoadedConfigOwner(configOwner);
		setConfigProviders(null);
		setConfigRevision(null);
		setWebServiceSchema(undefined);
		setAppliedProviderRevision(undefined);
	}
	// (Re)load whenever the gateway is reachable — including when it comes back
	// after a transient outage. Account editors are keyed by account ID, so a
	// refetch keeps their drafts.
	useEffect(() => {
		if (!(open && reachable)) {
			return;
		}
		let active = true;
		fetchGatewayConfig(target)
			.then((config) => {
				if (active) {
					setConfigProviders(config.providers);
					setConfigRevision(config.configRevision ?? null);
					setWebServiceSchema(config.webServiceSchema);
					setAppliedProviderRevision(config.appliedProviderRevision);
				}
			})
			.catch(() => undefined);
		return () => {
			active = false;
		};
	}, [open, reachable, target]);
	// Managed (Ryu Cloud) node: keys are held server-side in the fleet vault, so
	// the key cards render read-only and their writers no-op (WS4). Synchronous —
	// travels on the node record from hydrateCloudNodes, no async probe needed.
	const managed = node.managed === true;

	const refreshWithConfig = async () => {
		await refresh();
		try {
			const cfg = await fetchGatewayConfig(target);
			const currentNode = getActiveNode();
			if (
				currentNode.url !== target.url ||
				(currentNode.token ?? null) !== target.token ||
				(currentNode.userJwt ?? null) !== target.userJwt
			) {
				return;
			}
			setConfigProviders(cfg.providers);
			setConfigRevision(cfg.configRevision ?? null);
			setWebServiceSchema(cfg.webServiceSchema);
			setAppliedProviderRevision(cfg.appliedProviderRevision);
		} catch {
			// Config fetch fails silently — health view is the primary surface.
		}
	};

	const health = status?.health ?? null;
	const metrics = status?.metrics ?? null;
	const activeEntity = entityById.get(section);
	const activeMeta = GATEWAY_SECTIONS.find((s) => s.value === section);
	const activeLabel = activeEntity?.label ?? activeMeta?.label ?? "";
	const activeHint = activeEntity ? "" : (activeMeta?.hint ?? "");

	const body = (() => {
		if (loading && !status) {
			return <SkeletonRows spacing="spacious" />;
		}
		if (error && !status) {
			return (
				<SettingsSection title="Could not reach Core">
					<SettingsCard className="flex flex-wrap items-center justify-between gap-3">
						<p className="min-w-0 flex-1 break-words text-muted-foreground text-sm">
							{error}
						</p>
						<Button
							onClick={() => refreshWithConfig()}
							size="sm"
							variant="secondary"
						>
							<HugeiconsIcon className="size-4" icon={Refresh01Icon} />
							Retry
						</Button>
					</SettingsCard>
				</SettingsSection>
			);
		}
		return (
			<div className="flex flex-col gap-4">
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
										key={`speech-settings:${node.url}`}
										managed={managed}
										onRefresh={refreshWithConfig}
										target={target}
									/>
								) : null}
								<GatewayCloudSpeechAccounts
									canConfigure={canConfigure}
									canView={configProviders !== null}
									key={`cloud-speech:${node.url}`}
									managed={managed}
									onRefresh={refreshWithConfig}
									providers={configProviders}
									target={target}
								/>
								{webServiceSchema === 1 ? (
									<GatewayWebAccounts
										canConfigure={canConfigure}
										canView={configProviders !== null}
										key={`web-accounts:${node.url}`}
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
								<FallbackRulesSection
									canConfigure={canConfigure}
									target={target}
								/>
								<AutoRetrySection canConfigure={canConfigure} target={target} />
							</>
						}
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
				{section === "cloud-environments" ? (
					<CloudEnvironmentsSettings />
				) : null}
				{section === "budgets" ? (
					<>
						{canConfigure ? null : <PolicyReadOnlyBanner />}
						<BudgetsCard canConfigure={canConfigure} target={target} />
						<LiveSpendCard target={target} />
					</>
				) : null}
				{section === "keys" ? (
					<>
						{managed ? <ManagedKeysBanner /> : null}
						{canConfigure || managed ? null : <PolicyReadOnlyBanner />}
						{managed ? (
							<GatewayKeysCard reachable={reachable} target={target} />
						) : (
							<GatewayClientKeys
								baseUrl={status?.url ?? target.url}
								canConfigure={canConfigure}
								gatewayReady={reachable && status?.url != null}
								key={`client-keys:${node.url}`}
								managed={false}
								target={target}
							/>
						)}
						<GatewayProviderApplication
							appliedRevision={appliedProviderRevision}
							canConfigure={canConfigure}
							key={`provider-application:${node.url}`}
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
						{webServiceSchema === 1 ? (
							<GatewaySpeechSettings
								canConfigure={canConfigure}
								canView={configProviders !== null}
								key={`speech-settings:${node.url}`}
								managed={managed}
								onRefresh={refreshWithConfig}
								target={target}
							/>
						) : null}
						<GatewayCloudSpeechAccounts
							canConfigure={canConfigure}
							canView={configProviders !== null}
							key={`cloud-speech:${node.url}`}
							managed={managed}
							onRefresh={refreshWithConfig}
							providers={configProviders}
							target={target}
						/>
						{webServiceSchema === 1 ? (
							<GatewayWebAccounts
								canConfigure={canConfigure}
								canView={configProviders !== null}
								key={`web-accounts:${node.url}`}
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
							caption="Cloud image & video generation via Replicate. Stored locally and sent only to Replicate; the gateway meters and governs each call. Get a token at replicate.com/account/api-tokens."
							getKey={getReplicateApiKey}
							label="Replicate"
							managed={managed}
							placeholder="r8_…"
							saveKey={setReplicateApiKey}
							target={target}
						/>
						<MediaKeyCard
							canConfigure={canConfigure}
							caption="Cloud image, video & audio generation via fal.ai. Stored locally and sent only to Fal; the gateway meters and governs each call. Get a key at fal.ai/dashboard/keys."
							getKey={getFalApiKey}
							label="Fal"
							managed={managed}
							placeholder="fal-…"
							saveKey={setFalApiKey}
							target={target}
						/>
					</>
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
				{section === "import" ? (
					<AgentSyncImportSection target={target} />
				) : null}
				{section === "export" ? (
					<AgentSyncExportSection target={target} />
				) : null}
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
	})();

	return (
		<Dialog onOpenChange={onOpenChange} open={open}>
			{/* Goes edge-to-edge below `md` (the useIsMobile line), matching the
			    App Settings dialog. */}
			<DialogContent appearance="gateway-settings">
				<ResizableSettingsLayout
					content={
						<div className="px-4 py-4 md:px-8 md:py-6" ref={contentRef}>
							<div className="mb-6 flex flex-col gap-1">
								<h2 className="font-medium text-base">{activeLabel}</h2>
								{/* One plain sentence saying what this pane is for. Cheap, and
								    it removes most of the "what even is this tab" tax. */}
								{activeHint ? (
									<p className="text-muted-foreground text-sm leading-snug">
										{activeHint}
									</p>
								) : null}
							</div>
							{/* Keyed by computer: sections that loaded on mount re-read the
							    newly picked computer instead of showing the last one's values. */}
							<div key={node.name}>{body}</div>
						</div>
					}
					sidebar={
						<>
							<SidebarGroup spacing="compact">
								<GatewayNodeScopePicker
									onScopeChange={onScopeChange}
									scope={scope}
								/>
								<Input
									aria-label="Search settings"
									onChange={(e) => setSearch(e.target.value)}
									placeholder="Search settings…"
									size="settings-search"
									value={search}
								/>
							</SidebarGroup>
							{navGroups.map((group) => (
								<SidebarGroup key={group.title ?? "general"} spacing="compact">
									{group.title && (
										<SidebarGroupLabel>{group.title}</SidebarGroupLabel>
									)}
									<SidebarMenu>
										{group.items.map((item) => (
											<SidebarMenuItem key={item.value}>
												<SidebarMenuButton
													isActive={section === item.value}
													onClick={() => setSection(item.value)}
												>
													{item.icon ? (
														<SettingsIconTile
															icon={item.icon}
															size="sm"
															tint={item.tint}
														/>
													) : null}
													<span className="truncate">{item.label}</span>
												</SidebarMenuButton>
											</SidebarMenuItem>
										))}
									</SidebarMenu>
								</SidebarGroup>
							))}
							{/* Individual SETTINGS, from the shared index. The nav filter above
							    only ever finds tabs; this is what answers "where is the row that
							    does X", including rows that live in the App Settings dialog. */}
							{search.trim() ? (
								<SettingsSearchResults
									currentDialog="gateway"
									onSelect={handleSelectResult}
									query={search}
									showEmptyState={navGroups.length === 0}
								/>
							) : null}
							<SidebarGroup className="mt-auto" spacing="compact">
								<SidebarGroupLabel>App</SidebarGroupLabel>
								<SidebarMenu>
									<SidebarMenuItem>
										<SidebarMenuButton onClick={handleOpenSettings}>
											<SettingsIconTile
												icon={Settings01Icon}
												size="sm"
												tint="gray"
											/>
											<span className="truncate">App settings</span>
										</SidebarMenuButton>
									</SidebarMenuItem>
								</SidebarMenu>
							</SidebarGroup>
						</>
					}
					// v2 for the same reason as the app Settings dialog: a persisted
					// divider position takes precedence over the widened default.
					storageKey="ryu.gateway.sidebar-layout.v2"
				/>
			</DialogContent>
		</Dialog>
	);
}
