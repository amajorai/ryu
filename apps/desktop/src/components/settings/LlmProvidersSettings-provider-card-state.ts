import { useLiteralMessages } from "@ryu/i18n/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { sileo } from "sileo";
import { modelMenuItem } from "@/components/agent-elements/input/model-router.ts";
import { useProviderCommandNavigation } from "@/components/agent-elements/input/provider-command-dialog.tsx";
import { useEntitlementContext } from "@/src/contexts/entitlement-context.tsx";
import { useLlmProviders } from "@/src/hooks/useLlmProviders.ts";
import type {
	CheckProviderResult,
	DiscoveredModel,
	PiLoginEvent,
} from "@/src/lib/api/pi-config.ts";
import { providerAccountHandlers } from "./LlmProvidersSettings-provider-card-accounts.ts";
import {
	DIRECT,
	errMessage,
	GATEWAY,
	type ProviderCardProps,
	RETAIL_CREDIT_POOL,
	supportsOAuth,
} from "./LlmProvidersSettings-shared.ts";

/** A provider card's state and handlers, shared by its section components. */
export function useProviderCardState({
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
	const tl = useLiteralMessages();
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

	const { handleRemoveAccount, handleRenameAccount, handleSwitchAccount } =
		providerAccountHandlers({
			isChatgptPlan,
			onRemoveAccount,
			onRenameAccount,
			onSwitchAccount,
			provider,
			tl,
		});

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
			sileo.success({
				title: tl("{label} credential saved", { label: provider.label }),
			});
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
						? tl("{label} routes through the Gateway", {
								label: provider.label,
							})
						: tl("{label} egress is direct", { label: provider.label }),
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
			sileo.success({
				title: tl("Now using {label}", { label: provider.label }),
			});
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
			sileo.success({
				title: tl("{label} credential removed", { label: provider.label }),
			});
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
				description: tl("{saved} of {total} model settings saved. {error}", {
					saved: String(saved),
					total: String(modelIds.length),
					error: errMessage(e, "Core rejected the request."),
				}),
			});
		} finally {
			setTogglingModel(null);
		}
	};

	return {
		activateLabel,
		activating,
		activationIsCurrent,
		activeAccountId,
		allModelsEnabled,
		apiKey,
		canSetGatewayAccount,
		checkResult,
		checking,
		discovering,
		handleActivate,
		handleCheck,
		handleLogin,
		handleLoginSuccess,
		handleRemove,
		handleRemoveAccount,
		handleRenameAccount,
		handleSaveKey,
		handleSwitchAccount,
		handleToggleAllModels,
		handleToggleModel,
		handleToggleRouting,
		hasOAuthAccount,
		isActive,
		isChatgptPlan,
		isPoolBacked,
		isSubscription,
		limitConfirmed,
		loginChoice,
		loginOpen,
		model,
		modelOptions,
		needsKey,
		needsPrepaidBalance,
		oauthActive,
		oauthConnected,
		open,
		provider,
		removing,
		routing,
		runDiscovery,
		savingKey,
		setApiKey,
		setLimitConfirmed,
		setLoginChoice,
		setLoginOpen,
		setModel,
		setOpen,
		setThinkingLevel,
		setWelcomeOpen,
		source,
		thinkingLevel,
		thinkingLevels,
		togglingModel,
		welcomeOpen,
	};
}

export type ProviderCardState = ReturnType<typeof useProviderCardState>;
