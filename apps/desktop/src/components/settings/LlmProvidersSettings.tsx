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
import { SvglIcon } from "@ryu/blocks/web/svgl-icon.tsx";
import { Badge } from "@ryu/ui/components/badge.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@ryu/ui/components/collapsible.tsx";
import { CommandItem } from "@ryu/ui/components/command.tsx";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ryu/ui/components/dialog.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { Label } from "@ryu/ui/components/label.tsx";
import { Logo as RyuOrbLogo } from "@ryu/ui/components/logo.tsx";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select.tsx";
import { SkeletonRows } from "@ryu/ui/components/skeleton.tsx";
import { Spinner } from "@ryu/ui/components/spinner.tsx";
import { StatusBadge } from "@ryu/ui/components/status-badge.tsx";
import { Switch } from "@ryu/ui/components/switch.tsx";
import { useEffect, useMemo, useRef, useState } from "react";
import { sileo } from "sileo";
import { modelMenuItem } from "@/components/agent-elements/input/model-router.ts";
import {
	ProviderAccountSection,
	type ProviderAccountTarget,
} from "@/components/agent-elements/input/provider-account-section.tsx";
import { useProviderCommandNavigation } from "@/components/agent-elements/input/provider-command-dialog.tsx";
import { OrgBillingContext } from "@/src/components/billing/OrgBillingContext.tsx";
import { useEntitlementContext } from "@/src/contexts/entitlement-context.tsx";
import { useCreditsWallet } from "@/src/hooks/useCreditsWallet.ts";
import { useLlmProviders } from "@/src/hooks/useLlmProviders.ts";
import { ApiError } from "@/src/lib/api/client.ts";
import { unrestrictedCreditBalanceMicroUsd } from "@/src/lib/api/credits.ts";
import type {
	CheckProviderResult,
	DiscoveredModel,
	PiCatalog,
	PiConfig,
	PiLoginEvent,
	PiProvider,
} from "@/src/lib/api/pi-config.ts";
import { gatewayProviderSlug } from "@/src/lib/api/pi-config.ts";
import {
	isRyuManagedProvider,
	svglForProvider,
} from "@/src/lib/provider-brand.tsx";
import { useGatewayDialog } from "@/src/store/useGatewayDialog.ts";
import { useSettingsDialog } from "@/src/store/useSettingsDialog.ts";
import { AgentModelsSettings } from "./AgentModelsSettings.tsx";
import { ProviderLoginDialog } from "./dialogs/ProviderLoginDialog.tsx";
import { ModelParametersSettings } from "./ModelParametersSettings.tsx";
import { OAuthAccountPoolControls } from "./OAuthAccountPoolControls.tsx";
import { ProviderDesktopRouteSetting } from "./ProviderDesktopRouteSetting.tsx";
import {
	ProviderKeySafetyNotice,
	SpendLimitConfirm,
} from "./shared/provider-key-safety.tsx";
import { SettingsCard, SettingsSection } from "./shared/settings-items.tsx";

const GATEWAY = "gateway";
const DIRECT = "direct";
const DEFAULT_API = "openai-completions";
function errMessage<TError>(e: TError, fallback: string): string {
	// Prefer Core's own reason over the generic "<path> failed: <status>" text.
	if (e instanceof ApiError && e.serverMessage) {
		return e.serverMessage;
	}
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

function supportsOAuth(provider: PiProvider): boolean {
	return provider.supportsOAuth ?? provider.authKind === "subscription";
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
							: source === "unavailable"
								? "Models are unavailable. Check the connection and granted permissions."
								: source === "saved"
									? "Showing models saved from the last successful discovery."
									: source === "pi"
										? "Models from the installed Pi engine."
										: source === "models.dev"
											? "Models from the models.dev catalog."
											: "Showing suggested models (discovery unavailable)."}
					</span>
				)
			)}
		</div>
	);
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
	if (isRyuManagedProvider(providerKey)) {
		return (
			<span className="flex size-7 shrink-0 items-center justify-center">
				<RyuOrbLogo size="20px" />
			</span>
		);
	}
	const spec = svglForProvider(providerKey);
	if (spec) {
		return (
			<span className="flex size-7 shrink-0 items-center justify-center">
				<SvglIcon className="object-contain" size={20} spec={spec} />
			</span>
		);
	}
	return (
		<span className="type-caption flex size-7 shrink-0 items-center justify-center rounded-md bg-muted font-medium text-muted-foreground uppercase">
			{label.slice(0, 1)}
		</span>
	);
}

