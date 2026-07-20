import {
	Activity01Icon,
	Add01Icon,
	ArrowDown01Icon,
	ArrowUp01Icon,
	BubbleChatIcon,
	CpuIcon,
	Delete01Icon,
	Dollar01Icon,
	EyeIcon,
	GitBranchIcon,
	Key01Icon,
	PencilEdit01Icon,
	Refresh01Icon,
	Share08Icon,
	Shield01Icon,
	SquareLock01Icon,
	UserGroupIcon,
	ViewOffSlashIcon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	EvaluatorCatalog,
	type EvaluatorCatalogItem,
} from "@ryu/blocks/desktop/evaluator-catalog";
import { Badge } from "@ryu/ui/components/badge";
import { Button } from "@ryu/ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@ryu/ui/components/dialog";
import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@ryu/ui/components/empty";
import { Input } from "@ryu/ui/components/input";
import { Label } from "@ryu/ui/components/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select";
import {
	SidebarGroup,
	SidebarGroupLabel,
	SidebarMenu,
	SidebarMenuButton,
	SidebarMenuItem,
} from "@ryu/ui/components/sidebar";
import { Slider } from "@ryu/ui/components/slider";
import { Spinner } from "@ryu/ui/components/spinner";
import { Switch } from "@ryu/ui/components/switch";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ryu/ui/components/tooltip";
import { useQuery } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { WEB_URL } from "@/lib/app-urls.ts";
import { openExternal } from "@/lib/tauri-bridge.ts";
import { toCatalogItem } from "@/src/components/evaluators/catalog-utils.ts";
import {
	EvaluatorEditorDialog,
	type EvaluatorEditorMode,
} from "@/src/components/evaluators/EvaluatorEditorDialog.tsx";
import { ChannelsSection } from "@/src/components/gateway/ChannelsSection.tsx";
import { UsageCostSection } from "@/src/components/gateway/UsageCostSection.tsx";
import { WorkspaceSection } from "@/src/components/gateway/WorkspaceSection.tsx";
import ResizableSettingsLayout from "@/src/components/ResizableSettingsLayout.tsx";
import { IntegrationsTab } from "@/src/components/settings/IntegrationsTab.tsx";
import { LlmProvidersSettings } from "@/src/components/settings/LlmProvidersSettings.tsx";
import {
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "@/src/components/settings/shared/settings-items.tsx";
import { useActiveNodeGetter } from "@/src/hooks/useActiveNode.ts";
import { useEngineModels } from "@/src/hooks/useEngineModels.ts";
import { useGatewayStatus } from "@/src/hooks/useGatewayStatus.ts";
import type { AgentSummary } from "@/src/lib/api/agents.ts";
import { fetchAgents } from "@/src/lib/api/agents.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import type {
	AuditEntry,
	BudgetAction,
	BudgetRule,
	BudgetSpend,
	ByokProvider,
	CustomPattern,
	CustomPatternKind,
	EvalCaseScore,
	EvalRunAggregate,
	EvalRunResult,
	Evaluator,
	EvaluatorBinding,
	GatewayAuthConfig,
	GatewayBudgetConfig,
	GatewayConfig,
	GatewayFirewallConfig,
	GatewayFirewallOverlay,
	GatewayFirewallPolicy,
	GatewayMetrics,
	GatewayProvidersConfig,
	GatewayRoutingConfig,
	GatewayStatus,
	InspectorConfig,
	InspectorMode,
	ModelMapping,
	ProviderCircuitState,
	ProviderKind,
	RouteStrategy,
	SmartRoutingConfig,
} from "@/src/lib/api/gateway.ts";
import {
	clearGatewayProvider,
	DEFAULT_INSPECTOR,
	DEFAULT_SESSION_BUDGET,
	DEFAULT_SMART_ROUTING,
	deleteCustomEvaluator,
	fetchBudgetSpend,
	fetchEvaluators,
	fetchGatewayAudit,
	fetchGatewayConfig,
	runGatewayEvals,
	setGatewayProvider,
	updateGatewayConfig,
} from "@/src/lib/api/gateway.ts";
import {
	fetchMyPermissions,
	fetchOrgs,
	hasOrgAuth,
} from "@/src/lib/api/org.ts";
import {
	getComposioApiKey,
	getExecApprovalEnabled,
	getFalApiKey,
	getReplicateApiKey,
	setComposioApiKey,
	setExecApprovalEnabled,
	setFalApiKey,
	setReplicateApiKey,
} from "@/src/lib/api/preferences.ts";
import { deleteProviderKey, setProviderKey } from "@/src/lib/api/secrets.ts";
import IdentitiesPage from "@/src/pages/IdentitiesPage.tsx";
import type { GatewaySection } from "@/src/store/useGatewayDialog.ts";
import { useSettingsDialog } from "@/src/store/useSettingsDialog.ts";

/**
 * Whether the signed-in caller may change gateway policy in their workspace,
 * derived from their effective org permissions (the RBAC `gateway.configure`
 * key). Fail-OPEN, mirroring Core's `None => full trust` for unidentified
 * callers: we default to `true` and only return `false` once we have
 * SUCCESSFULLY loaded the caller's permissions AND `gateway.configure` is absent.
 * A local / offline / no-org node therefore keeps its config editable; Core is
 * the real enforcement point, this only reflects it in the UI. Shares the
 * `workspace-orgs` / `workspace-my-permissions` query keys with WorkspaceSection
 * so both surfaces read one deduplicated fetch.
 */
function useGatewayConfigurable(): boolean {
	const authed = hasOrgAuth();
	const orgsQuery = useQuery({
		enabled: authed,
		queryKey: ["workspace-orgs"],
		queryFn: fetchOrgs,
	});
	const orgId = orgsQuery.data?.[0]?.id ?? null;
	const permissionsQuery = useQuery({
		enabled: authed && Boolean(orgId),
		queryKey: ["workspace-my-permissions", orgId],
		queryFn: () => fetchMyPermissions(orgId as string),
	});
	if (!(permissionsQuery.isSuccess && permissionsQuery.data)) {
		return true;
	}
	return permissionsQuery.data.includes("gateway.configure");
}

/**
 * Banner shown atop a policy section when the caller lacks `gateway.configure`.
 * The write controls in that section are also disabled; this explains why.
 */
function PolicyReadOnlyBanner() {
	return (
		<div className="mx-3 flex items-start gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-muted-foreground text-sm">
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
		</div>
	);
}

function formatNumber(value: number): string {
	return value.toLocaleString();
}

function formatPercent(rate: number): string {
	return `${(rate * 100).toFixed(1)}%`;
}

