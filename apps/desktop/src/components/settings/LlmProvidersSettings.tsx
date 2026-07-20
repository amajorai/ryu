// apps/desktop/src/components/settings/LlmProvidersSettings.tsx
//
// The standalone "LLM Providers" surface — a Zed-style page that lists every
// provider Core's managed Pi can reach, lets the user store BYOK credentials for
// many at once, pick ONE active provider, toggle per-provider routing
// (Gateway ⇄ direct), and discover models dynamically. It is backed by
// `useLlmProviders`, which reuses the same query cache as the agent-scoped
// editor (`RyuPiConfig`), so the two stay in sync. Every decision lives in Core
// (`/api/pi-config/*`); nothing here is hardcoded — the provider list, api
// types, and thinking levels all come from the catalog endpoint.
//
// Hosted by the Gateway dialog (Gateway → LLM Providers), NOT the account
// SettingsDialog: provider *selection* is strictly Core ("what runs" — which
// model/keys/routing the local agent uses), a node/infra concern that belongs on
// the model-routing surface, not account/org data.

import { ArrowDown01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { SvglIcon, type SvglSpec } from "@ryu/blocks/web/svgl-icon.tsx";
import { Badge } from "@ryu/ui/components/badge";
import { Button } from "@ryu/ui/components/button";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@ryu/ui/components/collapsible";
import { Input } from "@ryu/ui/components/input";
import { Label } from "@ryu/ui/components/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select";
import { Spinner } from "@ryu/ui/components/spinner";
import { Switch } from "@ryu/ui/components/switch";
import { useEffect, useMemo, useRef, useState } from "react";
import { sileo } from "sileo";
import { useEntitlementContext } from "@/src/contexts/entitlement-context.tsx";
import { useAcpConfig } from "@/src/hooks/useAcpConfig.ts";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import { useLlmProviders } from "@/src/hooks/useLlmProviders.ts";
import { type AcpAuthMethod, authenticateAgent } from "@/src/lib/api/acp.ts";
import { toTarget } from "@/src/lib/api/client.ts";
import type {
	CheckProviderResult,
	DiscoveredModel,
	PiCatalog,
	PiConfig,
	PiProvider,
} from "@/src/lib/api/pi-config.ts";
import { SettingsCard, SettingsSection } from "./shared/settings-items.tsx";

const GATEWAY = "gateway";
const DIRECT = "direct";
const DEFAULT_API = "openai-completions";
// The flagship agent whose ACP `authMethods` back subscription logins. The ryu
// agent runs pi-acp via `npx -y pi-acp` (fetched at runtime), so which auth
// methods it advertises is NOT knowable at build time — that is exactly why the
// Login button below is gated on the LIVE `authMethods` and disables gracefully
// when a match is absent, rather than assuming a fixed set.
const RYU_AGENT_ID = "ryu";

// Best-effort matching of a subscription-provider catalog id to one of the ryu
// agent's advertised ACP auth methods (matched by substring on the method's
// id/name, case-insensitive). Nothing hardcoded server-side — this only maps a
// provider's login intent to whatever method the live agent build exposes.
const SUBSCRIPTION_METHOD_HINTS: Record<string, string[]> = {
	"github-copilot": ["copilot", "github"],
	"openai-codex": ["codex", "chatgpt", "openai"],
	"claude-pro-max": ["claude", "anthropic"],
};

function matchAuthMethod(
	providerId: string,
	authMethods: AcpAuthMethod[]
): AcpAuthMethod | null {
	const hints = SUBSCRIPTION_METHOD_HINTS[providerId] ?? [providerId];
	return (
		authMethods.find((m) => {
			const hay = `${m.id} ${m.name}`.toLowerCase();
			return hints.some((h) => hay.includes(h));
		}) ?? null
	);
}

function errMessage(e: unknown, fallback: string): string {
	return e instanceof Error ? e.message : fallback;
}

// Order the catalog so the managed provider leads (the recommended default),
// then configured providers, then the rest — configuring "many at once" reads
// best when what is set up already floats to the top.
function orderProviders(providers: PiProvider[]): PiProvider[] {
	return [...providers].sort((a, b) => {
		const rank = (p: PiProvider) => {
			if (p.managed) {
				return 0;
			}
			if (p.configured) {
				return 1;
			}
			return 2;
		};
		return rank(a) - rank(b);
	});
}

interface ModelPickerProps {
	busy?: boolean;
	idPrefix: string;
	model: string;
	onModelChange: (v: string) => void;
	options: DiscoveredModel[];
	source: string | null;
}

// A model dropdown (discovered/suggested) above a free-text id box that always
// accepts a custom id. The `source` line subtly says whether the list came from
// a live discovery call or the built-in fallback.
function ModelPicker({
	busy,
	idPrefix,
	model,
	onModelChange,
	options,
	source,
}: ModelPickerProps) {
	const ids = options.map((o) => o.id);
	return (
		<div className="flex flex-col gap-1.5">
			<Label htmlFor={`${idPrefix}-model`}>Model</Label>
			{options.length > 0 ? (
				<Select
					items={options.map((o) => ({ value: o.id, label: o.name ?? o.id }))}
					onValueChange={(v) => onModelChange(v ?? "")}
					value={ids.includes(model) ? model : ""}
				>
					<SelectTrigger className="w-full" id={`${idPrefix}-model`}>
						<SelectValue placeholder="Pick a model" />
					</SelectTrigger>
					<SelectContent>
						{options.map((o) => (
							<SelectItem key={o.id} value={o.id}>
								{o.name ?? o.id}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			) : null}
			<Input
				id={
					options.length > 0 ? `${idPrefix}-model-custom` : `${idPrefix}-model`
				}
				onChange={(e) => onModelChange(e.target.value)}
				placeholder="Or type any model id"
				value={model}
			/>
			{busy ? (
				<span className="flex items-center gap-1.5 text-muted-foreground text-xs">
					<Spinner className="size-3" /> Discovering models…
				</span>
			) : (
				source && (
					<span className="text-muted-foreground text-xs">
						{source === "discovery"
							? "Models discovered live from the provider."
							: "Showing suggested models (live discovery unavailable)."}
					</span>
				)
			)}
		</div>
	);
}

// Map a provider's id/label/api text onto an svgl.app brand slug (themed
// light/dark where the mark needs it). Ordered most-specific-first so
// "openai-codex" resolves to the OpenAI mark, etc. A provider with no known
// mark (custom endpoints) falls back to its initial — never a wrong brand.
const PROVIDER_SVGL: [string, SvglSpec][] = [
	["anthropic", "claude"],
	["claude", "claude"],
	["codex", { light: "openai", dark: "openai_dark" }],
	["openai", { light: "openai", dark: "openai_dark" }],
	["gemini", "gemini"],
	["google", "gemini"],
	["mistral", "mistral-ai_logo"],
	["copilot", { light: "copilot", dark: "copilot_dark" }],
	["github", { light: "copilot", dark: "copilot_dark" }],
	["cursor", { light: "cursor_light", dark: "cursor_dark" }],
	["grok", { light: "grok-light", dark: "grok-dark" }],
	["xai", { light: "grok-light", dark: "grok-dark" }],
	["deepseek", "deepseek"],
	["perplexity", "perplexity"],
	["cohere", "cohere"],
	["openrouter", { light: "openrouter_light", dark: "openrouter_dark" }],
	["ollama", { light: "ollama_light", dark: "ollama_dark" }],
];

function svglForProvider(haystack: string): SvglSpec | null {
	const hay = haystack.toLowerCase();
	for (const [needle, spec] of PROVIDER_SVGL) {
		if (hay.includes(needle)) {
			return spec;
		}
	}
	return null;
}

/**
 * A provider's brand mark: a bundled brand logo when known, else its initial.
 * Just the logo — no border or background chrome. `SvglIcon` renders the
 * light/dark variant per theme for logos that ship both.
 */
function ProviderBrandMark({
	label,
	providerKey,
}: {
	label: string;
	providerKey: string;
}) {
	const spec = svglForProvider(providerKey);
	if (spec) {
		return (
			<span className="flex size-7 shrink-0 items-center justify-center">
				<SvglIcon className="object-contain" size={20} spec={spec} />
			</span>
		);
	}
	return (
		<span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted font-medium text-[11px] text-muted-foreground uppercase">
			{label.slice(0, 1)}
		</span>
	);
}

interface ProviderCardProps {
	activeConfig: PiConfig | null;
	/** The ryu agent's advertised ACP auth methods (for subscription logins). */
	authMethods: AcpAuthMethod[];
	/** Live connectivity probe (latency + model count). */
	check: ReturnType<typeof useLlmProviders>["check"];
	discover: ReturnType<typeof useLlmProviders>["discover"];
	onActivate: (input: {
		api?: string | null;
		model: string;
		provider: string;
		thinkingLevel: string | null;
	}) => Promise<void>;
	onConfigure: (input: {
		apiKey?: string | null;
		provider: string;
		routing?: string | null;
	}) => Promise<void>;
	/** Refresh the catalog so `configured` (login state) flips after a login. */
	onReload: () => void;
	onRemove: (id: string) => Promise<void>;
	/** Enable/disable a single model within this provider. */
	onToggleModel: (
		provider: string,
		model: string,
		enabled: boolean
	) => Promise<unknown>;
	provider: PiProvider;
	thinkingLevels: string[];
}

function ProviderCard({
	activeConfig,
	authMethods,
	check,
	discover,
	onActivate,
	onConfigure,
	onReload,
	onRemove,
	onToggleModel,
	provider,
	thinkingLevels,
}: ProviderCardProps) {
	const isActive = Boolean(provider.active);
	// Subscription-login providers (ChatGPT / Claude Pro-Max / Copilot) get a
	// Login button, not an API-key field. The managed provider is excluded — it
	// is included with the plan and needs no user login.
	const isSubscription =
		provider.authKind === "subscription" && !provider.managed;
	const needsKey = provider.authKind === "api-key";
	const activeNode = useActiveNode();
	// The managed provider is always `configured` (wallet-gated server-side), so its
	// upsell gates on the paid-plan entitlement. When the user has no plan, the card
	// leads with an Upgrade CTA instead of presenting it as ready to use.
	const { verdict, requestUpgrade } = useEntitlementContext();
	const managedNeedsPlan =
		Boolean(provider.managed) && !(verdict?.managedInference ?? false);
	const authMethod = isSubscription
		? matchAuthMethod(provider.id, authMethods)
		: null;
	const [loggingIn, setLoggingIn] = useState(false);

	const activateLabel = (busy: boolean): string => {
		if (isActive) {
			return "In use";
		}
		return busy ? "Activating…" : "Use this provider";
	};

	// Collapsed by default — the catalog can carry ~18 providers, so an open list
	// would be overwhelming; the header row alone conveys status at a glance.
	const [open, setOpen] = useState(false);
	const [apiKey, setApiKey] = useState("");
	const [model, setModel] = useState(
		isActive ? (activeConfig?.model ?? "") : ""
	);
	const [thinkingLevel, setThinkingLevel] = useState(
		isActive ? (activeConfig?.thinkingLevel ?? "") : ""
	);
	const [routing, setRouting] = useState(provider.routing);
	const [discovered, setDiscovered] = useState<DiscoveredModel[]>([]);
	const [source, setSource] = useState<string | null>(null);
	const [discovering, setDiscovering] = useState(false);
	const [savingKey, setSavingKey] = useState(false);
	const [activating, setActivating] = useState(false);
	const [removing, setRemoving] = useState(false);
	const [checking, setChecking] = useState(false);
	const [checkResult, setCheckResult] = useState<CheckProviderResult | null>(
		null
	);
	const [togglingModel, setTogglingModel] = useState<string | null>(null);

	// Keep the card's routing mirror honest when the catalog refreshes.
	useEffect(() => {
		setRouting(provider.routing);
	}, [provider.routing]);

	// The dropdown starts with the provider's suggestions + whatever is set, and
	// merges in live-discovered ids (deduped, order preserved).
	const modelOptions = useMemo<DiscoveredModel[]>(() => {
		const seen = new Set<string>();
		const out: DiscoveredModel[] = [];
		const push = (m: DiscoveredModel) => {
			if (m.id && !seen.has(m.id)) {
				seen.add(m.id);
				out.push(m);
			}
		};
		for (const m of discovered) {
			push(m);
		}
		for (const id of provider.suggestedModels) {
			push({ id });
		}
		if (model) {
			push({ id: model });
		}
		return out;
	}, [discovered, provider.suggestedModels, model]);

	const runDiscovery = async () => {
		setDiscovering(true);
		try {
			const res = await discover({ provider: provider.id });
			setDiscovered(res.models);
			setSource(res.source);
		} catch (e) {
			setSource(null);
			sileo.error({
				title: "Could not discover models",
				description: errMessage(e, "The provider did not respond."),
			});
		} finally {
			setDiscovering(false);
		}
	};

	// Auto-discover the live model list the first time a card is expanded, so the
	// picker shows real models (models.dev / a provider's /v1/models) instead of
	// only the static suggestions. Runs once per card; the manual "Discover
	// models" button re-runs it on demand.
	const discoveredOnceRef = useRef(false);
	// biome-ignore lint/correctness/useExhaustiveDependencies: one-shot on first expand; runDiscovery is intentionally not a dep
	useEffect(() => {
		if (
			open &&
			!discoveredOnceRef.current &&
			provider.supportsDiscovery !== false
		) {
			discoveredOnceRef.current = true;
			runDiscovery().catch(() => undefined);
		}
	}, [open, provider.supportsDiscovery]);

	const handleLogin = async () => {
		if (!authMethod) {
			return;
		}
		setLoggingIn(true);
		try {
			const res = await authenticateAgent(
				toTarget(activeNode),
				RYU_AGENT_ID,
				authMethod.id
			);
			if (res.authenticated) {
				sileo.success({ title: `Connected ${provider.label}` });
				// `configured` reflects login state — refresh so it flips to Connected.
				onReload();
			} else {
				sileo.error({
					title: `Could not connect ${provider.label}`,
					description: res.error ?? "The agent rejected the login.",
				});
			}
		} catch (e) {
			sileo.error({
				title: `Could not connect ${provider.label}`,
				description: errMessage(e, "The login request failed."),
			});
		} finally {
			setLoggingIn(false);
		}
	};

	const handleSaveKey = async () => {
		setSavingKey(true);
		try {
			await onConfigure({ provider: provider.id, apiKey });
			setApiKey("");
			sileo.success({ title: `${provider.label} credential saved` });
		} catch (e) {
			sileo.error({
				title: "Could not save credential",
				description: errMessage(e, "Core rejected the request."),
			});
		} finally {
			setSavingKey(false);
		}
	};

	const handleToggleRouting = async (gateway: boolean) => {
		const next = gateway ? GATEWAY : DIRECT;
		const previous = routing;
		setRouting(next);
		try {
			await onConfigure({ provider: provider.id, routing: next });
			sileo.success({
				title:
					next === GATEWAY
						? `${provider.label} routes through the Gateway`
						: `${provider.label} egress is direct`,
			});
		} catch (e) {
			setRouting(previous);
			sileo.error({
				title: "Could not update routing",
				description: errMessage(e, "Core rejected the request."),
			});
		}
	};

	const handleActivate = async () => {
		setActivating(true);
		try {
			await onActivate({
				provider: provider.id,
				model: model.trim(),
				thinkingLevel: thinkingLevel || null,
				api: provider.api || null,
			});
			sileo.success({ title: `Now using ${provider.label}` });
		} catch (e) {
			sileo.error({
				title: "Could not activate provider",
				description: errMessage(e, "Core rejected the request."),
			});
		} finally {
			setActivating(false);
		}
	};

	const handleRemove = async () => {
		setRemoving(true);
		try {
			await onRemove(provider.id);
			sileo.success({ title: `${provider.label} credential removed` });
		} catch (e) {
			sileo.error({
				title: "Could not remove credential",
				description: errMessage(e, "Core rejected the request."),
			});
		} finally {
			setRemoving(false);
		}
	};

	// Live connectivity probe. Sends the freshly-typed key (if any) so the user
	// can validate a credential before saving it; never persisted.
	const handleCheck = async () => {
		setChecking(true);
		setCheckResult(null);
		try {
			const res = await check({
				provider: provider.id,
				apiKey: apiKey.trim() || undefined,
			});
			setCheckResult(res);
		} catch (e) {
			setCheckResult({
				ok: false,
				latencyMs: 0,
				modelCount: 0,
				error: errMessage(e, "The check failed."),
			});
		} finally {
			setChecking(false);
		}
	};

	const handleToggleModel = async (modelId: string, enabled: boolean) => {
		setTogglingModel(modelId);
		try {
			await onToggleModel(provider.id, modelId, enabled);
		} catch (e) {
			sileo.error({
				title: "Could not update model",
				description: errMessage(e, "Core rejected the request."),
			});
		} finally {
			setTogglingModel(null);
		}
	};

	return (
		<SettingsCard className={isActive ? "p-0 ring-1 ring-primary/40" : "p-0"}>
			<Collapsible onOpenChange={setOpen} open={open}>
				{/* Header row (always visible): label + status hint + chevron. Base UI
				    manages aria-expanded + keyboard on the trigger button. */}
				<CollapsibleTrigger className="flex w-full items-center justify-between gap-3 rounded-[10px] p-3.5 text-left hover:bg-muted/40">
					<div className="flex min-w-0 items-center gap-2.5">
						<ProviderBrandMark
							label={provider.label}
							providerKey={`${provider.id} ${provider.label} ${provider.api}`}
						/>
						<div className="flex min-w-0 flex-col gap-1">
							<div className="flex flex-wrap items-center gap-2">
								<span className="font-medium text-sm">{provider.label}</span>
								{isActive ? (
									<Badge className="text-[10px]">Active</Badge>
								) : null}
								{provider.managed ? (
									<Badge className="text-[10px]" variant="secondary">
										{managedNeedsPlan
											? "Requires Ryu subscription"
											: "Included with your plan"}
									</Badge>
								) : null}
								{provider.configured && !provider.managed ? (
									<Badge className="text-[10px]" variant="outline">
										{isSubscription ? "Connected" : "Configured"}
									</Badge>
								) : null}
							</div>
							<span className="text-muted-foreground text-xs">
								{provider.api}
								{provider.custom ? " · custom" : ""}
							</span>
						</div>
					</div>
					<HugeiconsIcon
						className={`size-4 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`}
						icon={ArrowDown01Icon}
					/>
				</CollapsibleTrigger>

				<CollapsibleContent className="flex flex-col gap-3 px-3.5 pt-1 pb-3.5">
					{managedNeedsPlan ? (
						<div className="flex flex-col gap-2 rounded-lg border border-primary/30 bg-primary/5 p-3">
							<span className="font-medium text-sm">
								Every model, one subscription
							</span>
							<span className="text-muted-foreground text-xs">
								Ryu's managed OpenRouter routes to every major model with no API
								keys and no per-provider setup. Upgrade to use it, or add your
								own OpenRouter key below.
							</span>
							<div className="flex justify-start">
								<Button onClick={() => requestUpgrade()} size="sm">
									Upgrade to Ryu
								</Button>
							</div>
						</div>
					) : null}
					<div className="flex items-center justify-between gap-3">
						<Label
							className="text-muted-foreground text-xs"
							htmlFor={`routing-${provider.id}`}
						>
							Route through Gateway
						</Label>
						<Switch
							checked={routing === GATEWAY}
							disabled={provider.routingLocked}
							id={`routing-${provider.id}`}
							onCheckedChange={handleToggleRouting}
						/>
					</div>

					{isSubscription ? (
						<div className="flex flex-col gap-2">
							<div className="flex items-center justify-between gap-3">
								<div className="flex flex-col gap-0.5">
									<span className="font-medium text-sm">
										{provider.configured ? "Connected" : "Not connected"}
									</span>
									<span className="text-muted-foreground text-xs">
										Sign in with your{" "}
										{provider.label.replace(/\s*\([^)]*\)\s*$/, "")}{" "}
										subscription — no API key needed.
									</span>
								</div>
								<Button
									disabled={loggingIn || !authMethod}
									onClick={handleLogin}
									size="sm"
									variant={provider.configured ? "outline" : "default"}
								>
									{loggingIn
										? "Connecting…"
										: provider.configured
											? "Reconnect"
											: "Login"}
								</Button>
							</div>
							{authMethod ? null : (
								<p className="text-muted-foreground text-xs">
									Login not available for this agent build.
								</p>
							)}
							{/* GitHub Copilot uses a device-code flow: Pi may open a browser
							    for the user to finish authorizing. */}
						</div>
					) : null}

					{needsKey ? (
						<div className="flex flex-col gap-1.5">
							<Label htmlFor={`key-${provider.id}`}>API key</Label>
							<div className="flex items-center gap-2">
								<Input
									autoComplete="off"
									className="flex-1"
									id={`key-${provider.id}`}
									onChange={(e) => setApiKey(e.target.value)}
									placeholder={
										provider.configured
											? "Stored — leave blank to keep"
											: "sk-…"
									}
									type="password"
									value={apiKey}
								/>
								<Button
									disabled={savingKey || apiKey.trim() === ""}
									onClick={handleSaveKey}
									size="sm"
								>
									{savingKey ? "Saving…" : "Save"}
								</Button>
								{provider.supportsDiscovery === false ? null : (
									<Button
										disabled={checking}
										onClick={handleCheck}
										size="sm"
										variant="outline"
									>
										{checking ? "Checking…" : "Check"}
									</Button>
								)}
								{provider.configured ? (
									<Button
										disabled={removing}
										onClick={handleRemove}
										size="sm"
										variant="outline"
									>
										{removing ? "Removing…" : "Remove"}
									</Button>
								) : null}
							</div>
							{checking ? (
								<span className="flex items-center gap-1.5 text-muted-foreground text-xs">
									<Spinner className="size-3" /> Checking connectivity…
								</span>
							) : null}
							{!checking && checkResult ? (
								<span
									className={
										checkResult.ok
											? "text-emerald-600 text-xs dark:text-emerald-400"
											: "text-destructive text-xs"
									}
								>
									{checkResult.ok
										? `OK · ${checkResult.latencyMs}ms · ${checkResult.modelCount} models`
										: (checkResult.error ?? "Check failed")}
								</span>
							) : null}
						</div>
					) : null}

					<ModelPicker
						busy={discovering}
						idPrefix={provider.id}
						model={model}
						onModelChange={setModel}
						options={modelOptions}
						source={source}
					/>

					{modelOptions.length > 0 ? (
						<div className="flex flex-col gap-1.5">
							<Label>Enabled models</Label>
							<div className="flex max-h-48 flex-col gap-0.5 overflow-y-auto rounded-md border border-border/60 p-1.5">
								{modelOptions.map((m) => {
									// Absent from the overrides map ⇒ enabled by default.
									const enabled = provider.modelOverrides?.[m.id] !== false;
									return (
										<div
											className="flex items-center justify-between gap-2 px-1.5 py-1"
											key={m.id}
										>
											<span className="min-w-0 truncate text-xs">
												{m.name ?? m.id}
											</span>
											<Switch
												checked={enabled}
												disabled={togglingModel === m.id}
												onCheckedChange={(next) =>
													handleToggleModel(m.id, next)
												}
											/>
										</div>
									);
								})}
							</div>
						</div>
					) : null}

					<div className="flex flex-wrap items-end justify-between gap-2">
						<div className="flex flex-col gap-1.5">
							<Label htmlFor={`thinking-${provider.id}`}>Thinking level</Label>
							<Select
								items={[
									{ value: "", label: "Provider default" },
									...thinkingLevels.map((l) => ({ value: l, label: l })),
								]}
								onValueChange={(v) => setThinkingLevel(v ?? "")}
								value={thinkingLevel}
							>
								<SelectTrigger className="w-44" id={`thinking-${provider.id}`}>
									<SelectValue placeholder="Provider default" />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="">Provider default</SelectItem>
									{thinkingLevels.map((l) => (
										<SelectItem key={l} value={l}>
											{l}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>
						<div className="flex items-center gap-2">
							{provider.supportsDiscovery === false ? null : (
								<Button
									disabled={discovering}
									onClick={runDiscovery}
									size="sm"
									variant="outline"
								>
									{discovering ? "Loading…" : "Discover models"}
								</Button>
							)}
							<Button
								disabled={activating || isActive}
								onClick={handleActivate}
								size="sm"
							>
								{activateLabel(activating)}
							</Button>
						</div>
					</div>
				</CollapsibleContent>
			</Collapsible>
		</SettingsCard>
	);
}

interface CustomProviderFormProps {
	apiTypes: string[];
	onCreate: (input: {
		api: string;
		apiKey: string | null;
		baseUrl: string;
		provider: string;
	}) => Promise<void>;
}

// The "custom OpenAI-compatible provider" affordance — base URL + optional key +
// api type + a user-named id → POST /providers, which then surfaces it in the
// list above like any other provider.
function CustomProviderForm({ apiTypes, onCreate }: CustomProviderFormProps) {
	const [id, setId] = useState("");
	const [baseUrl, setBaseUrl] = useState("");
	const [apiKey, setApiKey] = useState("");
	const [api, setApi] = useState(DEFAULT_API);
	const [saving, setSaving] = useState(false);

	const canCreate = id.trim() !== "" && baseUrl.trim() !== "" && !saving;

	const handleCreate = async () => {
		setSaving(true);
		try {
			await onCreate({
				provider: id.trim(),
				baseUrl: baseUrl.trim(),
				apiKey: apiKey.trim() || null,
				api,
			});
			setId("");
			setBaseUrl("");
			setApiKey("");
			setApi(DEFAULT_API);
			sileo.success({ title: "Custom provider added" });
		} catch (e) {
			sileo.error({
				title: "Could not add provider",
				description: errMessage(e, "Core rejected the request."),
			});
		} finally {
			setSaving(false);
		}
	};

	return (
		<SettingsCard className="flex flex-col gap-3">
			<div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
				<div className="flex flex-col gap-1.5">
					<Label htmlFor="custom-id">Provider id</Label>
					<Input
						id="custom-id"
						onChange={(e) => setId(e.target.value)}
						placeholder="ollama"
						value={id}
					/>
				</div>
				<div className="flex flex-col gap-1.5">
					<Label htmlFor="custom-api">API type</Label>
					<Select
						items={apiTypes.map((a) => ({ value: a, label: a }))}
						onValueChange={(v) => setApi(v ?? DEFAULT_API)}
						value={api}
					>
						<SelectTrigger className="w-full" id="custom-api">
							<SelectValue placeholder="API type" />
						</SelectTrigger>
						<SelectContent>
							{apiTypes.map((a) => (
								<SelectItem key={a} value={a}>
									{a}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>
				<div className="flex flex-col gap-1.5 sm:col-span-2">
					<Label htmlFor="custom-url">Base URL</Label>
					<Input
						id="custom-url"
						onChange={(e) => setBaseUrl(e.target.value)}
						placeholder="http://localhost:11434/v1"
						value={baseUrl}
					/>
				</div>
				<div className="flex flex-col gap-1.5 sm:col-span-2">
					<Label htmlFor="custom-key">API key (optional)</Label>
					<Input
						autoComplete="off"
						id="custom-key"
						onChange={(e) => setApiKey(e.target.value)}
						placeholder="Leave blank for keyless local servers"
						type="password"
						value={apiKey}
					/>
				</div>
			</div>
			<div className="flex justify-end">
				<Button disabled={!canCreate} onClick={handleCreate} size="sm">
					{saving ? "Adding…" : "Add provider"}
				</Button>
			</div>
		</SettingsCard>
	);
}

export function LlmProvidersSettings() {
	const {
		catalog,
		config,
		loading,
		error,
		activate,
		check,
		configure,
		remove,
		discover,
		toggleModelEnabled,
		reload,
	} = useLlmProviders();

	// The ryu agent's advertised ACP auth methods back the subscription-login
	// buttons. Session-independent (keyed by agent id), so it's available before
	// any chat exists; empty for agent builds that advertise no login methods.
	const { config: ryuAcpConfig } = useAcpConfig(RYU_AGENT_ID);
	const authMethods = ryuAcpConfig?.authMethods ?? [];

	if (loading) {
		return (
			<div className="flex items-center gap-2 text-muted-foreground text-sm">
				<Spinner className="size-4" /> Loading providers…
			</div>
		);
	}

	if (error) {
		return (
			<div className="rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-destructive text-sm">
				Failed to load providers: {error}
			</div>
		);
	}

	const cat: PiCatalog = catalog ?? {
		apiTypes: [DEFAULT_API],
		providers: [],
		thinkingLevels: [],
	};
	const ordered = orderProviders(cat.providers);

	const handleActivate = async (input: {
		api?: string | null;
		model: string;
		provider: string;
		thinkingLevel: string | null;
	}) => {
		await activate({
			provider: input.provider,
			model: input.model || null,
			thinkingLevel: input.thinkingLevel,
			api: input.api,
		});
	};

	const handleConfigure = async (input: {
		apiKey?: string | null;
		provider: string;
		routing?: string | null;
	}) => {
		await configure(input);
	};

	const handleCreateCustom = async (input: {
		api: string;
		apiKey: string | null;
		baseUrl: string;
		provider: string;
	}) => {
		await configure(input);
	};

	return (
		<div className="space-y-6">
			<SettingsSection
				caption="Configure any number of providers, then pick one to power the Ryu agent. The Gateway toggle governs each provider's egress independently (firewall · budget · audit); the managed provider is always Gateway-routed. Model, credential, and routing choices all live in Core's isolated Pi config."
				title="Providers"
			>
				<div className="space-y-2.5">
					{ordered.map((provider) => (
						<ProviderCard
							activeConfig={config}
							authMethods={authMethods}
							check={check}
							discover={discover}
							key={provider.id}
							onActivate={handleActivate}
							onConfigure={handleConfigure}
							onReload={reload}
							onRemove={remove}
							onToggleModel={toggleModelEnabled}
							provider={provider}
							thinkingLevels={cat.thinkingLevels}
						/>
					))}
				</div>
			</SettingsSection>

			<SettingsSection
				caption="Point Ryu at any OpenAI-compatible endpoint — a local llama.cpp / Ollama / vLLM server or a hosted gateway. It joins the list above and can be activated like any built-in provider."
				title="Custom OpenAI-compatible provider"
			>
				<CustomProviderForm
					apiTypes={cat.apiTypes}
					onCreate={handleCreateCustom}
				/>
			</SettingsSection>
		</div>
	);
}
