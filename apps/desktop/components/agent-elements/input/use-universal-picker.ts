"use client";

// Builds the universal picker's body data (Ryu — with its providers nested
// under it — plus external agents) and hands `useComposerAgentControls` a
// `renderBody` it can pass to `ComposerSettingsMenu`. This hook owns the extra
// data the legacy sibling-section picker never needed:
//   - Pi provider catalog + active config (`usePiConfig`) → the Providers section,
//     with per-provider `configured` gating and the active route highlighted.
//   - The installable agents catalog (`useAgentsCatalog`) → the not-installed
//     external agents rendered greyed with an Install button.
//   - The Gateway dialog opener (`useGatewayDialog`) → the "Configure credentials"
//     link target for an unconfigured provider.
//   - The credit-pool catalog + the user's grants (`@ryu/auth/lib/credit-pools`,
//     `useCreditGrants`) → the pool-backed managed rows ("Ryu Fast", "Ryu
//     Frontier"), which are the SAME provider row shape with a pool-owned name,
//     their own model discovery, and a pool-aware upsell rule.
//
// The active agent's LIVE model/approval/thinking sections are passed in (they
// wire to the host's live handlers) and nested under whichever row is active, so
// changing the current target's model still updates the running turn. Non-active
// external agents are probed lazily inside the body (see `ExternalAgentSettings`).

import {
	ALL_CREDIT_POOLS,
	type CreditPool,
	type CreditPoolId,
} from "@ryu/auth/lib/credit-pools";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
	createElement,
	type ReactNode,
	useCallback,
	useMemo,
	useState,
} from "react";
import { sileo } from "sileo";
import type { ComposerSettingsSection } from "@/components/agent-elements/input/composer-settings-menu.tsx";
import { isChatModelStem } from "@/components/agent-elements/input/model-groups.ts";
import { modelMenuItem } from "@/components/agent-elements/input/model-router.ts";
import {
	type ProviderEntry,
	type TeamEntry,
	UniversalPickerBody,
	type UniversalPickerData,
} from "@/components/agent-elements/input/universal-picker-body.tsx";
import { useEntitlementContext } from "@/src/contexts/entitlement-context.tsx";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import { useAgentsCatalog } from "@/src/hooks/useAgentsCatalog.ts";
import { useCreditGrants } from "@/src/hooks/useCreditGrants.ts";
import { useCanManagePermission } from "@/src/hooks/useGatewayConfigurable.ts";
import { usePiConfig } from "@/src/hooks/usePiConfig.ts";
import { engineForAgent } from "@/src/lib/agent-logos.tsx";
import {
	type AgentSummary,
	removeAgentAccount,
	switchAgentAccount,
} from "@/src/lib/api/agents.ts";
import { toTarget } from "@/src/lib/api/client.ts";
import {
	getActiveModel,
	listInstalledModels,
	setActiveModel,
} from "@/src/lib/api/models.ts";
import {
	filterEnabledModels,
	gatewayProviderSlug,
	type PiCatalog,
	type PiProvider,
	removeProviderAccount,
	switchProviderAccount,
} from "@/src/lib/api/pi-config.ts";
import type { Team } from "@/src/lib/api/teams.ts";
import {
	type BrowserSurface,
	browserProviderHost,
	useBrowserProviderSnapshot,
} from "@/src/lib/extension-host.ts";
import {
	getRecents,
	type PickerRef,
	parseRefKey,
	removeRecent,
} from "@/src/lib/picker-favorites.ts";
import { useGatewayDialog } from "@/src/store/useGatewayDialog.ts";

/** The flagship agent id (mirrors Core `DEFAULT_AGENT_ID`). */
const RYU_AGENT_ID = "ryu";

/**
 * The synthetic "Local" row's id, and the REAL Pi provider it routes through.
 *
 * There is no `local` provider in Core's `PROVIDERS` table and there should not
 * be: talking to weights on this machine is not a credential-bearing vendor, it
 * is the governed `gateway` route pointed at whichever model the local engine is
 * currently serving. So the row is assembled here from the two endpoints that
 * already own that state — `/api/models/installed` (what is on disk) and
 * `/api/models/active` (what is loaded) — and a pick writes BOTH halves: the
 * served model (`setActiveModel`) and the Pi route (`provider: "gateway"`).
 * Writing only one is the failure mode `RyuPiConfig` already guards against —
 * a config naming a model the engine never loaded.
 */