function MetricTile({ label, value }: { label: string; value: string }) {
	return (
		<div className="rounded-lg bg-muted/40 p-3">
			<div className="text-muted-foreground text-xs">{label}</div>
			<div className="mt-1 font-semibold text-lg tabular-nums">{value}</div>
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
				<p className="px-3 text-muted-foreground text-sm">
					No providers reported.
				</p>
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
			.catch((e: unknown) => {
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
			caption="Issue or revoke keys in the web dashboard. Plaintext values are shown only at creation time and never stored in the desktop."
			headerAction={
				<Button onClick={handleManageInWeb} size="sm" variant="ghost">
					<HugeiconsIcon className="size-4" icon={Share08Icon} />
					Manage in web
				</Button>
			}
			title="Gateway keys"
		>
			<div className="flex flex-col gap-3">
				{reachable && loading ? (
					<div className="flex items-center gap-2 px-3 text-muted-foreground text-sm">
						<Spinner className="size-4" />
						Loading…
					</div>
				) : null}
				{reachable && !loading && loadError ? (
					<p className="px-3 text-destructive text-sm">{loadError}</p>
				) : null}
				{reachable && !(loading || loadError) ? (
					<>
						{requireAuth ? null : (
							<div className="mx-3 flex items-start gap-2 rounded-md border border-warning bg-warning px-3 py-2 text-sm text-warning dark:border-warning dark:bg-warning dark:text-warning">
								<HugeiconsIcon
									className="mt-0.5 size-4 shrink-0"
									icon={Shield01Icon}
								/>
								<span>
									<span className="font-medium">Auth disabled.</span> The
									gateway accepts requests without an API key. Enable{" "}
									<span className="font-mono">require_auth</span> in the gateway
									config or via the web org settings to require authentication.
								</span>
							</div>
						)}

						{keys.length === 0 ? (
							<p className="px-3 text-muted-foreground text-sm">
								No API keys configured. Use the web org settings to issue keys.
							</p>
						) : (
							<SettingsGroup>
								{keys.map((k) => (
									<SettingsItem
										actions={
											<div className="flex items-center gap-2">
												{k.trusted_forwarder ? (
													<Badge variant="secondary">trusted forwarder</Badge>
												) : null}
												{k.org_id ? (
													<Badge
														className="font-mono text-xs"
														variant="secondary"
													>
														org
													</Badge>
												) : null}
											</div>
										}
										description={
											<span className="font-mono">
												{maskedKeyPrefix(k.name)}
											</span>
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
					<p className="px-3 text-muted-foreground text-sm">
						Gateway unreachable — key list unavailable. Start the gateway and
						refresh.
					</p>
				)}
			</div>
		</SettingsSection>
	);
}

// ── BYOK provider-key vault (Unit U026) ─────────────────────────────────────

const BYOK_PROVIDERS: {
	slug: ByokProvider;
	label: string;
	placeholder: string;
}[] = [
	{ slug: "openai", label: "OpenAI", placeholder: "sk-..." },
	{ slug: "anthropic", label: "Anthropic", placeholder: "sk-ant-..." },
	{ slug: "openrouter", label: "OpenRouter", placeholder: "sk-or-..." },
	{ slug: "gemini", label: "Gemini", placeholder: "AIza..." },
];

/**
 * Whether a BYOK provider currently has a key set, read from the redacted
 * gateway config. Most providers map 1:1 to a top-level config field; "gemini"
 * is special-cased because its key lives in the genai backend's `keys` list.
 */
function isByokProviderSet(
	providers: GatewayProvidersConfig | null,
	slug: ByokProvider
): boolean {
	if (slug === "gemini") {
		return providers?.genai?.keys.includes("gemini") ?? false;
	}
	return providers?.[slug] != null;
}

/**
 * Note shown in place of a key input on a managed (Ryu Cloud) node. The fleet
 * holds provider keys in its server-side vault (WS1), so the desktop must never
 * offer a field that could POST a personal key to the shared hosted gateway.
 */
function ManagedKeyNote() {
	return (
		<p className="text-muted-foreground text-xs">
			Provided by Ryu Cloud. Keys held server-side.
		</p>
	);
}

/**
 * Banner atop the Keys section on a managed node, explaining why every key card
 * is read-only. Copy only — no action, since editing is deliberately unavailable.
 */
function ManagedKeysBanner() {
	return (
		<div className="mx-3 flex items-start gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-muted-foreground text-sm">
			<HugeiconsIcon
				className="mt-0.5 size-4 shrink-0"
				icon={SquareLock01Icon}
			/>
			<span>
				<span className="font-medium text-foreground">
					Ryu Cloud managed server.
				</span>{" "}
				Provider keys are held securely server-side by Ryu Cloud and can't be
				changed from the desktop.
			</span>
		</div>
	);
}

function ProviderRow({
	slug,
	label,
	placeholder,
	isSet,
	onSave,
	onClear,
	readOnly = false,
	canConfigure = true,
}: {
	slug: ByokProvider;
	label: string;
	placeholder: string;
	isSet: boolean;
	onSave: (slug: ByokProvider, key: string) => Promise<void>;
	onClear: (slug: ByokProvider) => Promise<void>;
	/** Managed (Ryu Cloud) node: render key state read-only, no input, no writers. */
	readOnly?: boolean;
	/** When false the caller lacks `gateway.configure`; writers disabled. */
	canConfigure?: boolean;
}) {
	const [input, setInput] = useState("");
	const [showKey, setShowKey] = useState(false);
	const [saving, setSaving] = useState(false);
	const [clearing, setClearing] = useState(false);
	const [rowError, setRowError] = useState<string | null>(null);

	const handleSave = async () => {
		if (canConfigure === false) {
			return;
		}
		const trimmed = input.trim();
		if (!trimmed) {
			return;
		}
		setSaving(true);
		setRowError(null);
		try {
			await onSave(slug, trimmed);
			setInput("");
		} catch (e) {
			setRowError(e instanceof Error ? e.message : "Failed to save key");
		} finally {
			setSaving(false);
		}
	};

	const handleClear = async () => {
		setClearing(true);
		setRowError(null);
		try {
			await onClear(slug);
		} catch (e) {
			setRowError(e instanceof Error ? e.message : "Failed to clear key");
		} finally {
			setClearing(false);
		}
	};

	return (
		<SettingsItem
			actions={
				<div className="flex items-center gap-2">
					{readOnly ? (
						<Badge variant="secondary">Ryu Cloud</Badge>
					) : isSet ? (
						<Badge variant="default">Key set</Badge>
					) : (
						<Badge variant="secondary">No key</Badge>
					)}
					{!readOnly && isSet && (
						<Button
							disabled={clearing}
							onClick={() => handleClear()}
							size="sm"
							variant="ghost"
						>
							{clearing ? (
								<Spinner className="size-3" />
							) : (
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
					{label}
				</span>
			}
		>
			{readOnly ? (
				<ManagedKeyNote />
			) : (
				<div className="flex w-full items-center gap-2">
					<div className="relative flex-1">
						<Input
							className="pr-8"
							onChange={(e) => setInput(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter") {
									handleSave();
								}
							}}
							placeholder={
								isSet ? "•••••••• (leave blank to keep current)" : placeholder
							}
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
						disabled={saving || !input.trim() || canConfigure === false}
						onClick={() => handleSave()}
						size="sm"
					>
						{saving ? <Spinner className="size-3" /> : null}
						Save
					</Button>
				</div>
			)}

			{rowError ? <p className="text-destructive text-xs">{rowError}</p> : null}
		</SettingsItem>
	);
}

function ByokCard({
	target,
	providers,
	onRefresh,
	managed = false,
	canConfigure = true,
}: {
	target: ApiTarget;
	providers: GatewayProvidersConfig | null;
	onRefresh: () => Promise<void>;
	/** Managed (Ryu Cloud) node: read-only, and the key writers are no-ops so a
	 *  personal key can never be POSTed to the shared hosted fleet. */
	managed?: boolean;
	/** When false the caller lacks `gateway.configure`; writers disabled. */
	canConfigure?: boolean;
}) {
	const handleSave = async (slug: ByokProvider, key: string) => {
		// Security gate (WS4): on a managed node the fleet holds keys server-side;
		// never let a personal key leave the client to the shared gateway.
		if (managed) {
			return;
		}
		await setProviderKey(slug, key);
		await setGatewayProvider(target, slug, key);
		await onRefresh();
	};

	const handleClear = async (slug: ByokProvider) => {
		if (managed) {
			return;
		}
		await deleteProviderKey(slug);
		await clearGatewayProvider(target, slug);
		await onRefresh();
	};

	return (
		<SettingsSection
			caption="Add your own API keys for OpenAI, Anthropic, OpenRouter, or Gemini. Keys are stored in the OS credential store and pushed to the local gateway; they are never sent to any Ryu server. Keys are encrypted at rest and never written to plaintext files. The masked badge reflects whether a key is set; the actual value is not displayed after saving."
			title="Provider keys (BYOK)"
		>
			<SettingsGroup>
				{BYOK_PROVIDERS.map(({ slug, label, placeholder }) => (
					<ProviderRow
						canConfigure={canConfigure}
						isSet={isByokProviderSet(providers, slug)}
						key={slug}
						label={label}
						onClear={handleClear}
						onSave={handleSave}
						placeholder={placeholder}
						readOnly={managed}
						slug={slug}
					/>
				))}
			</SettingsGroup>
		</SettingsSection>
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
									disabled={saving}
									onClick={() => handleClear()}
									size="sm"
									variant="ghost"
								>
									{saving ? (
										<Spinner className="size-3" />
									) : (
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
									className="pr-8"
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
								disabled={
									!loaded || saving || !input.trim() || canConfigure === false
								}
								onClick={() => handleSave()}
								size="sm"
							>
								{saving ? <Spinner className="size-3" /> : null}
								Save
							</Button>
						</div>
					)}
					{rowError ? (
						<p className="text-destructive text-xs">{rowError}</p>
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
									disabled={saving}
									onClick={() => handleClear()}
									size="sm"
									variant="ghost"
								>
									{saving ? (
										<Spinner className="size-3" />
									) : (
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
									className="pr-8"
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
								disabled={
									!loaded || saving || !input.trim() || canConfigure === false
								}
								onClick={() => handleSave()}
								size="sm"
							>
								{saving ? <Spinner className="size-3" /> : null}
								Save
							</Button>
						</div>
					)}
					{rowError ? (
						<p className="text-destructive text-xs">{rowError}</p>
					) : null}
				</SettingsItem>
			</SettingsGroup>
		</SettingsSection>
	);
}

const ACTION_LABELS: Record<BudgetAction, string> = {
	notify: "Notify",
	downgrade: "Downgrade",
	restrict: "Restrict",
	stop: "Stop (402)",
};

const ACTION_DESCRIPTIONS: Record<BudgetAction, string> = {
	notify: "Allow but flag in metrics",
	downgrade: "Switch to a cheaper model",
	restrict: "Cap max_tokens and strip tools",
	stop: "Reject with 402 budget_exceeded",
};

interface BudgetFormState {
	action: BudgetAction;
	agentId: string;
	downgrade_to: string;
	limit: string;
	restrict_max_tokens: string;
}

const DEFAULT_FORM: BudgetFormState = {
	agentId: "",
	limit: "100000",
	action: "notify",
	downgrade_to: "",
	restrict_max_tokens: "256",
};

function BudgetRuleDialog({
	trigger,
	title,
	description,
	initial,
	agentIdReadOnly,
	agents,
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
		const limitNum = Number(form.limit);
		if (!Number.isInteger(limitNum) || limitNum < 0) {
			setErr("Limit must be a non-negative integer.");
			return;
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
						<Label htmlFor="budget-limit">Token limit</Label>
						<Input
							id="budget-limit"
							min={0}
							onChange={(e) =>
								setForm((f) => ({ ...f, limit: e.target.value }))
							}
							placeholder="100000"
							type="number"
							value={form.limit}
						/>
						<p className="text-muted-foreground text-xs">
							Lifetime input + output token cap. 0 = unlimited.
						</p>
					</div>
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="budget-action">Action when limit is reached</Label>
						<Select
							items={ACTION_LABELS}
							onValueChange={(v) =>
								v && setForm((f) => ({ ...f, action: v as BudgetAction }))
							}
							value={form.action}
						>
							<SelectTrigger id="budget-action">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{(
									Object.entries(ACTION_LABELS) as [BudgetAction, string][]
								).map(([val, label]) => (
									<SelectItem key={val} value={val}>
										<span className="font-medium">{label}</span>
										<span className="ml-1 text-muted-foreground text-xs">
											— {ACTION_DESCRIPTIONS[val]}
										</span>
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</div>
					{form.action === "downgrade" ? (
						<div className="flex flex-col gap-1.5">
							<Label htmlFor="budget-downgrade-to">Downgrade to model</Label>
							<Input
								id="budget-downgrade-to"
								onChange={(e) =>
									setForm((f) => ({ ...f, downgrade_to: e.target.value }))
								}
								placeholder="e.g. gpt-4o-mini"
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
					{err ? <p className="text-destructive text-sm">{err}</p> : null}
				</div>
				<DialogFooter>
					<Button
						disabled={saving}
						onClick={() => setOpen(false)}
						variant="ghost"
					>
						Cancel
					</Button>
					<Button disabled={saving} onClick={() => handleSave()}>
						{saving ? <Spinner className="size-4" /> : null}
						Save
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

// ── RoutingCard ───────────────────────────────────────────────────────────────

const PROVIDER_LABELS: Record<ProviderKind, string> = {
	openai: "OpenAI",
	anthropic: "Anthropic",
	local: "Local",
	openrouter: "OpenRouter",
	core: "Core",
	genai: "Gemini",
};

interface ModelMappingFormState {
	model: string;
	provider: ProviderKind;
	provider_model: string;
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
	providers: ProviderKind[];
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
							<span className="font-mono">openrouter/auto</span> to route to
							OpenRouter's auto-selected model.
						</p>
					</div>
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="mapping-provider">Provider</Label>
						<Select
							items={providers.map((p) => ({
								value: p,
								label: PROVIDER_LABELS[p] ?? p,
							}))}
							onValueChange={(v) =>
								v && setForm((f) => ({ ...f, provider: v as ProviderKind }))
							}
							value={form.provider}
						>
							<SelectTrigger id="mapping-provider">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{providers.map((p) => (
									<SelectItem key={p} value={p}>
										{PROVIDER_LABELS[p] ?? p}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</div>
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
					{err ? <p className="text-destructive text-sm">{err}</p> : null}
				</div>
				<DialogFooter>
					<Button
						disabled={saving}
						onClick={() => setOpen(false)}
						variant="ghost"
					>
						Cancel
					</Button>
					<Button disabled={saving} onClick={() => handleSave()}>
						{saving ? <Spinner className="size-4" /> : null}
						Save
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

/** Editing row for a smart-routing rule, with a stable client-side id for keys. */
interface RuleRow {
	description: string;
	id: string;
	model: string;
}

const SMART_STRATEGY_LABELS: Record<RouteStrategy, string> = {
	llm: "LLM classifier",
	embedding: "Embedding",
	keyword: "Keyword",
};

const SMART_STRATEGY_DESCRIPTIONS: Record<RouteStrategy, string> = {
	llm: "a cheap model reads the message and picks a rule",
	embedding: "cosine-match rule text against the message",
	keyword: "case-insensitive word match, zero cost",
};

function SmartRoutingCard({
	target,
	reachable,
	canConfigure,
}: {
	target: ApiTarget;
	reachable: boolean;
	/** When false the caller lacks `gateway.configure`; controls read-only. */
	canConfigure: boolean;
}) {
	const [config, setConfig] = useState<SmartRoutingConfig | null>(null);
	const [draft, setDraft] = useState<SmartRoutingConfig | null>(null);
	const [rules, setRules] = useState<RuleRow[]>([]);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);
	const [saveError, setSaveError] = useState<string | null>(null);
	const [saveOk, setSaveOk] = useState(false);

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
				const sr = cfg.routing.smart_routing ?? DEFAULT_SMART_ROUTING;
				setConfig(sr);
				setDraft(sr);
				setRules(
					sr.rules.map((r) => ({
						id: crypto.randomUUID(),
						description: r.description,
						model: r.model,
					}))
				);
				setLoadError(null);
			})
			.catch((e: unknown) => {
				if (!cancelled) {
					setLoadError(
						e instanceof Error ? e.message : "Failed to load smart routing"
					);
				}
			});
		return () => {
			cancelled = true;
		};
	}, [reachable, config, target]);

	const patch = (p: Partial<SmartRoutingConfig>) => {
		setDraft((prev) => (prev ? { ...prev, ...p } : prev));
		setSaveOk(false);
		setSaveError(null);
	};

	const updateRule = (
		id: string,
		field: "description" | "model",
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
			{ id: crypto.randomUUID(), description: "", model: "" },
		]);
		setSaveOk(false);
	};

	const removeRule = (id: string) => {
		setRules((prev) => prev.filter((r) => r.id !== id));
		setSaveOk(false);
	};

	const handleSave = async () => {
		if (!draft) {
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
			const cleanRules = rules
				.map((r) => ({
					description: r.description.trim(),
					model: r.model.trim(),
				}))
				.filter((r) => r.description && r.model);
			const defaultModel = draft.default_model?.trim();
			const smart_routing: SmartRoutingConfig = {
				...draft,
				strategy: draft.strategy ?? "llm",
				classifier_model: draft.classifier_model.trim(),
				embedding_model: draft.embedding_model?.trim() ?? "",
				similarity_threshold: Number.isFinite(draft.similarity_threshold)
					? draft.similarity_threshold
					: 0.35,
				rules: cleanRules,
				default_model: defaultModel ? defaultModel : null,
			};
			const next: GatewayRoutingConfig = { ...cfg.routing, smart_routing };
			await updateGatewayConfig(target, { routing: next });
			setConfig(smart_routing);
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

	const isDisabled = !reachable || draft === null || !canConfigure;

	return (
		<SettingsSection
			caption="Custom routing instructions — a cheap classifier model reads each message and sends it to the model you picked for that kind of request. For example, route coding questions to Claude and casual chat to a local model. Changes take effect after the gateway restarts. The classifier runs once per conversation; if it errors, times out, or matches no rule, the request keeps its originally requested model."
			headerAction={
				<Button
					disabled={isDisabled || saving}
					onClick={() => handleSave()}
					size="sm"
					variant="ghost"
				>
					{saving ? <Spinner className="size-4" /> : null}
					Save
				</Button>
			}
			title="Smart routing"
		>
			<div className="flex flex-col gap-5 px-3">
				{reachable && loadError ? (
					<p className="text-destructive text-sm">{loadError}</p>
				) : null}
				{reachable ? null : (
					<p className="text-muted-foreground text-sm">
						Gateway unreachable — start the gateway and refresh to configure
						smart routing.
					</p>
				)}

				<SettingsGroup>
					<SettingsItem
						actions={
							<Switch
								checked={draft?.enabled ?? false}
								disabled={isDisabled}
								onCheckedChange={(v) => patch({ enabled: v })}
							/>
						}
						description="Classify and re-route each chat request based on the rules below."
						title="Enable smart routing"
					/>
				</SettingsGroup>

				<div className="flex flex-col gap-1.5">
					<Label htmlFor="smart-strategy">Strategy</Label>
					<Select
						items={SMART_STRATEGY_LABELS}
						onValueChange={(v) => v && patch({ strategy: v as RouteStrategy })}
						value={draft?.strategy ?? "llm"}
					>
						<SelectTrigger disabled={isDisabled} id="smart-strategy">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{(
								Object.entries(SMART_STRATEGY_LABELS) as [
									RouteStrategy,
									string,
								][]
							).map(([val, label]) => (
								<SelectItem key={val} value={val}>
									<span className="font-medium">{label}</span>
									<span className="ml-1 text-muted-foreground text-xs">
										— {SMART_STRATEGY_DESCRIPTIONS[val]}
									</span>
								</SelectItem>
							))}
						</SelectContent>
					</Select>
					<p className="text-muted-foreground text-xs">
						How the matching rule is chosen. LLM asks a cheap classifier;
						Embedding cosine-matches rule text; Keyword is a zero-cost word
						match.
					</p>
				</div>

				{(draft?.strategy ?? "llm") === "llm" ? (
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="smart-classifier-model">Classifier model</Label>
						<Input
							disabled={isDisabled}
							id="smart-classifier-model"
							onChange={(e) => patch({ classifier_model: e.target.value })}
							placeholder="e.g. gpt-4o-mini, or a local model"
							value={draft?.classifier_model ?? ""}
						/>
						<p className="text-muted-foreground text-xs">
							A cheap, fast model used only to sort requests. Any routable model
							id works (including local models or openrouter/ slugs).
						</p>
					</div>
				) : null}

				{draft?.strategy === "embedding" ? (
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
							<div className="flex items-center justify-between">
								<Label htmlFor="smart-similarity-threshold">
									Similarity threshold
								</Label>
								<span className="text-muted-foreground text-xs tabular-nums">
									{(draft?.similarity_threshold ?? 0.35).toFixed(2)}
								</span>
							</div>
							<Slider
								aria-label="Similarity threshold"
								disabled={isDisabled}
								id="smart-similarity-threshold"
								max={1}
								min={0}
								onValueChange={(v: number | number[]) =>
									patch({
										similarity_threshold: Array.isArray(v) ? v[0] : v,
									})
								}
								step={0.05}
								value={[draft?.similarity_threshold ?? 0.35]}
							/>
							<p className="text-muted-foreground text-xs">
								Minimum cosine similarity for a rule to match. Higher is
								stricter.
							</p>
						</div>
					</>
				) : null}

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
							No rules yet. Add one like “writing or debugging code” →
							“claude-sonnet-4-5”.
						</p>
					) : (
						<div className="flex flex-col gap-3">
							{rules.map((rule, idx) => (
								<div className="flex items-start gap-2" key={rule.id}>
									<div className="flex flex-1 flex-col gap-1.5">
										<Input
											disabled={isDisabled}
											onChange={(e) =>
												updateRule(rule.id, "description", e.target.value)
											}
											placeholder="When the request is about… (plain language)"
											value={rule.description}
										/>
										<Input
											disabled={isDisabled}
											onChange={(e) =>
												updateRule(rule.id, "model", e.target.value)
											}
											placeholder="Route to model id (e.g. claude-sonnet-4-5)"
											value={rule.model}
										/>
									</div>
									<Button
										onClick={() => removeRule(rule.id)}
										size="icon"
										variant="ghost"
									>
										<HugeiconsIcon
											className="size-3.5 text-destructive"
											icon={Delete01Icon}
										/>
										<span className="sr-only">Remove rule {idx + 1}</span>
									</Button>
								</div>
							))}
						</div>
					)}
				</div>

				<div className="flex flex-col gap-1.5">
					<Label htmlFor="smart-default-model">
						Default model when no rule matches
					</Label>
					<Input
						disabled={isDisabled}
						id="smart-default-model"
						onChange={(e) => patch({ default_model: e.target.value })}
						placeholder="Leave blank to keep the originally requested model"
						value={draft?.default_model ?? ""}
					/>
				</div>

				{saveError ? (
					<p className="text-destructive text-sm">{saveError}</p>
				) : null}
				{saveOk ? (
					<p className="text-sm text-success">
						Saved. Restart the gateway for changes to take effect.
					</p>
				) : null}
			</div>
		</SettingsSection>
	);
}

function RoutingCard({
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
	const [draft, setDraft] = useState<GatewayRoutingConfig | null>(null);
	const [saving, setSaving] = useState(false);
	const [saveError, setSaveError] = useState<string | null>(null);
	const [saveOk, setSaveOk] = useState(false);

	const providers: ProviderKind[] = configuredProviders.filter(
		(p): p is ProviderKind => p in PROVIDER_LABELS
	);

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
					setConfigError(null);
				}
			})
			.catch((e: unknown) => {
				if (!cancelled) {
					setConfigError(
						e instanceof Error ? e.message : "Failed to load routing config"
					);
				}
			});
		return () => {
			cancelled = true;
		};
	}, [reachable, config, target]);

	const handleSave = async () => {
		if (!draft) {
			return;
		}
		setSaving(true);
		setSaveError(null);
		setSaveOk(false);
		try {
			await updateGatewayConfig(target, { routing: draft });
			setConfig(draft);
			setSaveOk(true);
			setTimeout(() => setSaveOk(false), 3000);
		} catch (e) {
			setSaveError(
				e instanceof Error ? e.message : "Failed to save routing config"
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
		const mapping: ModelMapping = {
			provider: form.provider,
			...(form.provider_model.trim()
				? { provider_model: form.provider_model.trim() }
				: {}),
		};
		const next: GatewayRoutingConfig = {
			...cfg.routing,
			model_map: { ...cfg.routing.model_map, [form.model.trim()]: mapping },
		};
		await updateGatewayConfig(target, { routing: next });
		setConfig(next);
		setDraft(next);
	};

	const removeMapping = async (model: string) => {
		const cfg = await fetchGatewayConfig(target);
		const model_map = { ...cfg.routing.model_map };
		delete model_map[model];
		const next: GatewayRoutingConfig = { ...cfg.routing, model_map };
		await updateGatewayConfig(target, { routing: next });
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

	const removeFallback = (provider: ProviderKind) => {
		if (!draft) {
			return;
		}
		patchDraft({
			fallback_chain: draft.fallback_chain.filter((p) => p !== provider),
		});
	};

	const isDisabled = !reachable || draft === null || !canConfigure;
	const mappingEntries = Object.entries(draft?.model_map ?? {});

	return (
		<SettingsSection
			caption={
				<>
					Ryu's user-level model routing — runs before any upstream provider
					routing. Pick which provider handles requests by default, map specific
					models to providers, and order the fallback chain for when a provider
					is unavailable.{" "}
					<span className="font-medium text-foreground">
						Two-layer guardrail model:
					</span>{" "}
					Ryu evaluates firewall rules, PII/DLP, and per-agent budgets here, at
					the gateway, before the request leaves to any upstream provider. When
					you route to OpenRouter, OpenRouter's own auto-routing and guardrails
					run as an additional layer on top — they do not replace Ryu's
					user-level controls. Use{" "}
					<span className="font-mono">openrouter/auto</span> to let OpenRouter
					pick the best available model; any{" "}
					<span className="font-mono">openrouter/&lt;model&gt;</span> slug is
					supported.
				</>
			}
			headerAction={
				providers.length > 0 ? (
					<ModelMappingDialog
						description="Route a model name (exact or prefix) to a specific provider. Optionally rewrite the model name before forwarding."
						onSave={addMapping}
						providers={providers}
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
			title="Routing"
		>
			<div className="flex flex-col gap-5 px-3">
				{reachable && configError ? (
					<p className="text-destructive text-sm">{configError}</p>
				) : null}
				{reachable ? null : (
					<p className="text-muted-foreground text-sm">
						Gateway unreachable — controls are disabled. Start the gateway and
						refresh to configure routing.
					</p>
				)}

				<div className="flex flex-col gap-1.5">
					<Label htmlFor="routing-default-provider">Default provider</Label>
					<Select
						disabled={isDisabled}
						items={providers.map((p) => ({
							value: p,
							label: PROVIDER_LABELS[p] ?? p,
						}))}
						onValueChange={(v) =>
							v && patchDraft({ default_provider: v as ProviderKind })
						}
						value={draft?.default_provider ?? "openai"}
					>
						<SelectTrigger id="routing-default-provider">
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
					<p className="text-muted-foreground text-xs">
						Used when no model-map entry matches the requested model name.
					</p>
				</div>

				<div className="flex flex-col gap-2">
					<Label>Model mappings</Label>
					{mappingEntries.length === 0 ? (
						<p className="text-muted-foreground text-sm">
							No model mappings. Requests are routed by built-in prefix rules
							then fall back to the default provider.
						</p>
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
													const updated: ModelMapping = {
														provider: form.provider,
														...(form.provider_model.trim()
															? {
																	provider_model: form.provider_model.trim(),
																}
															: {}),
													};
													const next: GatewayRoutingConfig = {
														...cfg.routing,
														model_map: {
															...cfg.routing.model_map,
															[model]: updated,
														},
													};
													await updateGatewayConfig(target, {
														routing: next,
													});
													setConfig(next);
													setDraft(next);
												}}
												providers={providers}
												title="Edit model mapping"
												trigger={
													<Button size="icon" variant="ghost">
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
												onClick={() => removeMapping(model)}
												size="icon"
												variant="ghost"
											>
												<HugeiconsIcon
													className="size-3.5 text-destructive"
													icon={Delete01Icon}
												/>
												<span className="sr-only">
													Remove mapping for {model}
												</span>
											</Button>
										</div>
									}
									description={
										<>
											{PROVIDER_LABELS[mapping.provider] ?? mapping.provider}
											{mapping.provider_model
												? ` → ${mapping.provider_model}`
												: null}
										</>
									}
									key={model}
									title={<span className="font-mono">{model}</span>}
								/>
							))}
						</SettingsGroup>
					)}
				</div>

				<div className="flex flex-col gap-2">
					<Label>Fallback chain</Label>
					<p className="text-muted-foreground text-xs">
						Ordered list of providers tried when the primary provider is
						unavailable. Use the arrows to reorder.
					</p>
					{(draft?.fallback_chain ?? []).length === 0 ? (
						<p className="text-muted-foreground text-sm">
							No fallback chain configured. Add providers below to enable
							automatic fallback.
						</p>
					) : (
						<SettingsGroup>
							{(draft?.fallback_chain ?? []).map((provider, i) => (
								<SettingsItem
									actions={
										<div className="flex items-center gap-1">
											<Button
												disabled={i === 0}
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
												onClick={() => removeFallback(provider)}
												size="icon"
												variant="ghost"
											>
												<HugeiconsIcon
													className="size-3.5 text-destructive"
													icon={Delete01Icon}
												/>
												<span className="sr-only">
													Remove {provider} from fallback chain
												</span>
											</Button>
										</div>
									}
									key={provider}
									title={PROVIDER_LABELS[provider] ?? provider}
								/>
							))}
						</SettingsGroup>
					)}
					{providers.length > 0 ? (
						<div className="flex flex-wrap gap-2">
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
				</div>

				<div className="flex items-center gap-3">
					<Button
						disabled={isDisabled || saving || draft === config}
						onClick={() => handleSave()}
						size="sm"
					>
						{saving ? <Spinner className="size-3" /> : null}
						Save
					</Button>
					{saveOk ? (
						<span className="text-sm text-success">
							Saved. Gateway will apply on next restart.
						</span>
					) : null}
					{saveError ? (
						<span className="text-destructive text-sm">{saveError}</span>
					) : null}
				</div>
			</div>
		</SettingsSection>
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
								{formatNumber(spent)}
								{cap > 0 ? ` / ${formatNumber(cap)}` : ""}
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
 * gateway's in-memory per-user / per-agent / per-session token counters and
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
			caption="Live token spend per user, per agent, and per session, read from the gateway's in-memory counters. Only scopes with a configured budget are tracked; counters reset when the gateway restarts."
			title="Live spend"
		>
			{loading && !spend ? (
				<div className="flex items-center gap-2 px-3.5 text-muted-foreground text-sm">
					<Spinner className="size-4" />
					Loading…
				</div>
			) : null}
			{!loading && spend && !spend.reachable ? (
				<p className="px-3.5 text-muted-foreground text-sm">
					Gateway unreachable — live spend appears once it is running.
				</p>
			) : null}
			{!loading && spend?.reachable && !anySpend ? (
				<p className="px-3.5 text-muted-foreground text-sm">
					No spend tracked yet. Configure a budget above, then spend appears
					here as traffic flows.
				</p>
			) : null}
			{spend?.reachable && anySpend ? (
				<div className="flex flex-col gap-4">
					{userEntries.length > 0 ? (
						<div className="flex flex-col gap-1.5">
							<Label className="px-3.5 text-muted-foreground text-xs">
								Per-user
							</Label>
							<SpendRows
								idPrefix="user"
								limits={spend.limits.users}
								spend={spend.users}
							/>
						</div>
					) : null}
					{agentEntries.length > 0 ? (
						<div className="flex flex-col gap-1.5">
							<Label className="px-3.5 text-muted-foreground text-xs">
								Per-agent
							</Label>
							<SpendRows
								idPrefix="agent"
								limits={spend.limits.agents}
								spend={spend.agents}
							/>
						</div>
					) : null}
					{sessionEntries.length > 0 ? (
						<div className="flex flex-col gap-1.5">
							<Label className="px-3.5 text-muted-foreground text-xs">
								Per-session
							</Label>
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
						</div>
					) : null}
				</div>
			) : null}
		</SettingsSection>
	);
}

function BudgetsCard({
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
				fetchAgents(target).catch(() => [] as AgentSummary[]),
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
				users: { ...(cfg.budgets.users ?? {}) },
				agents: { ...(cfg.budgets.agents ?? {}) },
				session: cfg.budgets.session ?? DEFAULT_SESSION_BUDGET,
			};
			next[scope][id] = rule;
			await updateGatewayConfig(target, { budgets: next });
			setBudgets(next);
		},
		[target]
	);

	const removeRule = useCallback(
		async (scope: "users" | "agents", id: string) => {
			const cfg = await fetchGatewayConfig(target);
			const next: GatewayBudgetConfig = {
				users: { ...(cfg.budgets.users ?? {}) },
				agents: { ...(cfg.budgets.agents ?? {}) },
				session: cfg.budgets.session ?? DEFAULT_SESSION_BUDGET,
			};
			delete next[scope][id];
			await updateGatewayConfig(target, { budgets: next });
			setBudgets(next);
		},
		[target]
	);

	const saveSession = useCallback(
		async (rule: BudgetRule) => {
			const cfg = await fetchGatewayConfig(target);
			const next: GatewayBudgetConfig = {
				users: { ...(cfg.budgets.users ?? {}) },
				agents: { ...(cfg.budgets.agents ?? {}) },
				session: rule,
			};
			await updateGatewayConfig(target, { budgets: next });
			setBudgets(next);
		},
		[target]
	);

	const formToRule = (form: BudgetFormState): BudgetRule => {
		const rule: BudgetRule = {
			limit: Number(form.limit),
			action: form.action,
		};
		if (form.action === "downgrade" && form.downgrade_to.trim()) {
			rule.downgrade_to = form.downgrade_to.trim();
		}
		if (form.action === "restrict" && form.restrict_max_tokens.trim()) {
			const cap = Number(form.restrict_max_tokens);
			if (Number.isInteger(cap) && cap > 0) {
				rule.restrict_max_tokens = cap;
			}
		}
		return rule;
	};

	const userEntries = Object.entries(budgets?.users ?? {});
	const agentEntries = Object.entries(budgets?.agents ?? {});

	return (
		<SettingsSection
			caption="Token caps per user, per agent, and a single global per-session cap. When a cap is reached the gateway applies the configured action (notify / downgrade / restrict / stop). Changes take effect after the gateway restarts."
			title="Budgets"
		>
			{loading ? (
				<div className="flex items-center gap-2 px-3 text-muted-foreground text-sm">
					<Spinner className="size-4" />
					Loading…
				</div>
			) : null}
			{!loading && err ? (
				<p className="px-3 text-destructive text-sm">{err}</p>
			) : null}
			{loading || err ? null : (
				<div className="flex flex-col gap-6">
					<BudgetScopeSection
						addDialog={
							<BudgetRuleDialog
								description="Set a token cap and action for a user. The limit counts lifetime input + output tokens."
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
						emptyText="No per-user budgets set. Add one to cap a user's token usage."
						entries={userEntries}
						label="Per-user"
						onRemove={(id) => removeRule("users", id)}
						onSave={(id, rule) => saveRule("users", id, rule)}
					/>
					<BudgetScopeSection
						addDialog={
							<BudgetRuleDialog
								agents={agents}
								description="Set a token cap and action for an agent. The limit counts lifetime input + output tokens."
								onSave={async (form) => {
									await saveRule(
										"agents",
										form.agentId.trim(),
										formToRule(form)
									);
								}}
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
						emptyText="No per-agent budgets set. Add one to cap an agent's token usage."
						entries={agentEntries}
						label="Per-agent"
						onRemove={(id) => removeRule("agents", id)}
						onSave={(id, rule) => saveRule("agents", id, rule)}
					/>
					<SessionBudgetEditor
						canConfigure={canConfigure}
						onSave={saveSession}
						rule={budgets?.session ?? DEFAULT_SESSION_BUDGET}
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
}) {
	const formToRule = (form: BudgetFormState): BudgetRule => {
		const rule: BudgetRule = {
			limit: Number(form.limit),
			action: form.action,
		};
		if (form.action === "downgrade" && form.downgrade_to.trim()) {
			rule.downgrade_to = form.downgrade_to.trim();
		}
		if (form.action === "restrict" && form.restrict_max_tokens.trim()) {
			const cap = Number(form.restrict_max_tokens);
			if (Number.isInteger(cap) && cap > 0) {
				rule.restrict_max_tokens = cap;
			}
		}
		return rule;
	};

	return (
		<div className="flex flex-col gap-2">
			<div className="flex items-center justify-between px-3">
				<Label>{label}</Label>
				{addDialog}
			</div>
			{entries.length === 0 ? (
				<p className="px-3 text-muted-foreground text-sm">{emptyText}</p>
			) : (
				<SettingsGroup>
					{entries.map(([id, rule]) => (
						<SettingsItem
							actions={
								<div className="flex shrink-0 items-center gap-1">
									<BudgetRuleDialog
										agentIdReadOnly
										description="Update the token cap or action for this entry."
										idLabel={editIdLabel}
										initial={{
											agentId: id,
											limit: String(rule.limit),
											action: rule.action,
											downgrade_to: rule.downgrade_to ?? "",
											restrict_max_tokens: String(
												rule.restrict_max_tokens ?? 256
											),
										}}
										onSave={async (form) => {
											await onSave(id, formToRule(form));
										}}
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
										disabled={!canConfigure}
										onClick={() => onRemove(id)}
										size="icon"
										variant="ghost"
									>
										<HugeiconsIcon
											className="size-3.5 text-destructive"
											icon={Delete01Icon}
										/>
										<span className="sr-only">Remove budget for {id}</span>
									</Button>
								</div>
							}
							description={
								<>
									{rule.limit === 0
										? "unlimited"
										: `${formatNumber(rule.limit)} tokens`}
									{" · "}
									{ACTION_LABELS[rule.action] ?? rule.action}
									{rule.action === "downgrade" && rule.downgrade_to
										? ` → ${rule.downgrade_to}`
										: null}
									{rule.action === "restrict" && rule.restrict_max_tokens
										? ` (max ${rule.restrict_max_tokens})`
										: null}
								</>
							}
							key={id}
							title={id}
						/>
					))}
				</SettingsGroup>
			)}
		</div>
	);
}

/**
 * The single global per-session token cap (#510). Unlike user/agent budgets
 * this is one rule, not a map, so it renders as an inline field set (limit +
 * action + conditional downgrade/restrict) with its own Save button.
 */
function SessionBudgetEditor({
	rule,
	onSave,
	canConfigure,
}: {
	rule: BudgetRule;
	onSave: (rule: BudgetRule) => Promise<void>;
	/** When false the caller lacks `gateway.configure`; save disabled. */
	canConfigure: boolean;
}) {
	const [limit, setLimit] = useState(String(rule.limit));
	const [action, setAction] = useState<BudgetAction>(rule.action);
	const [downgradeTo, setDowngradeTo] = useState(rule.downgrade_to ?? "");
	const [restrictMax, setRestrictMax] = useState(
		String(rule.restrict_max_tokens ?? 256)
	);
	const [saving, setSaving] = useState(false);
	const [saveError, setSaveError] = useState<string | null>(null);
	const [saveOk, setSaveOk] = useState(false);

	const handleSave = async () => {
		const limitNum = Number(limit);
		if (!Number.isInteger(limitNum) || limitNum < 0) {
			setSaveError("Limit must be a non-negative integer.");
			return;
		}
		const next: BudgetRule = { limit: limitNum, action };
		if (action === "downgrade" && downgradeTo.trim()) {
			next.downgrade_to = downgradeTo.trim();
		}
		if (action === "restrict" && restrictMax.trim()) {
			const cap = Number(restrictMax);
			if (Number.isInteger(cap) && cap > 0) {
				next.restrict_max_tokens = cap;
			}
		}
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
		<div className="flex flex-col gap-2">
			<div className="flex items-center justify-between px-3">
				<Label>Per-session (global)</Label>
				<Button
					disabled={saving || !canConfigure}
					onClick={() => handleSave()}
					size="sm"
					variant="ghost"
				>
					{saving ? <Spinner className="size-4" /> : null}
					Save
				</Button>
			</div>
			<div className="flex flex-col gap-4 px-3">
				<p className="text-muted-foreground text-xs">
					One cap applied to every chat session (keyed by session id). Set the
					limit to 0 to turn the per-session cap off.
				</p>
				<div className="flex flex-col gap-1.5">
					<Label htmlFor="session-budget-limit">Token limit</Label>
					<Input
						id="session-budget-limit"
						min={0}
						onChange={(e) => {
							setLimit(e.target.value);
							setSaveOk(false);
						}}
						placeholder="0 = off"
						type="number"
						value={limit}
					/>
					<p className="text-muted-foreground text-xs">
						Lifetime input + output token cap per session. 0 = unlimited (off).
					</p>
				</div>
				<div className="flex flex-col gap-1.5">
					<Label htmlFor="session-budget-action">
						Action when limit is reached
					</Label>
					<Select
						items={ACTION_LABELS}
						onValueChange={(v) => {
							if (v) {
								setAction(v as BudgetAction);
								setSaveOk(false);
							}
						}}
						value={action}
					>
						<SelectTrigger id="session-budget-action">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{(Object.entries(ACTION_LABELS) as [BudgetAction, string][]).map(
								([val, label]) => (
									<SelectItem key={val} value={val}>
										<span className="font-medium">{label}</span>
										<span className="ml-1 text-muted-foreground text-xs">
											— {ACTION_DESCRIPTIONS[val]}
										</span>
									</SelectItem>
								)
							)}
						</SelectContent>
					</Select>
				</div>
				{action === "downgrade" ? (
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="session-budget-downgrade-to">
							Downgrade to model
						</Label>
						<Input
							id="session-budget-downgrade-to"
							onChange={(e) => {
								setDowngradeTo(e.target.value);
								setSaveOk(false);
							}}
							placeholder="e.g. gpt-4o-mini"
							value={downgradeTo}
						/>
						<p className="text-muted-foreground text-xs">
							Model to route to once the session cap is exhausted. Falls back to
							Restrict if left empty.
						</p>
					</div>
				) : null}
				{action === "restrict" ? (
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="session-budget-restrict-max">Max tokens cap</Label>
						<Input
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
					</div>
				) : null}
				{saveError ? (
					<p className="text-destructive text-sm">{saveError}</p>
				) : null}
				{saveOk ? (
					<p className="text-sm text-success">
						Saved. Restart the gateway for changes to take effect.
					</p>
				) : null}
			</div>
		</div>
	);
}

const POLICY_OPTIONS: { value: GatewayFirewallPolicy; label: string }[] = [
	{ value: "block", label: "Block — reject with 403" },
	{ value: "warn_and_continue", label: "Warn and continue — log only" },
	{ value: "sanitize", label: "Sanitize — redact detected patterns" },
];

/** Short, human-readable names for firewall policies, for inline copy. */
const POLICY_LABELS: Record<GatewayFirewallPolicy, string> = {
	block: "Block",
	warn_and_continue: "Warn and continue",
	sanitize: "Sanitize",
};

/**
 * Command-approval gate: scan every ACP agent's native tool calls (Claude/Codex
 * `Bash`/`Write`/`Edit`, …) through the gateway command-approval scanner at the
 * `request_permission` seam before they run. Backed by the `exec-approval-mode`
 * Core preference; Core seeds it into `RYU_EXEC_APPROVAL_MODE` at startup, so the
 * change is restart-to-apply. When on, the scan is fail-closed and defers to the
 * firewall / allow-deny rules configured in the cards above.
 */
function CommandApprovalCard({ target }: { target: ApiTarget }) {
	const [enabled, setEnabled] = useState(false);
	const [loaded, setLoaded] = useState(false);
	const [status, setStatus] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		getExecApprovalEnabled(target).then((value) => {
			if (!cancelled) {
				setEnabled(value);
				setLoaded(true);
			}
		});
		return () => {
			cancelled = true;
		};
	}, [target]);

	const handleToggle = async (next: boolean) => {
		setEnabled(next);
		setStatus(null);
		const ok = await setExecApprovalEnabled(target, next);
		if (ok) {
			setStatus(
				next
					? "Enabled — restart the node to apply."
					: "Disabled — restart the node to apply."
			);
		} else {
			setEnabled(!next);
			setStatus("Failed to update.");
		}
	};

	return (
		<SettingsSection
			caption="Pre-scan every agent's native tool calls (Claude/Codex Bash, Write, Edit, and the rest) through the command-approval scanner before they run — closing the gap where an agent's own file/shell tools bypassed the gateway. Fail-closed when on: it defers to the firewall and allow/deny rules above. Restart the node to apply."
			title="Command approval"
		>
			<div className="flex flex-col gap-3">
				<SettingsGroup>
					<SettingsItem
						actions={
							<Switch
								checked={enabled}
								disabled={!loaded}
								id="exec-approval-enabled"
								onCheckedChange={handleToggle}
							/>
						}
						description="Scan native agent tool calls at the ACP permission seam"
						title="Scan agent tool commands"
					/>
				</SettingsGroup>
				{status ? (
					<p className="px-3 text-muted-foreground text-sm">{status}</p>
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

/** Boolean-valued firewall fields (excludes `policy` and `inspector`). */
type FirewallBoolField =
	| "enabled"
	| "scan_inbound"
	| "scan_outbound"
	| "log_detections"
	| "redact_pii"
	| "redact_secrets";

/** Everything a scoped guardrail control needs to render and edit one field. */
interface ScopeCtx {
	/** Fields frozen by a broader scope: read-only here. */
	broaderLocked: Set<string>;
	/** Gateway unreachable / config not loaded. */
	disabled: boolean;
	isOverlay: boolean;
	/** Fields this scope currently freezes. */
	lockedHere: Set<string>;
	/** Node base config (concrete values; the inherit source for overlays). */
	node: GatewayFirewallConfig;
	/** The overlay currently being edited ({} when node scope). */
	overlay: GatewayFirewallOverlay;
	/** Active org/agent id ("" when node scope). Used for remount keys. */
	overlayId: string;
	/** Overlay scope has a concrete id selected. */
	overlayReady: boolean;
	scope: FwScope;
	setNodeField: (patch: Partial<GatewayFirewallConfig>) => void;
	setOverlayField: (patch: Partial<GatewayFirewallOverlay>) => void;
	toggleLock: (field: string) => void;
}

const INSPECTOR_MODE_ITEMS: { value: InspectorMode; label: string }[] = [
	{ value: "injection", label: "Injection — jailbreak / prompt-injection" },
	{ value: "dlp", label: "DLP — PII / secret leaks" },
	{ value: "both", label: "Both" },
];

const PATTERN_KIND_ITEMS: { value: CustomPatternKind; label: string }[] = [
	{ value: "pii", label: "PII" },
	{ value: "secret", label: "Secret" },
	{ value: "prompt_injection", label: "Prompt injection" },
];

/** Map an overlay tri-state boolean to the select value. */
function boolToTri(value: boolean | null | undefined): string {
	if (value === null || value === undefined) {
		return "inherit";
	}
	return value ? "on" : "off";
}

/** Map the select value back to the overlay tri-state boolean. */
function triToBool(value: string | null): boolean | null {
	if (value === "on") {
		return true;
	}
	if (value === "off") {
		return false;
	}
	return null;
}

/** Best-effort client-side regex validity hint (browser engine, not Rust). */
function isValidJsRegex(src: string): boolean {
	if (src.length === 0) {
		return true;
	}
	try {
		return Boolean(new RegExp(src));
	} catch {
		return false;
	}
}

/** Clamp a numeric text input to a non-negative integer. */
function clampInt(raw: string, min: number): number {
	const n = Number.parseInt(raw, 10);
	if (Number.isNaN(n) || n < min) {
		return min;
	}
	return n;
}

/** Lock/unlock toggle for a lockable field (node scope only). */
function LockToggle({
	locked,
	disabled,
	onToggle,
}: {
	locked: boolean;
	disabled: boolean;
	onToggle: () => void;
}) {
	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<Button
						aria-label={locked ? "Unlock field" : "Lock field"}
						aria-pressed={locked}
						disabled={disabled}
						onClick={onToggle}
						size="icon-sm"
						variant={locked ? "secondary" : "ghost"}
					>
						<HugeiconsIcon
							className={locked ? "size-4" : "size-4 text-muted-foreground"}
							icon={SquareLock01Icon}
						/>
					</Button>
				}
			/>
			<TooltipContent>
				{locked
					? "Locked. Narrower scopes (org, agent) cannot loosen this field."
					: "Lock so narrower scopes cannot loosen this field."}
			</TooltipContent>
		</Tooltip>
	);
}

/** Read-only indicator shown when a broader scope froze a field. */
function LockedByBroader({ summary }: { summary: string }) {
	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<span className="flex items-center gap-1.5 text-muted-foreground text-sm">
						<HugeiconsIcon className="size-3.5" icon={SquareLock01Icon} />
						{summary}
					</span>
				}
			/>
			<TooltipContent>
				Locked by a broader scope. Change it there to unlock this field.
			</TooltipContent>
		</Tooltip>
	);
}

/** Inherit / On / Off selector for an overlay boolean field. */
function TriStateBool({
	value,
	inheritedLabel,
	disabled,
	onChange,
	id,
}: {
	value: boolean | null | undefined;
	inheritedLabel: string;
	disabled: boolean;
	onChange: (next: boolean | null) => void;
	id: string;
}) {
	const items = [
		{ value: "inherit", label: `Inherit (${inheritedLabel})` },
		{ value: "on", label: "On" },
		{ value: "off", label: "Off" },
	];
	return (
		<Select
			disabled={disabled}
			items={items}
			onValueChange={(v: string | null) => onChange(triToBool(v))}
			value={boolToTri(value)}
		>
			<SelectTrigger className="w-40" id={id}>
				<SelectValue />
			</SelectTrigger>
			<SelectContent>
				{items.map((it) => (
					<SelectItem key={it.value} value={it.value}>
						{it.label}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
}

/** One boolean guardrail field, rendered per the active scope. */
function GuardrailBoolRow({
	ctx,
	field,
	title,
	description,
}: {
	ctx: ScopeCtx;
	field: FirewallBoolField;
	title: string;
	description?: string;
}) {
	const nodeVal = Boolean(ctx.node[field]);
	const overlayVal = ctx.overlay[field];
	const resolved =
		overlayVal === null || overlayVal === undefined ? nodeVal : overlayVal;

	let actions: ReactElement;
	if (ctx.broaderLocked.has(field)) {
		actions = <LockedByBroader summary={resolved ? "On" : "Off"} />;
	} else if (ctx.isOverlay) {
		actions = (
			<TriStateBool
				disabled={ctx.disabled || !ctx.overlayReady}
				id={`fw-${field}`}
				inheritedLabel={nodeVal ? "On" : "Off"}
				onChange={(next) =>
					ctx.setOverlayField({
						[field]: next,
					} as Partial<GatewayFirewallOverlay>)
				}
				value={overlayVal}
			/>
		);
	} else {
		actions = (
			<div className="flex items-center gap-2">
				<LockToggle
					disabled={ctx.disabled}
					locked={ctx.lockedHere.has(field)}
					onToggle={() => ctx.toggleLock(field)}
				/>
				<Switch
					checked={nodeVal}
					disabled={ctx.disabled}
					id={`fw-${field}`}
					onCheckedChange={(c: boolean) =>
						ctx.setNodeField({
							[field]: c,
						} as Partial<GatewayFirewallConfig>)
					}
				/>
			</div>
		);
	}

	return (
		<SettingsItem actions={actions} description={description} title={title} />
	);
}

/** The firewall policy field, rendered per the active scope. */
function GuardrailPolicyRow({ ctx }: { ctx: ScopeCtx }) {
	const nodeVal = ctx.node.policy;
	const overlayVal = ctx.overlay.policy;
	const resolved = overlayVal ?? nodeVal;

	if (ctx.broaderLocked.has("policy")) {
		return (
			<div className="flex flex-col gap-1.5 px-3">
				<Label>Policy</Label>
				<LockedByBroader summary={POLICY_LABELS[resolved] ?? resolved} />
			</div>
		);
	}

	if (ctx.isOverlay) {
		const items = [
			{
				value: "inherit",
				label: `Inherit (${POLICY_LABELS[nodeVal] ?? nodeVal})`,
			},
			...POLICY_OPTIONS,
		];
		return (
			<div className="flex flex-col gap-1.5 px-3">
				<Label htmlFor="fw-policy">Policy</Label>
				<Select
					disabled={ctx.disabled || !ctx.overlayReady}
					items={items}
					onValueChange={(v: string | null) =>
						ctx.setOverlayField({
							policy:
								v && v !== "inherit" ? (v as GatewayFirewallPolicy) : null,
						})
					}
					value={overlayVal ?? "inherit"}
				>
					<SelectTrigger id="fw-policy">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						{items.map((opt) => (
							<SelectItem key={opt.value} value={opt.value}>
								{opt.label}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</div>
		);
	}

	return (
		<div className="flex flex-col gap-1.5 px-3">
			<div className="flex items-center justify-between">
				<Label htmlFor="fw-policy">Policy</Label>
				<LockToggle
					disabled={ctx.disabled}
					locked={ctx.lockedHere.has("policy")}
					onToggle={() => ctx.toggleLock("policy")}
				/>
			</div>
			<Select
				disabled={ctx.disabled}
				items={POLICY_OPTIONS}
				onValueChange={(v: string | null) =>
					ctx.setNodeField({
						policy: (v ?? "warn_and_continue") as GatewayFirewallPolicy,
					})
				}
				value={nodeVal}
			>
				<SelectTrigger id="fw-policy">
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
		</div>
	);
}

/** Add/edit/remove custom firewall patterns for the active scope. Remounted on
 * scope/id change (via a `key` from the parent) so its local row state reseeds. */
function CustomPatternsEditor({ ctx }: { ctx: ScopeCtx }) {
	const source =
		(ctx.isOverlay ? ctx.overlay.custom_patterns : ctx.node.custom_patterns) ??
		[];
	const [rows, setRows] = useState<Array<CustomPattern & { id: string }>>(() =>
		source.map((p) => ({ ...p, id: crypto.randomUUID() }))
	);

	const editable = !ctx.disabled && (!ctx.isOverlay || ctx.overlayReady);

	const commit = (next: Array<CustomPattern & { id: string }>) => {
		setRows(next);
		const serialized: CustomPattern[] = next.map((r) => ({
			name: r.name,
			regex: r.regex,
			kind: r.kind,
		}));
		if (ctx.isOverlay) {
			ctx.setOverlayField({ custom_patterns: serialized });
		} else {
			ctx.setNodeField({ custom_patterns: serialized });
		}
	};

	const updateRow = (id: string, patch: Partial<CustomPattern>) => {
		commit(rows.map((r) => (r.id === id ? { ...r, ...patch } : r)));
	};

	const removeRow = (id: string) => {
		commit(rows.filter((r) => r.id !== id));
	};

	const addRow = () => {
		commit([
			...rows,
			{ id: crypto.randomUUID(), name: "", regex: "", kind: "pii" },
		]);
	};

	return (
		<div className="flex flex-col gap-2 px-3">
			<div className="flex items-center justify-between">
				<Label>Custom patterns</Label>
				<Button disabled={!editable} onClick={addRow} size="sm" variant="ghost">
					<HugeiconsIcon className="size-4" icon={Add01Icon} />
					Add pattern
				</Button>
			</div>
			{ctx.isOverlay ? (
				<p className="text-muted-foreground text-xs">
					Overlay patterns are appended to the inherited set, never replacing
					it.
				</p>
			) : null}
			{rows.length === 0 ? (
				<p className="text-muted-foreground text-sm">No custom patterns.</p>
			) : (
				<div className="flex flex-col gap-2">
					{rows.map((r) => {
						const valid = isValidJsRegex(r.regex);
						return (
							<div
								className="flex flex-col gap-1.5 rounded-md border p-2"
								key={r.id}
							>
								<div className="flex items-center gap-2">
									<Input
										aria-label="Pattern name"
										disabled={!editable}
										onChange={(e) => updateRow(r.id, { name: e.target.value })}
										placeholder="Name (e.g. internal_id)"
										value={r.name}
									/>
									<Select
										disabled={!editable}
										items={PATTERN_KIND_ITEMS}
										onValueChange={(v: string | null) =>
											updateRow(r.id, {
												kind: (v ?? "pii") as CustomPatternKind,
											})
										}
										value={r.kind}
									>
										<SelectTrigger className="w-44">
											<SelectValue />
										</SelectTrigger>
										<SelectContent>
											{PATTERN_KIND_ITEMS.map((it) => (
												<SelectItem key={it.value} value={it.value}>
													{it.label}
												</SelectItem>
											))}
										</SelectContent>
									</Select>
									<Button
										aria-label="Remove pattern"
										disabled={!editable}
										onClick={() => removeRow(r.id)}
										size="icon-sm"
										variant="ghost"
									>
										<HugeiconsIcon className="size-4" icon={Delete01Icon} />
									</Button>
								</div>
								<Input
									aria-invalid={!valid}
									aria-label="Pattern regex"
									className="font-mono text-xs"
									disabled={!editable}
									onChange={(e) => updateRow(r.id, { regex: e.target.value })}
									placeholder="Regex (Rust regex syntax)"
									value={r.regex}
								/>
								{valid ? null : (
									<p className="text-destructive text-xs">
										Invalid regex. Checked with the browser engine; the gateway
										uses Rust regex syntax, which differs slightly.
									</p>
								)}
							</div>
						);
					})}
				</div>
			)}
		</div>
	);
}

function DlpCard({ ctx }: { ctx: ScopeCtx }) {
	const resolvedPolicy = ctx.overlay.policy ?? ctx.node.policy;
	const isSanitize = resolvedPolicy === "sanitize";

	return (
		<SettingsSection
			caption="Choose which categories are redacted when the firewall policy is set to Sanitize. PII covers email, phone, SSN, credit cards; Secrets covers API keys, tokens, and PEM keys."
			title="DLP / Redaction"
		>
			<div className="flex flex-col gap-3">
				{isSanitize ? null : (
					<p className="mx-3 rounded-md border border-warning bg-warning px-3 py-2 text-sm text-warning dark:border-warning dark:bg-warning dark:text-warning">
						Redaction toggles apply only when the firewall policy is set to
						Sanitize. Resolved policy for this scope:{" "}
						{POLICY_LABELS[resolvedPolicy] ?? resolvedPolicy}.
					</p>
				)}

				<SettingsGroup>
					<GuardrailBoolRow
						ctx={ctx}
						description="Email, phone numbers, SSN, credit cards, IBANs, IPv4 addresses"
						field="redact_pii"
						title="Redact PII"
					/>
					<GuardrailBoolRow
						ctx={ctx}
						description="API keys, bearer tokens, PEM private keys, database connection strings"
						field="redact_secrets"
						title="Redact secrets"
					/>
				</SettingsGroup>
			</div>
		</SettingsSection>
	);
}

function FirewallCard({ ctx, caption }: { ctx: ScopeCtx; caption: string }) {
	return (
		<SettingsSection caption={caption} title="Guardrails">
			<div className="flex flex-col gap-3">
				<SettingsGroup>
					<GuardrailBoolRow ctx={ctx} field="enabled" title="Enabled" />
					<GuardrailBoolRow
						ctx={ctx}
						field="scan_inbound"
						title="Scan inbound"
					/>
					<GuardrailBoolRow
						ctx={ctx}
						field="scan_outbound"
						title="Scan outbound"
					/>
					<GuardrailBoolRow
						ctx={ctx}
						description="Record every firewall detection in the audit log"
						field="log_detections"
						title="Log detections"
					/>
				</SettingsGroup>

				<GuardrailPolicyRow ctx={ctx} />

				<CustomPatternsEditor ctx={ctx} key={`${ctx.scope}:${ctx.overlayId}`} />
			</div>
		</SettingsSection>
	);
}

function InspectorCard({
	ctx,
	modelIds,
}: {
	ctx: ScopeCtx;
	modelIds: string[];
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

	return (
		<SettingsSection
			caption="An optional cheap-LLM traffic inspector that runs alongside the regex scanner on inbound turns. It is a swappable detection method, orthogonal to the policy action. Fail-open: any timeout or error allows the turn."
			headerAction={
				ctx.isOverlay ? undefined : (
					<LockToggle
						disabled={ctx.disabled}
						locked={ctx.lockedHere.has("inspector")}
						onToggle={() => ctx.toggleLock("inspector")}
					/>
				)
			}
			title="LLM inspector"
		>
			<div className="flex flex-col gap-3">
				{broaderLocked ? (
					<div className="px-3">
						<LockedByBroader
							summary={`Inspector locked (${effective.enabled ? "on" : "off"})`}
						/>
					</div>
				) : null}

				{!broaderLocked && ctx.isOverlay ? (
					<SettingsGroup>
						<SettingsItem
							actions={
								<Switch
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
					</SettingsGroup>
				) : null}

				{broaderLocked ? null : (
					<>
						<SettingsGroup>
							<SettingsItem
								actions={
									<Switch
										checked={effective.enabled}
										disabled={editorDisabled}
										id="inspector-enabled"
										onCheckedChange={(c: boolean) =>
											patchInspector({ enabled: c })
										}
									/>
								}
								description="Run the inspector on inbound turns"
								title="Enabled"
							/>
						</SettingsGroup>

						<div className="flex flex-col gap-1.5 px-3">
							<Label htmlFor="inspector-model">Model</Label>
							<Input
								disabled={editorDisabled}
								id="inspector-model"
								list="inspector-model-options"
								onChange={(e) => patchInspector({ model: e.target.value })}
								placeholder="Gateway default model"
								value={effective.model}
							/>
							<datalist id="inspector-model-options">
								{modelIds.map((id) => (
									<option key={id} value={id} />
								))}
							</datalist>
							<p className="text-muted-foreground text-xs">
								Any routable model id. Leave empty to use the gateway default.
							</p>
						</div>

						<div className="flex flex-col gap-1.5 px-3">
							<Label htmlFor="inspector-mode">Mode</Label>
							<Select
								disabled={editorDisabled}
								items={INSPECTOR_MODE_ITEMS}
								onValueChange={(v: string | null) =>
									patchInspector({ mode: (v ?? "both") as InspectorMode })
								}
								value={effective.mode}
							>
								<SelectTrigger id="inspector-mode">
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
						</div>

						<div className="flex flex-col gap-1.5 px-3">
							<Label htmlFor="inspector-action">Action on flag</Label>
							<Select
								disabled={editorDisabled}
								items={POLICY_OPTIONS}
								onValueChange={(v: string | null) =>
									patchInspector({
										action: (v ?? "warn_and_continue") as GatewayFirewallPolicy,
									})
								}
								value={effective.action}
							>
								<SelectTrigger id="inspector-action">
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
						</div>

						<div className="flex gap-3 px-3">
							<div className="flex flex-1 flex-col gap-1.5">
								<Label htmlFor="inspector-min-chars">Min characters</Label>
								<Input
									disabled={editorDisabled}
									id="inspector-min-chars"
									inputMode="numeric"
									onChange={(e) =>
										patchInspector({ min_chars: clampInt(e.target.value, 0) })
									}
									value={String(effective.min_chars)}
								/>
							</div>
							<div className="flex flex-1 flex-col gap-1.5">
								<Label htmlFor="inspector-timeout">Timeout (ms)</Label>
								<Input
									disabled={editorDisabled}
									id="inspector-timeout"
									inputMode="numeric"
									onChange={(e) =>
										patchInspector({ timeout_ms: clampInt(e.target.value, 0) })
									}
									value={String(effective.timeout_ms)}
								/>
							</div>
						</div>
					</>
				)}
			</div>
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

function EvaluatorsCard({ target, ctx }: { target: ApiTarget; ctx: ScopeCtx }) {
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
			.catch((e: unknown) => {
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
						onValueChange={(v: string | null) =>
							upsert(item.id, {
								inlineAction: (v ??
									"warn_and_continue") as GatewayFirewallPolicy,
							})
						}
						value={action}
					>
						<SelectTrigger className="h-8 w-28 text-xs">
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
			caption="Enable typed evaluators as inline guardrails at this scope. Each runs on the request/response path with a Block / Warn / Sanitize action. Offline-only evaluators (quality, conversation, trajectory, voice) are not shown here — they live on the agent Evals surface. A ‘not yet enforced’ evaluator is catalogued but not wired to execution yet."
			title="Evaluators"
		>
			<div className="px-3">
				<EvaluatorCatalog
					disabled={ctx.disabled}
					error={error}
					items={items}
					loading={loading}
					mode="inline"
					onCreateCode={() => setEditorMode("code")}
					onCreateJudge={() => setEditorMode("judge")}
					onDeleteCustom={(id) => {
						handleDeleteCustom(id).catch(() => undefined);
					}}
					onSearchChange={setSearch}
					renderControl={renderControl}
					search={search}
				/>
			</div>
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
	const [agents, setAgents] = useState<AgentSummary[]>([]);
	const [scope, setScope] = useState<FwScope>("node");
	const [orgId, setOrgId] = useState("");
	const [agentId, setAgentId] = useState("");
	const [saving, setSaving] = useState(false);
	const [saveError, setSaveError] = useState<string | null>(null);
	const [saveOk, setSaveOk] = useState(false);

	const engineModels = useEngineModels();
	const modelIds = useMemo(() => {
		const set = new Set<string>();
		for (const opts of Object.values(engineModels)) {
			for (const o of opts) {
				set.add(o.id);
			}
		}
		return Array.from(set).sort();
	}, [engineModels]);

	useEffect(() => {
		if (!reachable || config !== null) {
			return;
		}
		let cancelled = false;
		Promise.all([
			fetchGatewayConfig(target),
			fetchAgents(target).catch(() => [] as AgentSummary[]),
		])
			.then(([cfg, agentList]) => {
				if (!cancelled) {
					setConfig(cfg);
					setDraft(cfg);
					setAgents(agentList);
					setConfigError(null);
				}
			})
			.catch((e: unknown) => {
				if (!cancelled) {
					setConfigError(
						e instanceof Error ? e.message : "Failed to load guardrails config"
					);
				}
			});
		return () => {
			cancelled = true;
		};
	}, [reachable, config, target]);

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
			store[activeId] = { ...(store[activeId] ?? {}), ...patch };
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

	const agentIdOptions = useMemo(() => {
		const set = new Set<string>();
		for (const a of agents) {
			set.add(a.id);
		}
		for (const id of Object.keys(draft?.firewall_agent_overlays ?? {})) {
			set.add(id);
		}
		return Array.from(set).sort();
	}, [agents, draft]);

	const handleSave = async () => {
		if (!draft) {
			return;
		}
		setSaving(true);
		setSaveError(null);
		setSaveOk(false);
		try {
			await updateGatewayConfig(target, {
				firewall: draft.firewall,
				firewall_org_overlays: draft.firewall_org_overlays,
				firewall_agent_overlays: draft.firewall_agent_overlays,
			});
			setConfig(draft);
			setSaveOk(true);
			setTimeout(() => setSaveOk(false), 3000);
		} catch (e) {
			setSaveError(
				e instanceof Error ? e.message : "Failed to save guardrails config"
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
						<p className="px-3 text-muted-foreground text-sm">
							Gateway unreachable — controls are disabled. Start the gateway and
							refresh to configure guardrails.
						</p>
					)}
					{reachable && configError ? (
						<p className="px-3 text-destructive text-sm">{configError}</p>
					) : null}

					<div className="flex flex-col gap-1.5 px-3">
						<Label htmlFor="fw-scope">Scope</Label>
						<Select
							disabled={!reachable}
							items={SCOPE_ITEMS}
							onValueChange={(v: string | null) =>
								setScope((v ?? "node") as FwScope)
							}
							value={scope}
						>
							<SelectTrigger id="fw-scope">
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
					</div>

					{scope === "org" ? (
						<div className="flex flex-col gap-1.5 px-3">
							<Label htmlFor="fw-org-id">Org id</Label>
							<Input
								disabled={!reachable}
								id="fw-org-id"
								list="fw-org-ids"
								onChange={(e) => setOrgId(e.target.value)}
								placeholder="Org id (x-ryu-org-id)"
								value={orgId}
							/>
							<datalist id="fw-org-ids">
								{Object.keys(draft?.firewall_org_overlays ?? {}).map((id) => (
									<option key={id} value={id} />
								))}
							</datalist>
							{overlayReady ? null : (
								<p className="text-muted-foreground text-xs">
									Enter an org id to author its overlay.
								</p>
							)}
						</div>
					) : null}

					{scope === "agent" ? (
						<div className="flex flex-col gap-1.5 px-3">
							<Label htmlFor="fw-agent-id">Agent</Label>
							<Input
								disabled={!reachable}
								id="fw-agent-id"
								list="fw-agent-ids"
								onChange={(e) => setAgentId(e.target.value)}
								placeholder="Agent id (x-ryu-agent-id)"
								value={agentId}
							/>
							<datalist id="fw-agent-ids">
								{agentIdOptions.map((id) => (
									<option key={id} value={id} />
								))}
							</datalist>
							{overlayReady ? null : (
								<p className="text-muted-foreground text-xs">
									Choose or enter an agent id to author its overlay.
								</p>
							)}
						</div>
					) : null}
				</div>
			</SettingsSection>

			{ctx ? (
				<>
					<FirewallCard caption={scopeCaption(scope, activeId)} ctx={ctx} />
					<DlpCard ctx={ctx} />
					<InspectorCard ctx={ctx} modelIds={modelIds} />
					<EvaluatorsCard ctx={ctx} target={target} />
					<div className="flex items-center gap-3 px-1">
						<Button
							disabled={!reachable || saving || !dirty || !canConfigure}
							onClick={() => handleSave()}
							size="sm"
						>
							{saving ? <Spinner className="size-3" /> : null}
							Save guardrails
						</Button>
						{saveOk ? (
							<span className="text-sm text-success">Saved.</span>
						) : null}
						{saveError ? (
							<span className="text-destructive text-sm">{saveError}</span>
						) : null}
					</div>
				</>
			) : null}

			<CommandApprovalCard target={target} />
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
	return `${i.toLocaleString()} / ${o.toLocaleString()}`;
}

function AuditTable({ entries }: { entries: AuditEntry[] }) {
	return (
		<div className="overflow-x-auto">
			<table className="w-full text-sm">
				<thead>
					<tr className="border-b text-left text-muted-foreground text-xs">
						<th className="pr-3 pb-2 font-medium">Time</th>
						<th className="pr-3 pb-2 font-medium">Provider</th>
						<th className="pr-3 pb-2 font-medium">Model</th>
						<th className="pr-3 pb-2 font-medium">Tokens (in/out)</th>
						<th className="pr-3 pb-2 font-medium">Latency</th>
						<th className="pr-3 pb-2 font-medium">Score</th>
						<th className="pb-2 font-medium">Error</th>
					</tr>
				</thead>
				<tbody>
					{entries.map((entry) => {
						const ts = new Date(entry.timestamp);
						const timeStr = Number.isNaN(ts.getTime())
							? entry.timestamp
							: ts.toLocaleTimeString();
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
								<td className="py-2 pr-3 text-xs">{entry.provider ?? "—"}</td>
								{entry.model ? (
									<Tooltip>
										<TooltipTrigger
											render={
												<td className="max-w-32 truncate py-2 pr-3 font-mono text-xs">
													{entry.model}
												</td>
											}
										/>
										<TooltipContent>{entry.model}</TooltipContent>
									</Tooltip>
								) : (
									<td className="max-w-32 truncate py-2 pr-3 font-mono text-xs">
										—
									</td>
								)}
								<td className="py-2 pr-3 font-mono text-xs tabular-nums">
									{formatTokens(entry.input_tokens, entry.output_tokens)}
								</td>
								<td className="py-2 pr-3 font-mono text-xs tabular-nums">
									{formatLatency(entry.latency_ms)}
								</td>
								<td className="py-2 pr-3 font-mono text-xs tabular-nums">
									{entry.eval_score === null
										? "—"
										: `${Math.round(entry.eval_score * 100)}%`}
								</td>
								<td className="max-w-40 truncate py-2 text-xs">
									{entry.error ? (
										<Tooltip>
											<TooltipTrigger
												render={
													<span className="text-destructive">
														{entry.error}
													</span>
												}
											/>
											<TooltipContent>{entry.error}</TooltipContent>
										</Tooltip>
									) : (
										<span className="text-muted-foreground">—</span>
									)}
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

	const load = useCallback(
		async (opts: { errorsOnly: boolean }) => {
			setLoading(true);
			setLoadError(null);
			try {
				const result = await fetchGatewayAudit(target, {
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
		[target]
	);

	useEffect(() => {
		load({ errorsOnly });
	}, [load, errorsOnly]);

	const handleToggleErrors = (checked: boolean) => {
		setErrorsOnly(checked);
	};

	return (
		<SettingsSection
			caption="Gateway request log — provider, model, token usage, latency, and eval score. API keys are always redacted. Newest first."
			headerAction={
				<div className="flex items-center gap-3">
					<div className="flex items-center gap-2">
						<Switch
							checked={errorsOnly}
							id="audit-errors-only"
							onCheckedChange={handleToggleErrors}
						/>
						<Label
							className="cursor-pointer text-sm"
							htmlFor="audit-errors-only"
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
			<div className="px-3">
				<AuditBody
					entries={entries}
					loadError={loadError}
					loading={loading}
					reachable={reachable}
				/>
			</div>
		</SettingsSection>
	);
}

// ── Run-evals panel (M4 / #180) ──────────────────────────────────────────────
//
// v1 scorers: latency / token_efficiency / policy_pass / optional substring_match.
// LLM-judge scorers and custom dataset upload are explicitly deferred to a follow-up.

function AuditBody({
	loading,
	loadError,
	reachable,
	entries,
}: {
	loading: boolean;
	loadError: string | null;
	reachable: boolean | null;
	entries: AuditEntry[];
}) {
	if (loading) {
		return (
			<div className="flex items-center gap-2 text-muted-foreground text-sm">
				<Spinner className="size-4" />
				Loading…
			</div>
		);
	}
	if (loadError) {
		return <p className="text-destructive text-sm">{loadError}</p>;
	}
	if (reachable === false) {
		return (
			<Empty>
				<EmptyHeader>
					<EmptyMedia variant="icon">
						<HugeiconsIcon icon={Activity01Icon} />
					</EmptyMedia>
					<EmptyTitle>Audit log unavailable</EmptyTitle>
					<EmptyDescription>
						The gateway is unreachable or audit logging is disabled. Start the
						gateway with <span className="font-mono">RYU_AUDIT_LOG=1</span> to
						enable audit logging.
					</EmptyDescription>
				</EmptyHeader>
			</Empty>
		);
	}
	if (entries.length === 0) {
		return (
			<Empty>
				<EmptyHeader>
					<EmptyMedia variant="icon">
						<HugeiconsIcon icon={Activity01Icon} />
					</EmptyMedia>
					<EmptyTitle>No audit entries yet</EmptyTitle>
					<EmptyDescription>
						Drive a chat turn through the gateway and refresh to see entries.
					</EmptyDescription>
				</EmptyHeader>
			</Empty>
		);
	}
	return <AuditTable entries={entries} />;
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
	return (
		<div className="flex items-center gap-2">
			<div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
				<div
					className={`h-full rounded-full ${color}`}
					style={{ width: `${pct}%` }}
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
			<div className="grid grid-cols-2 gap-x-8 gap-y-3 px-3">
				<div>
					<div className="mb-1 text-muted-foreground text-xs">Overall</div>
					{scoreBar(agg.mean_overall)}
				</div>
				<div>
					<div className="mb-1 text-muted-foreground text-xs">Latency</div>
					{scoreBar(agg.mean_latency)}
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
					{scoreBar(agg.policy_pass_rate)}
				</div>
				{agg.mean_substring_match === null ? null : (
					<div>
						<div className="mb-1 text-muted-foreground text-xs">
							Substring match
						</div>
						{scoreBar(agg.mean_substring_match)}
					</div>
				)}
			</div>
		</SettingsSection>
	);
}

function CasesTable({ cases }: { cases: EvalCaseScore[] }) {
	return (
		<SettingsSection caption="Per-prompt scores." title="Cases">
			<div className="overflow-x-auto px-3">
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
									{Math.round(c.latency_score * 100)}%
								</td>
								<td className="py-2 pr-4 font-mono text-xs tabular-nums">
									{Math.round(c.token_efficiency * 100)}%
								</td>
								<td className="py-2 pr-4">
									<Badge variant={c.policy_pass ? "default" : "destructive"}>
										{c.policy_pass ? "pass" : "fail"}
									</Badge>
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
			</div>
		</SettingsSection>
	);
}

function RunEvalsPanel({ target }: { target: ApiTarget }) {
	const [running, setRunning] = useState(false);
	const [result, setResult] = useState<EvalRunResult | null>(null);
	const [runError, setRunError] = useState<string | null>(null);
	const [model, setModel] = useState("gpt-4o-mini");
	const abortRef = useRef<AbortController | null>(null);

	const handleRun = async () => {
		abortRef.current?.abort();
		const ac = new AbortController();
		abortRef.current = ac;
		setRunning(true);
		setRunError(null);
		setResult(null);
		try {
			const res = await runGatewayEvals(
				target,
				{ model: model.trim() || "gpt-4o-mini", dataset: [] },
				ac.signal
			);
			setResult(res);
		} catch (e) {
			if (!(e instanceof DOMException && e.name === "AbortError")) {
				setRunError(e instanceof Error ? e.message : "Eval run failed.");
			}
		} finally {
			setRunning(false);
		}
	};

	return (
		<SettingsSection
			caption="Replay the built-in 3-case dataset through the gateway pipeline and get a scorecard. v1 scorers: latency, token efficiency, policy pass, and optional substring match. LLM-judge scorers are deferred to a follow-up."
			title="Run evals"
		>
			<div className="flex flex-col gap-4 px-3">
				<div className="flex items-end gap-3">
					<div className="flex flex-col gap-1">
						<Label htmlFor="eval-model">Model</Label>
						<Input
							className="w-48"
							id="eval-model"
							onChange={(e) => setModel(e.target.value)}
							placeholder="gpt-4o-mini"
							value={model}
						/>
					</div>
					<Button
						disabled={running}
						onClick={() => {
							handleRun().catch((_e: unknown) => undefined);
						}}
					>
						{running ? <Spinner className="size-3" /> : null}
						{running ? "Running…" : "Run"}
					</Button>
				</div>

				{runError ? (
					<p className="text-destructive text-sm">{runError}</p>
				) : null}

				{result ? (
					<div className="flex flex-col gap-4">
						<AggregateCard agg={result.aggregate} />
						<CasesTable cases={result.cases} />
					</div>
				) : null}
			</div>
		</SettingsSection>
	);
}

const GATEWAY_SECTIONS: {
	value: GatewaySection;
	label: string;
	icon: IconSvgElement;
}[] = [
	{ value: "overview", label: "Overview", icon: Activity01Icon },
	{ value: "workspace", label: "Workspace", icon: UserGroupIcon },
	{ value: "providers", label: "LLM Providers", icon: CpuIcon },
	{ value: "routing", label: "Routing", icon: GitBranchIcon },
	{ value: "guardrails", label: "Guardrails", icon: Shield01Icon },
	{ value: "budgets", label: "Budgets", icon: Dollar01Icon },
	{ value: "keys", label: "Keys", icon: Key01Icon },
	{ value: "identities", label: "Identities", icon: SquareLock01Icon },
	{ value: "channels", label: "Channels", icon: BubbleChatIcon },
	{ value: "integrations", label: "Integrations", icon: Share08Icon },
	{ value: "usage", label: "Usage & Cost", icon: Dollar01Icon },
	{ value: "audit", label: "Audit", icon: Activity01Icon },
	{ value: "evals", label: "Evals", icon: Activity01Icon },
];

/** Health + metrics observability block, shown on the Overview tab. */
function OverviewSection({
	reachable,
	status,
	metrics,
}: {
	reachable: boolean;
	status: GatewayStatus | null;
	metrics: GatewayMetrics | null;
}) {
	if (!reachable) {
		return (
			<SettingsSection
				caption={`Core is up but could not reach a healthy gateway${status?.url ? ` at ${status.url}` : ""}. Start the gateway, then refresh.`}
				title="Gateway unreachable"
			>
				<span />
			</SettingsSection>
		);
	}

	const h = status?.health ?? null;

	return (
		<>
			<SettingsSection
				caption={`${status?.url ?? "gateway"}${h?.version ? ` · v${h.version}` : ""}`}
				title="Health"
			>
				<div className="flex flex-wrap items-center gap-2 px-3">
					<Badge variant={h?.status === "ok" ? "default" : "secondary"}>
						{h?.status ?? "unknown"}
					</Badge>
					<Badge variant="secondary">
						{h?.authRequired ? "auth required" : "no auth"}
					</Badge>
					<span className="text-muted-foreground text-sm">
						{h?.providers.length ?? 0} provider
						{(h?.providers.length ?? 0) === 1 ? "" : "s"}
					</span>
				</div>
			</SettingsSection>

			{metrics ? (
				<>
					<section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
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
					</section>

					<SettingsSection
						caption="Exact and semantic cache hits reduce upstream calls."
						title="Cache"
					>
						<div className="grid grid-cols-3 gap-3 px-3">
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
						</div>
					</SettingsSection>

					<SettingsSection
						caption="Requests affected by budget controls and the firewall. (Eval scoring is not yet exposed by the gateway.)"
						title="Budget & policy"
					>
						<div className="grid grid-cols-2 gap-3 px-3 sm:grid-cols-3">
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
						</div>
					</SettingsSection>
				</>
			) : (
				<SettingsSection
					caption="The gateway is healthy but did not return a metrics snapshot."
					title="Metrics unavailable"
				>
					<span />
				</SettingsSection>
			)}

			<ProvidersCard metrics={metrics} providers={h?.providers ?? []} />
		</>
	);
}

/**
 * Sidebar-grouped layout for the gateway sections, mirroring the main
 * SettingsDialog (inset sidebar + scrollable content pane). Cosmetic only —
 * groups the 7 gateway sections.
 */
const GATEWAY_NAV_GROUPS: { items: GatewaySection[]; title?: string }[] = [
	{ items: ["overview", "workspace"] },
	{
		title: "Policy",
		items: [
			"providers",
			"routing",
			"guardrails",
			"budgets",
			"keys",
			"identities",
			"channels",
			"integrations",
		],
	},
	{ title: "Observability", items: ["usage", "audit", "evals"] },
];

/**
 * Gateway settings rendered as a dialog with the same inset-sidebar design and
 * layout as the main {@link SettingsDialog}. Self-contained: it loads its own
 * gateway status and renders every gateway section in the content pane.
 */
export function GatewayDialog({
	open,
	onOpenChange,
	defaultSection = "overview",
}: {
	defaultSection?: GatewaySection;
	onOpenChange: (open: boolean) => void;
	open: boolean;
}) {
	const { status, loading, error, refresh } = useGatewayStatus();
	const canConfigure = useGatewayConfigurable();
	const getActiveNode = useActiveNodeGetter();
	const [configProviders, setConfigProviders] =
		useState<GatewayProvidersConfig | null>(null);
	const [section, setSection] = useState<GatewaySection>(defaultSection);
	const openSettings = useSettingsDialog((s) => s.openSettings);

	// Cross-link back to the desktop App Settings dialog. Both are 85vw/85vh
	// modals, so close this one before opening the other to avoid stacking two
	// focus traps.
	const handleOpenSettings = () => {
		onOpenChange(false);
		openSettings();
	};

	useEffect(() => {
		if (open) {
			setSection(defaultSection);
		}
	}, [open, defaultSection]);

	const node = getActiveNode();
	const target: ApiTarget = { url: node.url, token: node.token ?? null };
	// Managed (Ryu Cloud) node: keys are held server-side in the fleet vault, so
	// the key cards render read-only and their writers no-op (WS4). Synchronous —
	// travels on the node record from hydrateCloudNodes, no async probe needed.
	const managed = node.managed === true;

	const refreshWithConfig = async () => {
		await refresh();
		try {
			const cfg = await fetchGatewayConfig(target);
			setConfigProviders(cfg.providers);
		} catch {
			// Config fetch fails silently — health view is the primary surface.
		}
	};

	const reachable = status?.reachable ?? false;
	const health = status?.health ?? null;
	const metrics = status?.metrics ?? null;
	const activeLabel =
		GATEWAY_SECTIONS.find((s) => s.value === section)?.label ?? "";

	const body = (() => {
		if (loading && !status) {
			return (
				<div className="flex h-40 items-center justify-center">
					<Spinner />
				</div>
			);
		}
		if (error && !status) {
			return (
				<Empty>
					<EmptyHeader>
						<EmptyMedia variant="icon">
							<HugeiconsIcon icon={Shield01Icon} />
						</EmptyMedia>
						<EmptyTitle>Could not reach Core</EmptyTitle>
						<EmptyDescription>{error}</EmptyDescription>
					</EmptyHeader>
					<Button onClick={() => refreshWithConfig()} variant="ghost">
						<HugeiconsIcon className="size-4" icon={Refresh01Icon} />
						Retry
					</Button>
				</Empty>
			);
		}
		return (
			<div className="flex flex-col gap-4">
				{section === "overview" ? (
					<OverviewSection
						metrics={metrics}
						reachable={reachable}
						status={status}
					/>
				) : null}
				{section === "workspace" ? <WorkspaceSection /> : null}
				{/* LLM Providers. Provider *selection* (which model/keys/routing the
				    local Pi agent uses) is strictly Core — "what runs" — NOT account/org
				    data, so it lives here on the node/infra Gateway surface, next to
				    model routing, rather than in the account SettingsDialog. The
				    component is reused verbatim; only its host dialog moved. */}
				{section === "providers" ? <LlmProvidersSettings /> : null}
				{section === "routing" ? (
					<>
						{canConfigure ? null : <PolicyReadOnlyBanner />}
						<RoutingCard
							canConfigure={canConfigure}
							configuredProviders={health?.providers ?? []}
							reachable={reachable}
							target={target}
						/>
						<SmartRoutingCard
							canConfigure={canConfigure}
							reachable={reachable}
							target={target}
						/>
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
						<GatewayKeysCard reachable={reachable} target={target} />
						<ByokCard
							canConfigure={canConfigure}
							managed={managed}
							onRefresh={refreshWithConfig}
							providers={configProviders}
							target={target}
						/>
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
				{section === "identities" ? (
					<SettingsSection caption="Per-domain agent logins, governed by the gateway. Credentials are encrypted at rest and never sent to the model. Bind a profile to an agent to let it act on those domains.">
						<div className="h-[60vh] min-h-[420px] overflow-hidden rounded-[10px] bg-muted/40">
							<IdentitiesPage />
						</div>
					</SettingsSection>
				) : null}
				{section === "channels" ? <ChannelsSection /> : null}
				{section === "integrations" ? <IntegrationsTab /> : null}
				{section === "usage" ? (
					<UsageCostSection
						configuredProviders={health?.providers ?? []}
						metrics={metrics}
						reachable={reachable}
						target={target}
					/>
				) : null}
				{section === "audit" ? <AuditPanel target={target} /> : null}
				{section === "evals" ? <RunEvalsPanel target={target} /> : null}
			</div>
		);
	})();

	return (
		<Dialog onOpenChange={onOpenChange} open={open}>
			<DialogContent className="!w-[85vw] !max-w-7xl [&>[data-slot=dialog-close]]:!top-5 [&>[data-slot=dialog-close]]:!right-5 h-[85vh] gap-0 overflow-hidden p-0">
				<ResizableSettingsLayout
					content={
						<div className="px-8 py-6">
							<div className="mb-6 flex items-center gap-2">
								<h2 className="font-semibold text-base">{activeLabel}</h2>
								<Badge variant={reachable ? "default" : "destructive"}>
									{reachable ? "Up" : "Down"}
								</Badge>
							</div>
							{body}
						</div>
					}
					sidebar={
						<>
							{GATEWAY_NAV_GROUPS.map((group) => (
								<SidebarGroup className="py-1" key={group.title ?? "general"}>
									{group.title && (
										<SidebarGroupLabel>{group.title}</SidebarGroupLabel>
									)}
									<SidebarMenu>
										{group.items.map((value) => (
											<SidebarMenuItem key={value}>
												<SidebarMenuButton
													isActive={section === value}
													onClick={() => setSection(value)}
												>
													{GATEWAY_SECTIONS.find((s) => s.value === value)
														?.label ?? value}
												</SidebarMenuButton>
											</SidebarMenuItem>
										))}
									</SidebarMenu>
								</SidebarGroup>
							))}
							<SidebarGroup className="mt-auto py-1">
								<SidebarGroupLabel>App</SidebarGroupLabel>
								<SidebarMenu>
									<SidebarMenuItem>
										<SidebarMenuButton onClick={handleOpenSettings}>
											App settings
										</SidebarMenuButton>
									</SidebarMenuItem>
								</SidebarMenu>
							</SidebarGroup>
						</>
					}
					storageKey="ryu.gateway.sidebar-layout"
				/>
			</DialogContent>
		</Dialog>
	);
}