interface ProviderCardProps {
	activeConfig: PiConfig | null;
	/** Whether this caller may set a BYOK account for the Gateway. */
	canSetGatewayAccount?: boolean;
	/** Live connectivity probe (latency + model count). */
	check: ReturnType<typeof useLlmProviders>["check"];
	discover: ReturnType<typeof useLlmProviders>["discover"];
	/** Whether this org has unrestricted prepaid credits for retail Ryu models. */
	hasPrepaidManagedBalance: boolean;
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
	/** Remove one saved account without removing the provider. */
	onRemoveAccount: (provider: string, accountId: string) => Promise<PiCatalog>;
	/** Rename one saved account without changing its credentials. */
	onRenameAccount: (
		provider: string,
		accountId: string,
		label: string
	) => Promise<void>;
	/** Switch one saved account for yourself or the shared Gateway. */
	onSwitchAccount: (
		provider: string,
		accountId: string,
		target: ProviderAccountTarget
	) => Promise<void>;
	/** Enable/disable a single model within this provider. */
	onToggleModel: (
		provider: string,
		model: string,
		enabled: boolean
	) => Promise<void>;
	provider: PiProvider;
	thinkingLevels: string[];
}

/** The one managed pool with no donated allowance behind it — retail
 *  pass-through, paid for out of subscription/top-up credit. Every OTHER pool is
 *  donated supply that grants land in, so it needs no plan. Mirrors the
 *  `openrouter` id in `packages/auth/src/lib/credit-pools.ts`. */
const RETAIL_CREDIT_POOL = "openrouter";

/** What a managed row's chip says.
 *
 *  Three states, not two: a pool-backed row is neither "included with your plan"
 *  (it is not — it is donated supply you may hold a grant of) nor "requires a
 *  subscription" (it does not). Saying either of the old two about it is wrong in
 *  a way that costs the user the credit they already have. */
function managedBadgeLabel(needsCredits: boolean, poolBacked: boolean): string {
	if (poolBacked) {
		return "Org credit pool";
	}
	return needsCredits ? "Add prepaid credits" : "Ryu managed";
}

function ProviderCard(props: ProviderCardProps) {
	const navigation = useProviderCommandNavigation();
	if (!navigation) {
		return <ProviderCardContent {...props} />;
	}
	return (
		<CommandItem
			className="mx-1 my-0.5 min-h-12"
			onSelect={() =>
				navigation.push({
					body: <ProviderCardContent {...props} />,
					title: props.provider.label,
				})
			}
		>
			<span className="flex min-w-0 flex-1 flex-col items-start gap-0.5">
				<span className="font-medium">{props.provider.label}</span>
				<span className="text-muted-foreground text-xs">
					{props.provider.configured
						? "Configure models and credentials"
						: "Set up provider login"}
				</span>
			</span>
		</CommandItem>
	);
}