const LOCAL_PROVIDER_ID = "local";
const GATEWAY_PROVIDER_ID = "gateway";
const BROWSER_PROVIDER_ID = "browser";

/** Map a Pi provider id to the engine key its brand logo is registered under. */
const PROVIDER_ENGINE_KEY: Record<string, string> = {
	google: "gemini",
	"claude-pro-max": "claude",
	"openai-codex": "codex",
	anthropic: "anthropic",
	openai: "openai",
	mistral: "mistral",
	openrouter: "openrouter",
};

function providerEngineKey(providerId: string): string {
	return PROVIDER_ENGINE_KEY[providerId] ?? providerId;
}

/**
 * The credit pools a user may be offered as a route ("Ryu Fast", "Ryu Frontier"),
 * straight from the pool catalog. Filtering on `visible` here is the whole point:
 * adding, hiding or renaming a pool is then a data change in
 * `@ryu/auth/lib/credit-pools`, never an edit to this picker. It also
 * deliberately excludes the pass-through `openrouter` pool, which is invisible —
 * that supply is what the ORIGINAL managed Ryu row already sells, and offering it
 * twice under two names would be the same route pretending to be a choice.
 */
const OFFERED_CREDIT_POOLS: readonly CreditPool[] = ALL_CREDIT_POOLS.filter(
	(pool) => pool.visible
);

/**
 * The pool a managed catalog row is backed by, or null for a row that is not
 * pool-backed (today: the default managed OpenRouter route, and every BYO-key
 * provider).
 *
 * `managed` is a REQUIRED part of the match, not an accelerator. A user's own
 * Bedrock or Cloudflare credential is a perfectly ordinary BYO-key provider whose
 * id collides with a pool's `gatewayProviders` entry; treating that as Ryu's
 * donated supply would relabel the user's own account "Ryu Frontier" and gate it
 * behind our subscription upsell.
 *
 * Three id spellings are accepted because Core owns the provider id and this
 * surface does not: whichever of `bedrock` / `managed-bedrock` Core publishes,
 * the row binds. A row that matches nothing keeps today's behaviour exactly.
 */
function creditPoolForProvider(provider: PiProvider): CreditPool | null {
	if (!provider.managed) {
		return null;
	}
	return (
		OFFERED_CREDIT_POOLS.find(
			(pool) =>
				provider.id === pool.id ||
				provider.id === `managed-${pool.id}` ||
				pool.gatewayProviders.includes(provider.id)
		) ?? null
	);
}

/**
 * Upsell copy for a pool row. Names the TIER and nothing else — the pool catalog's
 * standing rule is that a user never reads the name of the provider behind a pool,
 * so the supplier can be swapped without changing what anyone was promised.
 * There is no bring-your-own-key half: Ryu's pooled capacity is not something a
 * user can hold a key for, so offering one would be a dead end.
 */
function poolUpsellCopy(pool: CreditPool): { byoKey: null; upgrade: string } {
	return {
		upgrade: `${pool.label} runs on Ryu's own capacity — included with a Ryu subscription, no API keys.`,
		byoKey: null,
	};
}

export interface UseUniversalPickerParams {
	/** The active agent's live approval + thinking sections. */
	activeExtraSections: ComposerSettingsSection[];
	/** The active agent's live model section (already resolved by the host). */
	activeModelSection: ComposerSettingsSection | null;
	agentId: string | null;
	agents: AgentSummary[];
	/** Keep model rows visible for setup surfaces at every interface level. */
	forceModelPicker?: boolean;
	onCreateAgent?: () => void;
	onSelectAgent: (id: string) => void;
	/** Optional host override for a concrete provider/model pick. */
	onSelectProviderModel?: (providerId: string, modelId: string) => void;
	/** Optional host override for a provider thinking-level pick. */
	onSelectProviderThinking?: (providerId: string, level: string) => void;
	onSelectTeam?: (id: string) => void;
	/** Optional host override for provider picks (used by setup surfaces). */
	onUseProvider?: (providerId: string, modelId: string | null) => void;
	/** Browser-only surface used for the synthetic Browser provider selection. */
	surface?: BrowserSurface;
	teamId?: string | null;
	teams?: Team[];
}

