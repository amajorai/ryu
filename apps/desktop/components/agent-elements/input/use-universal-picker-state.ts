import type { CreditPoolId } from "@ryu/auth/lib/credit-pools";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";
import { sileo } from "sileo";
import { totalFreeCredit } from "@/components/agent-elements/input/free-model-tag.ts";
import { isChatModelStem } from "@/components/agent-elements/input/model-groups.ts";
import { useEntitlementContext } from "@/src/contexts/entitlement-context.tsx";
import { useProviderQueryScope } from "@/src/hooks/provider-query-scope.ts";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import { useAgentsCatalog } from "@/src/hooks/useAgentsCatalog.ts";
import { useCreditGrants } from "@/src/hooks/useCreditGrants.ts";
import { useCanManagePermission } from "@/src/hooks/useGatewayConfigurable.ts";
import { usePiConfig } from "@/src/hooks/usePiConfig.ts";
import {
	getActiveModel,
	listInstalledModels,
	setActiveModel,
} from "@/src/lib/api/models.ts";
import type { PiCatalog } from "@/src/lib/api/pi-config.ts";
import { useBrowserProviderSnapshot } from "@/src/lib/extension-host.ts";
import {
	getRecents,
	type PickerRef,
	parseRefKey,
} from "@/src/lib/picker-favorites.ts";
import { useGatewayDialog } from "@/src/store/useGatewayDialog.ts";
import {
	GATEWAY_PROVIDER_ID,
	RYU_AGENT_ID,
} from "./use-universal-picker-helpers.ts";
import type { UseUniversalPickerBaseScope } from "./use-universal-picker-scope.ts";

export type UseUniversalPickerStateInput = UseUniversalPickerBaseScope;

/** Recents, the provider catalog and credit pools, the active route, and the save and switch actions. */
export function useUniversalPickerState({
	params,
}: UseUniversalPickerStateInput) {
	const {
		agents,
		agentId,
		teamId = null,
		teams = [],
		onSelectAgent,
		onSelectTeam,
		onCreateAgent,
		onUseProvider,
		onProviderModelSelection,
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

	// The user's FREE CREDIT — every grant summed, nearest expiry. Free credit is
	// spent automatically (first) on Ryu Router models Ryu serves from its own
	// supply, so it is one figure on the Ryu Router row, not a per-pool split.
	const freeCredit = useMemo(() => totalFreeCredit(grantPools), [grantPools]);

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
	const providerScope = useProviderQueryScope(node);
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
				.catch((e) => {
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
			providerScope.publishCatalog(catalog);
		},
		[providerScope]
	);
	return {
		agents,
		agentId,
		teamId,
		teams,
		onSelectAgent,
		onSelectTeam,
		onCreateAgent,
		onUseProvider,
		onProviderModelSelection,
		onSelectProviderModel,
		onSelectProviderThinking,
		activeModelSection,
		activeExtraSections,
		forceModelPicker,
		surface,
		browserSnapshot,
		setRecentRevision,
		recentRefs,
		config,
		catalogAgents,
		openGateway,
		canSetGatewayAccount,
		requestUpgrade,
		hasManagedPlan,
		grantedPoolIds,
		grantByPoolId,
		freeCredit,
		thinkingLevels,
		shownProviders,
		node,
		providerScope,
		queryClient,
		localStems,
		servedStem,
		activeProviderId,
		localActive,
		ryuActive,
		saveProvider,
		switchToLocalModel,
		applyCatalog,
	} as const;
}