function ProviderCardContent({
	activeConfig: initialActiveConfig,
	canSetGatewayAccount = true,
	check,
	discover,
	onActivate,
	onConfigure,
	onReload,
	onRemove,
	onRemoveAccount,
	onRenameAccount,
	onSwitchAccount,
	onToggleModel,
	provider: initialProvider,
	thinkingLevels,
	hasPrepaidManagedBalance,
}: ProviderCardProps) {
	const navigation = useProviderCommandNavigation();
	// ProviderCommandDialog keeps a detail page mounted as a ReactNode. That
	// page does not receive fresh props when the catalog query changes, so a
	// saved key, switched account, model toggle, or activation could leave its
	// status and controls showing the pre-mutation snapshot. Subscribe to the
	// shared provider queries from the detail page itself; the cache keys are
	// intentionally shared with the parent settings surface.
	const { catalog: liveCatalog, config: liveConfig } = useLlmProviders();
	const provider =
		liveCatalog?.providers.find((item) => item.id === initialProvider.id) ??
		initialProvider;
	const activeConfig = liveConfig ?? initialActiveConfig;
	const isActive = Boolean(provider.active);
	const isChatgptPlan = provider.id === "chatgpt-plan";
	// A few providers offer both OAuth and an API key. Show both connection
	// methods while keeping their accounts in the same provider vault scope.
	const isSubscription = supportsOAuth(provider) && !provider.managed;
	const needsKey = provider.authKind === "api-key";
	const hasOAuthAccount =
		provider.accounts?.some((account) => account.kind === "oauth") ?? false;
	const oauthActive =
		provider.accounts?.some(
			(account) => account.kind === "oauth" && account.active
		) ?? false;
	const oauthConnected = isChatgptPlan
		? provider.connectionState === "authorized" ||
			provider.connectionState === "identity-only"
		: oauthActive || (!needsKey && provider.configured);
	// Retail Ryu inference is available from an included managed-plan pool or
	// an unrestricted prepaid wallet balance. Provider-restricted donated credits
	// only unlock their matching pool-backed provider rows.
	const { verdict } = useEntitlementContext();
	const isPoolBacked = Boolean(
		provider.creditPool && provider.creditPool !== RETAIL_CREDIT_POOL
	);
	const needsPrepaidBalance =
		Boolean(provider.managed) &&
		!isPoolBacked &&
		!(verdict?.managedInference ?? false) &&
		!hasPrepaidManagedBalance;
	// The subscription login dialog owns the OAuth flow end to end.
	const [loginOpen, setLoginOpen] = useState(false);

	// Collapsed by default — the catalog can carry ~18 providers, so an open list
	// would be overwhelming; the header row alone conveys status at a glance.
	const [open, setOpen] = useState(false);
	const [apiKey, setApiKey] = useState("");
	const [limitConfirmed, setLimitConfirmed] = useState(false);
	const [model, setModel] = useState(
		isActive ? (activeConfig?.model ?? "") : ""
	);
	const [thinkingLevel, setThinkingLevel] = useState(
		isActive ? (activeConfig?.thinkingLevel ?? "") : ""
	);
	const activationIsCurrent =
		isActive &&
		model === (activeConfig?.model ?? "") &&
		thinkingLevel === (activeConfig?.thinkingLevel ?? "");
	const activateLabel = (busy: boolean): string =>
		activationIsCurrent
			? "In use"
			: busy
				? "Applying…"
				: isActive
					? "Apply changes"
					: "Use this provider";
	const [loginChoice, setLoginChoice] = useState<
		| { kind: "new" }
		| { kind: "saved"; accountId: string; enablePlanUse: boolean }
	>({ kind: "new" });
	const [welcomeOpen, setWelcomeOpen] = useState(false);
	const welcomeSeen = useRef(new Set<string>());
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

	const handleSwitchAccount = async (
		accountId: string,
		target: ProviderAccountTarget
	) => {
		try {
			await onSwitchAccount(provider.id, accountId, target);
			sileo.success({
				title:
					target === "gateway"
						? `${provider.label} account is active for Gateway`
						: `${provider.label} account switched for you`,
			});
		} catch (error) {
			sileo.error({
				title: "Could not switch account",
				description: errMessage(error, "Core rejected the request."),
			});
		}
	};

	const handleRemoveAccount = async (accountId: string) => {
		try {
			const result = await onRemoveAccount(provider.id, accountId);
			if (isChatgptPlan && result?.sessionRevocationStatus === "unconfirmed") {
				sileo.warning({
					title: "Local account removed",
					description:
						"Remote revocation was not confirmed. Disconnect the app in ChatGPT settings to end its access.",
				});
				return;
			}
			sileo.success({ title: `${provider.label} account removed` });
		} catch (error) {
			sileo.error({
				title: "Could not remove account",
				description: errMessage(error, "Core rejected the request."),
			});
		}
	};

	const handleRenameAccount = async (
		accountId: string,
		label: string
	): Promise<boolean> => {
		try {
			await onRenameAccount(provider.id, accountId, label);
			sileo.success({ title: `${provider.label} account renamed` });
			return true;
		} catch (error) {
			sileo.error({
				title: "Could not rename account",
				description: errMessage(error, "Core rejected the request."),
			});
			return false;
		}
	};

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
				const item = modelMenuItem(m.id, m.name);
				out.push({ id: item.id, name: item.name });
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
		const version = ++discoveryVersion.current;
		setDiscovering(true);
		try {
			const res = await discover({ provider: provider.id });
			if (version !== discoveryVersion.current) {
				return;
			}
			setDiscovered(res.models);
			setSource(res.source);
		} catch (e) {
			if (version !== discoveryVersion.current) {
				return;
			}
			setSource(null);
			sileo.error({
				title: "Could not discover models",
				description: errMessage(e, "The provider did not respond."),
			});
		} finally {
			if (version === discoveryVersion.current) {
				setDiscovering(false);
			}
		}
	};

	// Auto-discover the live model list the first time a card is expanded, so the
	// picker shows real models (models.dev / a provider's /v1/models) instead of
	// only the static suggestions. Runs once per card; the manual "Discover
	// models" button re-runs it on demand.
	const discoveredOnceRef = useRef<string | null>(null);
	const discoveryVersion = useRef(0);
	const activeAccountId =
		provider.accounts?.find((account) => account.active)?.accountId ?? "";
	const discoveryAccountKey = `${activeAccountId}:${provider.connectionState ?? ""}`;
	useEffect(() => {
		if (
			open &&
			discoveredOnceRef.current !== discoveryAccountKey &&
			provider.supportsDiscovery !== false
		) {
			discoveredOnceRef.current = discoveryAccountKey;
			runDiscovery().catch(() => undefined);
		}
	}, [open, provider.supportsDiscovery, discoveryAccountKey]);

	// Opening the dialog IS the login: it starts the OAuth flow, opens the
	// browser, and streams the flow's prompts. The old path ran the agent's
	// advertised ACP method, which for pi-acp is a hint that logs nobody in.
	const handleLogin = () => {
		setLoginChoice({ kind: "new" });
		setLoginOpen(true);
	};
	const handleLoginSuccess = (event: PiLoginEvent) => {
		onReload();
		runDiscovery().catch(() => undefined);
		if (isChatgptPlan) {
			setLoginOpen(false);
		}
		if (!(isChatgptPlan && event.planUseAuthorized && event.accountId)) {
			return;
		}
		const key = `ryu-chatgpt-plan-welcome:${event.accountId}`;
		let seen = welcomeSeen.current.has(key);
		try {
			seen ||= window.localStorage.getItem(key) === "true";
			window.localStorage.setItem(key, "true");
		} catch {
			/* A private browser may disable preference storage. */
		}
		welcomeSeen.current.add(key);
		if (!seen) {
			setWelcomeOpen(true);
		}
	};

	const handleSaveKey = async () => {
		setSavingKey(true);
		try {
			await onConfigure({ provider: provider.id, apiKey });
			setApiKey("");
			setLimitConfirmed(false);
			if (provider.custom && provider.supportsDiscovery !== false) {
				await runDiscovery();
			}
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
			if (provider.custom) {
				navigation?.pop();
			}
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

	const allModelsEnabled =
		modelOptions.length > 0 &&
		modelOptions.every((m) => provider.modelOverrides?.[m.id] !== false);
	const handleToggleAllModels = async (enabled: boolean) => {
		const providerId = provider.id;
		const modelIds = modelOptions.map((model) => model.id);
		const saveModel = onToggleModel;
		let saved = 0;
		setTogglingModel("__all__");
		try {
			for (const modelId of modelIds) {
				await saveModel(providerId, modelId, enabled);
				saved += 1;
			}
		} catch (e) {
			sileo.error({
				title: "Could not update all models",
				description: `${saved} of ${modelIds.length} model settings saved. ${errMessage(e, "Core rejected the request.")}`,
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
				<CollapsibleTrigger
					appearance="provider-group"
					className="flex w-full items-center justify-between text-left"
				>
					<div className="flex min-w-0 items-center gap-2.5">
						{/* Resolve the brand mark on id+label ONLY — never `provider.api`.
						    The Pi `api` type is a transport ("openai-completions",
						    "openai-responses"), and every OpenAI-compatible provider's api
						    literally contains "openai", so folding it into the haystack made
						    DeepSeek/Groq/Cerebras/Mistral/… all resolve to the OpenAI mark. */}
						<ProviderBrandMark
							label={provider.label}
							providerKey={`${provider.id} ${provider.label}`}
						/>
						<div className="flex min-w-0 flex-col gap-1">
							<div className="flex flex-wrap items-center gap-2">
								<span className="font-medium text-sm">{provider.label}</span>
								{/* The shared status glyph, same as every catalog row. "Managed"
								    and "Requires Ryu subscription" beside it stay prose: those are
								    facts about the PROVIDER, not a state it is in. */}
								{isActive ? <StatusBadge kind="active" /> : null}
								{provider.managed ? (
									<Badge size="compact" variant="secondary">
										{managedBadgeLabel(needsPrepaidBalance, isPoolBacked)}
									</Badge>
								) : null}
								{provider.configured && !provider.managed ? (
									<Badge size="compact" variant="outline">
										{isSubscription && (!needsKey || oauthActive)
											? "Connected"
											: "Configured"}
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

				<CollapsibleContent className="flex flex-col" spacing="provider-fields">
					{needsPrepaidBalance ? (
						<div className="flex flex-col gap-2 rounded-lg border border-primary/30 bg-primary/5 p-3">
							<span className="font-medium text-sm">
								Use Ryu-managed models with prepaid credits
							</span>
							<span className="text-muted-foreground text-xs">
								Ryu Gateway is pay as you go: add prepaid credits from the
								Credits view. No managed plan or separate Ryu node is required;
								usage pauses when the unrestricted wallet balance is empty.
								Plans include a monthly pool and discounted top-up fees.
							</span>
							<div className="flex justify-start">
								<Button
									onClick={() => {
										useGatewayDialog.getState().setOpen(false);
										useSettingsDialog.getState().openSettings("credits");
									}}
									size="sm"
								>
									Add prepaid credits
								</Button>
							</div>
						</div>
					) : null}
					<div className="flex items-center justify-between gap-3">
						<Label
							htmlFor={`routing-${provider.id}`}
							size="compact"
							tone="muted"
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
					<ProviderDesktopRouteSetting
						label={provider.label}
						providerId={provider.id}
					/>

					{isSubscription ? (
						<div className="flex flex-col gap-2">
							<div className="flex items-center justify-between gap-3">
								<div className="flex flex-col gap-0.5">
									<span className="font-medium text-sm">
										{oauthConnected
											? "OAuth connected"
											: hasOAuthAccount
												? "OAuth account saved"
												: "OAuth not connected"}
									</span>
									<span className="text-muted-foreground text-xs">
										{needsKey
											? `Sign in with ${provider.label}, or use an API key below.`
											: `Sign in with your ${provider.label.replace(/\s*\([^)]*\)\s*$/, "")} account. No API key needed.`}
									</span>
								</div>
								<Button
									onClick={handleLogin}
									size="sm"
									variant={
										isChatgptPlan || hasOAuthAccount ? "outline" : "default"
									}
								>
									{isChatgptPlan ? (
										<ProviderBrandMark label="ChatGPT" providerKey="chatgpt" />
									) : null}
									{isChatgptPlan
										? "Continue with ChatGPT"
										: hasOAuthAccount
											? "Add account"
											: "Login"}
								</Button>
							</div>
							{isChatgptPlan ? (
								<div className="flex flex-wrap items-center gap-2 text-muted-foreground text-xs">
									<span>
										{provider.connectionState === "identity-only"
											? "Identity is saved. Plan use needs separate permission."
											: "Eligible model requests use this ChatGPT plan. Add an account or reconnect the selected registration."}
									</span>
									<a
										className="underline underline-offset-4"
										href="https://chatgpt.com/settings/usage"
										rel="noopener noreferrer"
										target="_blank"
									>
										Manage usage
									</a>
									{activeAccountId ? (
										<Button
											onClick={() => {
												setLoginChoice({
													kind: "saved",
													accountId: activeAccountId,
													enablePlanUse:
														provider.connectionState === "identity-only",
												});
												setLoginOpen(true);
											}}
											size="sm"
											variant="outline"
										>
											{provider.connectionState === "identity-only"
												? "Enable plan use"
												: "Reconnect selected account"}
										</Button>
									) : null}
								</div>
							) : null}
							<ProviderLoginDialog
								accountId={
									loginChoice.kind === "saved"
										? loginChoice.accountId
										: undefined
								}
								enablePlanUse={
									loginChoice.kind === "saved" && loginChoice.enablePlanUse
								}
								onOpenChange={setLoginOpen}
								onSuccess={handleLoginSuccess}
								open={loginOpen}
								providerId={provider.id}
								providerLabel={provider.label.replace(/\s*\([^)]*\)\s*$/, "")}
							/>
							<Dialog onOpenChange={setWelcomeOpen} open={welcomeOpen}>
								<DialogContent>
									<DialogHeader>
										<DialogTitle>Your ChatGPT plan is connected</DialogTitle>
										<DialogDescription>
											When you select this provider, eligible requests use your
											ChatGPT plan. You can review app limits and credit
											settings in ChatGPT.
										</DialogDescription>
									</DialogHeader>
									<DialogFooter>
										<Button
											onClick={() =>
												window.open(
													"https://chatgpt.com/settings/usage",
													"_blank",
													"noopener,noreferrer"
												)
											}
											variant="outline"
										>
											Manage usage
										</Button>
										<Button onClick={() => setWelcomeOpen(false)}>
											Got it
										</Button>
									</DialogFooter>
								</DialogContent>
							</Dialog>
						</div>
					) : null}

					<ProviderAccountSection
						accounts={provider.accounts ?? []}
						canSetGateway={canSetGatewayAccount}
						gatewaySupported={
							provider.authKind === "api-key" &&
							gatewayProviderSlug(provider.id) !== null
						}
						onRemove={handleRemoveAccount}
						onRename={handleRenameAccount}
						onSwitch={(account, target) =>
							handleSwitchAccount(account.accountId, target)
						}
					/>
					{provider.accountRouting &&
					(provider.accounts?.some((account) =>
						provider.accountRouting?.credentialKinds.some(
							(kind) => kind === account.kind
						)
					) ??
						false) ? (
						<OAuthAccountPoolControls
							accounts={
								provider.accounts?.filter((account) =>
									provider.accountRouting?.credentialKinds.some(
										(kind) => kind === account.kind
									)
								) ?? []
							}
							capabilities={provider.accountRouting}
							providerId={provider.id}
						/>
					) : null}

					{needsKey ? (
						<div className="flex flex-col gap-1.5">
							<Label htmlFor={`key-${provider.id}`}>
								{provider.custom ? "API key (optional)" : "API key"}
							</Label>
							<div className="flex items-center gap-2">
								<Input
									autoComplete="off"
									className="flex-1"
									id={`key-${provider.id}`}
									onChange={(e) => setApiKey(e.target.value)}
									placeholder={
										provider.custom
											? "Optional — leave blank to keep current setting"
											: provider.configured
												? "Stored — leave blank to keep"
												: "sk-…"
									}
									type="password"
									value={apiKey}
								/>
								<Button
									disabled={
										savingKey || apiKey.trim() === "" || !limitConfirmed
									}
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
										variant="ghost"
									>
										{checking ? "Checking…" : "Check"}
									</Button>
								)}
								{provider.configured ? (
									<Button
										loading={removing}
										onClick={handleRemove}
										size="sm"
										variant="ghost"
									>
										{removing ? "Removing…" : "Remove"}
									</Button>
								) : null}
							</div>
							{apiKey.trim() === "" ? null : (
								<SpendLimitConfirm
									checked={limitConfirmed}
									id={`key-limit-${provider.id}`}
									onCheckedChange={setLimitConfirmed}
									providerId={provider.id}
									providerLabel={provider.label}
								/>
							)}
							{checking ? (
								<span className="flex items-center gap-1.5 text-muted-foreground text-xs">
									<Spinner className="size-3" /> Checking connectivity…
								</span>
							) : null}
							{!checking && checkResult ? (
								<span
									className={
										checkResult.ok
											? "text-status-success text-xs"
											: "text-status-destructive text-xs"
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
							<div className="flex items-center justify-between gap-2">
								<Label>Enabled models</Label>
								<div className="flex items-center gap-2">
									<span className="text-muted-foreground text-xs">
										{allModelsEnabled ? "All enabled" : "Some disabled"}
									</span>
									<Switch
										aria-label={`Enable all ${provider.label} models`}
										checked={allModelsEnabled}
										disabled={togglingModel !== null}
										onCheckedChange={handleToggleAllModels}
									/>
								</div>
							</div>
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
												aria-label={`Enable ${provider.label} model ${m.name ?? m.id}`}
												checked={enabled}
												disabled={
													togglingModel === "__all__" || togglingModel === m.id
												}
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
									variant="ghost"
								>
									{discovering ? "Loading…" : "Discover models"}
								</Button>
							)}
							<Button
								disabled={
									activating ||
									activationIsCurrent ||
									((provider.custom || isChatgptPlan) && model.trim() === "")
								}
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
	const [limitConfirmed, setLimitConfirmed] = useState(false);
	const [api, setApi] = useState(DEFAULT_API);
	const [saving, setSaving] = useState(false);

	const hasKey = apiKey.trim() !== "";
	const canCreate =
		id.trim() !== "" &&
		baseUrl.trim() !== "" &&
		!saving &&
		(!hasKey || limitConfirmed);

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
			setLimitConfirmed(false);
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
					{hasKey ? (
						<SpendLimitConfirm
							checked={limitConfirmed}
							id="custom-key-limit"
							onCheckedChange={setLimitConfirmed}
							providerId={id.trim()}
							providerLabel="this provider"
						/>
					) : null}
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

export function LlmProvidersSettings({
	canSetGatewayAccount = true,
}: {
	canSetGatewayAccount?: boolean;
} = {}) {
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
		switchAccount,
		removeAccount,
		renameAccount,
		reload,
	} = useLlmProviders();
	const { wallet: creditWallet } = useCreditsWallet();
	const hasPrepaidManagedBalance =
		unrestrictedCreditBalanceMicroUsd(creditWallet) > 0;

	if (loading) {
		return <SkeletonRows label="Loading providers…" spacing="comfortable" />;
	}

	if (error) {
		return (
			<div className="rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm text-status-destructive">
				<p>Failed to load providers: {error}</p>
				<Button
					className="mt-3"
					onClick={reload}
					size="sm"
					type="button"
					variant="outline"
				>
					Retry
				</Button>
			</div>
		);
	}

	const cat: PiCatalog = catalog ?? {
		apiTypes: [DEFAULT_API],
		providers: [],
		thinkingLevels: [],
	};
	const ordered = orderProviders(cat.providers);
	const managedProviders = ordered.filter(
		(provider) => provider.managed || provider.authKind === "none"
	);
	const oauthProviders = ordered.filter(
		(provider) => !provider.managed && supportsOAuth(provider)
	);
	const apiKeyProviders = ordered.filter(
		(provider) => provider.authKind === "api-key" && !supportsOAuth(provider)
	);

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

	const handleToggleModel = async (
		provider: string,
		model: string,
		enabled: boolean
	): Promise<void> => {
		await toggleModelEnabled(provider, model, enabled);
	};

	const handleRemove = async (provider: string): Promise<void> => {
		await remove(provider);
	};

	const handleCreateCustom = async (input: {
		api: string;
		apiKey: string | null;
		baseUrl: string;
		provider: string;
	}) => {
		await configure(input);
	};

	const renderProviderCards = (providers: PiProvider[]) =>
		providers.map((provider) => (
			<ProviderCard
				activeConfig={config}
				canSetGatewayAccount={canSetGatewayAccount}
				check={check}
				discover={discover}
				hasPrepaidManagedBalance={hasPrepaidManagedBalance}
				key={provider.id}
				onActivate={handleActivate}
				onConfigure={handleConfigure}
				onReload={reload}
				onRemove={handleRemove}
				onRemoveAccount={async (providerId, accountId) => {
					return await removeAccount(providerId, accountId);
				}}
				onRenameAccount={async (providerId, accountId, label) => {
					await renameAccount(providerId, accountId, label);
				}}
				onSwitchAccount={async (providerId, accountId, target) => {
					await switchAccount(providerId, accountId, target);
				}}
				onToggleModel={handleToggleModel}
				provider={provider}
				thinkingLevels={cat.thinkingLevels}
			/>
		));

	return (
		<div className="space-y-6">
			<OrgBillingContext
				compact
				description="Ryu managed inference uses this organization's shared credits; BYOK providers use keys stored on this node."
				label="Managed provider billing"
			/>
			<SettingsSection
				caption="The providers that answer chat. Configure any number, then pick one to power the Ryu agent. Managed inference spends the organization wallet shown above; BYOK providers spend the provider account behind the key stored on this node. The Gateway toggle governs egress independently."
				title="Chat"
			>
				<div className="space-y-5">
					<section
						aria-labelledby="managed-provider-heading"
						className="space-y-2.5"
					>
						<h3 className="font-medium text-sm" id="managed-provider-heading">
							Ryu managed
						</h3>
						{renderProviderCards(managedProviders)}
					</section>
					<section
						aria-labelledby="oauth-provider-heading"
						className="space-y-2.5"
					>
						<h3 className="font-medium text-sm" id="oauth-provider-heading">
							OAuth accounts
						</h3>
						<p className="text-muted-foreground text-xs">
							Sign in and keep multiple accounts for each provider. OpenRouter
							and xAI also accept API keys.
						</p>
						{renderProviderCards(oauthProviders)}
					</section>
					<section
						aria-labelledby="api-key-provider-heading"
						className="space-y-2.5"
					>
						<h3 className="font-medium text-sm" id="api-key-provider-heading">
							API keys
						</h3>
						<ProviderKeySafetyNotice storage="vault" />
						{renderProviderCards(apiKeyProviders)}
					</section>
				</div>
			</SettingsSection>

			<AgentModelsSettings
				agentModelOverrides={cat.agentModelOverrides}
				onToggleModel={handleToggleModel}
			/>

			<ModelParametersSettings />

			<SettingsSection
				caption="Point Ryu at any OpenAI-compatible endpoint: a local llama.cpp / Ollama / vLLM server, or a hosted gateway. It joins the list above and can be activated like any built-in provider."
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