export interface UseUniversalPickerResult {
	/** Body renderer for `ComposerSettingsMenu`'s `renderBody` prop. */
	renderBody: (
		close: () => void,
		mode?: "agents" | "models" | "all"
	) => ReactNode;
}

export function useUniversalPicker(
	params: UseUniversalPickerParams
): UseUniversalPickerResult {
	const {
		agents,
		agentId,
		teamId = null,
		teams = [],
		onSelectAgent,
		onSelectTeam,
		onCreateAgent,
		onUseProvider,
		onSelectProviderModel,
		onSelectProviderThinking,
		activeModelSection,
		activeExtraSections,
		forceModelPicker = false,
		surface = "dashboard",
	} = params;
	const browserSnapshot = useBrowserProviderSnapshot();
	const [recentRevision, setRecentRevision] = useState(0);
	const recentRefs = useMemo<PickerRef[]>(
		() =>
			getRecents()
				.map(parseRefKey)
				.filter((ref): ref is PickerRef => ref !== null),
		[recentRevision]
	);

	const { config, catalog, save } = usePiConfig();
	const catalogAgents = useAgentsCatalog();
	const openGateway = useGatewayDialog((s) => s.openGateway);
	const canSetGatewayAccount = useCanManagePermission("gateway.configure");
	const { verdict, requestUpgrade } = useEntitlementContext();
	// True only with an active PAID managed plan. The managed provider is always
	// `configured` server-side (wallet-gated at the Gateway), so the composer upsell
	// gates on the entitlement here, not on `configured`. `verdict` is null until the
	// first resolution; treat unresolved as "no plan" (shows the upsell, flips when ready).
	const hasManagedPlan = verdict?.managedInference ?? false;
	// Pools the user holds granted credit in. A campaign grant is the OTHER way a
	// pool row becomes usable without a paid plan, and it is the whole point of the
	// frontier ladder: someone handed $50 of "Ryu Frontier" must be shown that
	// pool's models, not an ad for the subscription that money already substitutes
	// for. Empty whenever grants are unavailable, which degrades to the plan-only
	// rule this picker used before pools existed.
	const { pools: grantPools } = useCreditGrants();
	// Rows whose label this build cannot map back to a catalog id are skipped: the
	// upsell rule is a per-pool decision, and a null id names no pool. Skipping
	// keeps the pre-grant behaviour (the row still upsells) instead of suppressing
	// the upsell on some other pool's money.
	const grantedPoolIds = useMemo(
		() =>
			new Set(
				grantPools
					.map((pool) => pool.poolId)
					.filter((poolId): poolId is CreditPoolId => poolId !== null)
			),
		[grantPools]
	);
	// The same grants keyed for DISPLAY: pool id → the dollars left in it and when
	// they lapse. `useCreditGrants` already drops non-positive pools, so a present
	// entry always has money in it and the badge never renders "$0.00".
	const grantByPoolId = useMemo(() => {
		const index = new Map<
			CreditPoolId,
			{ expiresAt: string | null; remainingMicroUsd: number }
		>();
		for (const pool of grantPools) {
			if (pool.poolId !== null) {
				index.set(pool.poolId, {
					remainingMicroUsd: pool.remainingMicroUsd,
					expiresAt: pool.expiresAt,
				});
			}
		}
		return index;
	}, [grantPools]);

	const piProviders = useMemo(() => catalog?.providers ?? [], [catalog]);
	const thinkingLevels = useMemo(
		() => catalog?.thinkingLevels ?? [],
		[catalog]
	);

	// The provider rows shown in the picker: every Pi provider except the bare
	// `gateway` pseudo-provider (that IS the Ryu portal local/gateway route). The
	// managed `managed-openrouter` provider IS shown here — as the subscription upsell
	// row when unsubscribed, or the full OpenRouter model list when subscribed.
	//
	// Managed rows are hoisted to the front by a STABLE partition. This is a no-op
	// today (Core's table already leads with the one managed provider) and exists so
	// the pool-backed managed rows land next to it whenever Core publishes them,
	// rather than wherever they happen to fall in the table — they are variants of
	// the same "included with Ryu" route and read as one group.
	const shownProviders = useMemo(() => {
		const visible = piProviders.filter((p) => p.id !== "gateway");
		return [
			...visible.filter((p) => p.managed),
			...visible.filter((p) => !p.managed),
		];
	}, [piProviders]);

	// What the local engine can serve, and what it is serving right now. Both keys
	// are the ones `use-composer-acp-sections` and `RyuPiConfig` already use, so
	// the three surfaces share one cache entry and cannot disagree about what is
	// installed. Unlike those callers this is not gated on the active agent: the
	// Local ROW is a route of the Ryu agent, offered whichever agent is selected.
	const node = useActiveNode();
	const queryClient = useQueryClient();
	const installedQuery = useQuery({
		queryKey: ["models", "installed", node.url],
		queryFn: () =>
			listInstalledModels({
				url: node.url,
				token: node.token,
				userJwt: node.userJwt ?? null,
			}),
		staleTime: 60_000,
	});
	const activeModelQuery = useQuery({
		queryKey: ["models", "active", node.url],
		queryFn: () =>
			getActiveModel({
				url: node.url,
				token: node.token,
				userJwt: node.userJwt ?? null,
			}),
		staleTime: 30_000,
	});
	// Chat-capable weights only — the inventory also carries the embedder and the
	// STT/TTS/rerank support models Core installs on its own, none of which can
	// serve a turn (see `isChatModelStem`).
	const localStems = useMemo(
		() =>
			(installedQuery.data ?? [])
				.map((m) => m.stem)
				.filter((stem) => stem !== "" && isChatModelStem(stem)),
		[installedQuery.data]
	);
	const servedStem = activeModelQuery.data?.active ?? null;

	const isRyuActive = agentId === RYU_AGENT_ID;
	// A provider row is the active target when the Ryu agent's Pi config routes to a
	// provider we show; otherwise (gateway / local) the Ryu portal route is active.
	const activeProviderId =
		isRyuActive &&
		config &&
		shownProviders.some((p) => p.id === config.provider)
			? config.provider
			: null;
	// The Local row is active when Ryu routes through the gateway AND the model it
	// names is one of the installed local weights. The gateway also fronts remote
	// supply, so the route alone does not mean "local" — the model is what decides.
	const localActive =
		isRyuActive &&
		config?.provider === GATEWAY_PROVIDER_ID &&
		Boolean(config.model) &&
		localStems.includes(config.model ?? "");
	// The bare Ryu-portal row keeps the route only when no more specific row owns
	// it, so Local and the portal never both read as the active target.
	const ryuActive = isRyuActive && activeProviderId === null && !localActive;

	const saveProvider = useCallback(
		(
			providerId: string,
			model: string | null,
			thinkingLevel: string | null
		) => {
			onSelectAgent(RYU_AGENT_ID);
			save({
				provider: providerId,
				model,
				thinkingLevel: thinkingLevel ?? config?.thinkingLevel ?? null,
			}).catch(() => {
				// A failed save leaves the previous config in place; the query
				// invalidation the mutation triggers re-reads ground truth.
			});
		},
		[onSelectAgent, save, config]
	);

	/**
	 * Point the local engine at `stem` and route Ryu's gateway at it. Both writes
	 * are needed and the order matters: making the weights resident first means a
	 * refusal (an engine this node cannot run, a stem that vanished off disk)
	 * leaves the Pi config untouched rather than naming a model nothing serves.
	 * Core owns that verdict — the client does not pre-judge runnability — so the
	 * rejection is surfaced as its own message.
	 */
	const switchToLocalModel = useCallback(
		(stem: string, thinkingLevel: string | null) => {
			setActiveModel(
				{ url: node.url, token: node.token, userJwt: node.userJwt ?? null },
				stem
			)
				.then((res) => {
					queryClient
						.invalidateQueries({ queryKey: ["models", "active", node.url] })
						.catch(() => undefined);
					saveProvider(GATEWAY_PROVIDER_ID, res.active || stem, thinkingLevel);
				})
				.catch((e: unknown) => {
					sileo.error({
						title: e instanceof Error ? e.message : "Could not switch model",
					});
				});
		},
		[node.url, node.token, queryClient, saveProvider]
	);

	// Account switch/remove routes return the refreshed catalog; fold it straight
	// into the cache so `configured`/`accounts` flip without a round trip.
	const applyCatalog = useCallback(
		(catalog: PiCatalog) => {
			queryClient.setQueryData(["pi-config-catalog", node.url], catalog);
		},
		[queryClient, node.url]
	);

	const renderBody = useCallback(
		(
			close: () => void,
			mode: "agents" | "models" | "all" = "all"
		): ReactNode => {
			const ryuAgent =
				agents.find((a) => a.id === RYU_AGENT_ID) ??
				agents.find((a) => a.recommended) ??
				null;

			const installedExternal = agents.filter(
				(a) => a.transport === "acp" && a.id !== ryuAgent?.id && !a.recommended
			);

			const availableExternal = catalogAgents.agents.filter(
				(e) => !e.added && e.id !== ryuAgent?.id
			);

			const providers: ProviderEntry[] = shownProviders.map((p) => {
				const isActive = activeProviderId === p.id;
				const pool = creditPoolForProvider(p);
				return {
					id: p.id,
					// For a pool-backed row the pool catalog owns the name, not Core:
					// `label` is defined there as the one string a user ever reads for a
					// pool, so the tier stays consistent wherever it is rendered and the
					// supplier behind it stays invisible.
					label: pool ? pool.label : p.label,
					engineKey: providerEngineKey(p.id),
					authKind: p.authKind,
					managed: Boolean(p.managed),
					supportsDiscovery: p.supportsDiscovery !== false,
					gatewayAccountSupported:
						p.authKind === "api-key" && gatewayProviderSlug(p.id) !== null,
					// Every account the provider holds in the sealed vault (labels
					// only). Renders the submenu's switchable Account section.
					accounts: p.accounts ?? [],
					// Only the default managed row borrows OpenRouter's catalog (it has no
					// model list of its own and routes there). A pool row enumerates under
					// its OWN id or not at all — inheriting OpenRouter's list would have it
					// advertise models its pool cannot serve.
					discoveryProviderId:
						p.managed && pool === null ? "openrouter" : undefined,
					// A managed row is always `configured` server-side (it is wallet-gated
					// at the Gateway), so the upsell is gated on entitlement, not on
					// `configured`. A pool row adds two escapes: the free-reach pool is the
					// give-it-away tier and must never be upsold, and a user already
					// holding granted credit in this pool has already paid the toll.
					upsell: pool
						? !(
								hasManagedPlan ||
								pool.tier === "free" ||
								grantedPoolIds.has(pool.id)
							)
						: Boolean(p.managed) && !hasManagedPlan,
					upsellCopy: pool ? poolUpsellCopy(pool) : undefined,
					// The pool's own remaining granted credit, shown on the row as "$50.00"
					// so "how much Frontier is left?" is answerable where the choice is
					// made. Looked up by pool id, so a grant row this build can't map back
					// to the catalog contributes nothing rather than landing on the wrong
					// pool — the same rule `grantedPoolIds` applies to the upsell.
					poolGrant: pool ? grantByPoolId.get(pool.id) : undefined,
					// Pooled capacity is Ryu's own, so there is no credential for a user
					// to hold and a pool row is `configured` by definition — the wallet
					// (and the pool's grant balance) is what gates it, at the Gateway.
					// Forced rather than trusted because `configured` comes from Core,
					// where the managed check is still a single-id equality; a pool row
					// that arrived `false` would fall through to the unconfigured branch
					// and offer "Sign in with Ryu Frontier", which is a dead end.
					configured: pool ? true : p.configured,
					isActive,
					currentModel: isActive ? (config?.model ?? null) : null,
					currentThinking: isActive ? (config?.thinkingLevel ?? null) : null,
					modelOverrides: p.modelOverrides,
					// Models the user turned off in Settings are not offered here. The
					// row's own current model is exempt (see `filterEnabledModels`), and
					// the submenu applies the same rule to the live-discovered list.
					models: filterEnabledModels(
						p.suggestedModels.map((m) => modelMenuItem(m)),
						p.modelOverrides,
						isActive ? config?.model : null
					),
				};
			});

			// Browser is a synthetic provider owned by the extension adapter. It sits
			// beside Core-local and cloud routes in the same universal picker, but its
			// picks never call `saveProvider` or send an inference request to Core.
			if (browserSnapshot) {
				const browserModelId =
					browserSnapshot.currentModelBySurface[surface] ??
					browserSnapshot.models[0]?.id ??
					null;
				const browserModel = browserSnapshot.models.find(
					(model) => model.id === browserModelId
				);
				if (browserModel) {
					providers.unshift({
						id: BROWSER_PROVIDER_ID,
						label: "Browser",
						engineKey: "browser",
						authKind: "none",
						managed: false,
						supportsDiscovery: false,
						configured: true,
						upsell: false,
						isActive:
							browserSnapshot.activeAgentId === agentId &&
							browserSnapshot.activeSurface === surface,
						currentModel: browserModelId,
						currentThinking: null,
						status: browserModel.status,
						statusMessage: browserModel.statusMessage,
						browserCapabilities: browserModel.capabilities,
						models: browserSnapshot.models.map((model) => ({
							id: model.id,
							name: `${model.name} · ${
								model.status === "ready" ? "Ready" : model.status
							}`,
							description: model.capabilities.actionSupport
								? `Browser actions · ${model.status}`
								: `Chat-only · ${model.status}`,
						})),
					});
				}
			}

			// The Local route, offered as its own provider row so "run this on my
			// machine" is a first-class choice next to the vendors rather than a few
			// bare stems buried in Ryu's flat model list. Hidden entirely when no
			// chat-capable weights are installed — an empty row would be a dead end
			// with no in-place way to fill it (models are installed from the Store).
			// It leads the list: it is the one route that needs no account at all.
			if (localStems.length > 0) {
				providers.unshift({
					id: LOCAL_PROVIDER_ID,
					label: "Local",
					engineKey: LOCAL_PROVIDER_ID,
					// No credential exists to hold for weights on this disk, so the row is
					// configured by definition and never upsells.
					authKind: "none",
					managed: false,
					supportsDiscovery: false,
					configured: true,
					upsell: false,
					isActive: localActive,
					currentModel: localActive ? (config?.model ?? null) : null,
					currentThinking: localActive ? (config?.thinkingLevel ?? null) : null,
					// The served model is listed even when it is not a chat stem by name,
					// so a picker can always show what the engine actually has loaded.
					models: (servedStem && !localStems.includes(servedStem)
						? [servedStem, ...localStems]
						: localStems
					).map((stem) => ({ id: stem, name: stem })),
				});
			}

			const teamEntries: TeamEntry[] = teams.map((t) => ({
				id: t.id,
				name: t.name,
				isActive: teamId === t.id,
				engines: t.members.map((id) => {
					const member = agents.find((a) => a.id === id);
					return member ? engineForAgent(member) : null;
				}),
			}));

			const data: UniversalPickerData = {
				activeAgentId: agentId,
				agents,
				activeModelSection,
				activeExtraSections,
				forceModelPicker,
				ryuAgent,
				ryuActive,
				providers,
				installedExternal,
				availableExternal,
				installPendingId: catalogAgents.pendingId,
				canSetGatewayAccount,
				recentRefs,
				teams: teamEntries,
				thinkingLevels,
				onRemoveRecent: (ref) => {
					removeRecent(ref);
					setRecentRevision((revision) => revision + 1);
				},
				onSelectAgent: (id) => {
					onSelectAgent(id);
					setRecentRevision((revision) => revision + 1);
				},
				onSelectRecentModel: (providerId, modelId, effort) => {
					if (onSelectProviderModel) {
						onSelectProviderModel(providerId, modelId);
					} else if (providerId === LOCAL_PROVIDER_ID) {
						switchToLocalModel(modelId, null);
					} else {
						saveProvider(providerId, modelId, null);
					}
					if (effort && onSelectProviderThinking) {
						onSelectProviderThinking(providerId, effort);
					}
				},
				onSelectTeam: onSelectTeam ? (id) => onSelectTeam(id) : undefined,
				onCreateAgent,
				onInstallExternal: (id) => {
					catalogAgents.install(id).catch(() => {
						// Install errors surface via the catalog hook's error state.
					});
				},
				onConfigureCredentials: () => openGateway("providers"),
				onUpgrade: () => requestUpgrade(),
				// The Local row is not a Pi provider (see `LOCAL_PROVIDER_ID`): every
				// pick on it has to make the weights resident before writing the
				// route, so all three handlers fork to `switchToLocalModel` rather than
				// saving `provider: "local"`, which Core would reject.
				onUseProvider: (providerId) => {
					const p = providers.find((x) => x.id === providerId);
					const model = p?.currentModel ?? p?.models[0]?.id ?? null;
					if (onUseProvider) {
						onUseProvider(providerId, model);
						return;
					}
					if (providerId === BROWSER_PROVIDER_ID) {
						if (model) {
							browserProviderHost.selectModel(
								agentId ?? RYU_AGENT_ID,
								surface,
								model
							);
						}
						onSelectAgent(RYU_AGENT_ID);
						return;
					}
					if (providerId === LOCAL_PROVIDER_ID) {
						if (model) {
							switchToLocalModel(model, null);
						}
						return;
					}
					saveProvider(providerId, model, null);
				},
				onSelectProviderModel: (providerId, modelId) => {
					if (onSelectProviderModel) {
						onSelectProviderModel(providerId, modelId);
						return;
					}
					if (providerId === BROWSER_PROVIDER_ID) {
						browserProviderHost.selectModel(
							agentId ?? RYU_AGENT_ID,
							surface,
							modelId
						);
						onSelectAgent(RYU_AGENT_ID);
						return;
					}
					if (providerId === LOCAL_PROVIDER_ID) {
						switchToLocalModel(modelId, null);
						return;
					}
					saveProvider(providerId, modelId, null);
				},
				onSelectProviderThinking: (providerId, level) => {
					if (onSelectProviderThinking) {
						onSelectProviderThinking(providerId, level);
						return;
					}
					if (providerId === BROWSER_PROVIDER_ID) {
						void level;
						onSelectAgent(RYU_AGENT_ID);
						return;
					}
					const p = providers.find((x) => x.id === providerId);
					const model = p?.currentModel ?? p?.models[0]?.id ?? null;
					if (providerId === LOCAL_PROVIDER_ID) {
						if (model) {
							switchToLocalModel(model, level);
						}
						return;
					}
					saveProvider(providerId, model, level);
				},
				// ── Account switching (multi-account, sealed vault) ──
				//
				// Switch/remove fold the refreshed catalog straight into the cache
				// (the route returns it) so the picker's `configured`/`accounts`
				// state flips without a second round trip. Agent accounts live in a
				// separate query keyed by agent id, so those get invalidated instead.
				onSwitchProviderAccount: (
					providerId,
					accountId,
					accountTarget = "self"
				) => {
					switchProviderAccount(
						toTarget(node),
						providerId,
						accountId,
						accountTarget
					)
						.then(applyCatalog)
						.catch((error: unknown) => {
							sileo.error({
								title:
									error instanceof Error
										? error.message
										: "Could not switch account",
							});
						});
				},
				onRemoveProviderAccount: (providerId, accountId) => {
					removeProviderAccount(toTarget(node), providerId, accountId)
						.then(applyCatalog)
						.catch((error: unknown) => {
							sileo.error({
								title:
									error instanceof Error
										? error.message
										: "Could not remove account",
							});
						});
				},
				onSwitchAgentAccount: (agentId, accountId, provider) => {
					switchAgentAccount(toTarget(node), agentId, { accountId, provider })
						.then(() => {
							queryClient
								.invalidateQueries({
									queryKey: ["agent-accounts", node.url, agentId],
								})
								.catch(() => undefined);
						})
						.catch((error: unknown) => {
							sileo.error({
								title:
									error instanceof Error
										? error.message
										: "Could not switch account",
							});
						});
				},
				onRemoveAgentAccount: (agentId, accountId) => {
					removeAgentAccount(toTarget(node), agentId, accountId)
						.then(() => {
							queryClient
								.invalidateQueries({
									queryKey: ["agent-accounts", node.url, agentId],
								})
								.catch(() => undefined);
						})
						.catch((error: unknown) => {
							sileo.error({
								title:
									error instanceof Error
										? error.message
										: "Could not remove account",
							});
						});
				},
			};

			return createElement(UniversalPickerBody, { data, close, mode });
		},
		[
			agents,
			agentId,
			activeModelSection,
			activeExtraSections,
			forceModelPicker,
			browserSnapshot,
			ryuActive,
			activeProviderId,
			localActive,
			localStems,
			servedStem,
			switchToLocalModel,
			shownProviders,
			hasManagedPlan,
			grantedPoolIds,
			thinkingLevels,
			config,
			recentRefs,
			teams,
			teamId,
			catalogAgents,
			canSetGatewayAccount,
			onSelectAgent,
			onSelectTeam,
			onCreateAgent,
			onUseProvider,
			onSelectProviderModel,
			onSelectProviderThinking,
			openGateway,
			requestUpgrade,
			saveProvider,
			applyCatalog,
			surface,
		]
	);

	return { renderBody };
}
