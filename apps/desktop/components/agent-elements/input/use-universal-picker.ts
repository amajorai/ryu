"use client";

import { useProviderQueryScope } from "@/src/hooks/provider-query-scope.ts";

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

import { useLiteralMessages } from "@ryu/i18n/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
	createElement,
	type ReactNode,
	useCallback,
	useMemo,
	useState,
} from "react";
import { sileo } from "sileo";
import { isChatModelStem } from "@/components/agent-elements/input/model-groups.ts";
import {
	type TeamEntry,
	UniversalPickerBody,
	type UniversalPickerData,
} from "@/components/agent-elements/input/universal-picker-body.tsx";
import { buildAccountHandlers } from "@/components/agent-elements/input/use-universal-picker-account-handlers.ts";
import { useUniversalPickerGrants } from "@/components/agent-elements/input/use-universal-picker-grants.ts";
import {
	BROWSER_PROVIDER_ID,
	buildProviderEntries,
	GATEWAY_PROVIDER_ID,
	LOCAL_PROVIDER_ID,
	RYU_AGENT_ID,
} from "@/components/agent-elements/input/use-universal-picker-providers.ts";
import type {
	UseUniversalPickerParams,
	UseUniversalPickerResult,
} from "@/components/agent-elements/input/use-universal-picker-types.ts";
import { useEntitlementContext } from "@/src/contexts/entitlement-context.tsx";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import { useAgentsCatalog } from "@/src/hooks/useAgentsCatalog.ts";
import { useCanManagePermission } from "@/src/hooks/useGatewayConfigurable.ts";
import { usePiConfig } from "@/src/hooks/usePiConfig.ts";
import { engineForAgent } from "@/src/lib/agent-logos.tsx";
import {
	getActiveModel,
	listInstalledModels,
	setActiveModel,
} from "@/src/lib/api/models.ts";
import type { PiCatalog } from "@/src/lib/api/pi-config.ts";
import {
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

export type { UseUniversalPickerParams, UseUniversalPickerResult };

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
		onProviderModelSelection,
		onSelectProviderModel,
		onSelectProviderThinking,
		activeModelSection,
		activeExtraSections,
		forceModelPicker = false,
		surface = "dashboard",
	} = params;
	const tl = useLiteralMessages();
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
	const { freeCredit, grantByPoolId, grantedPoolIds } =
		useUniversalPickerGrants();

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

			const providers = buildProviderEntries({
				activeProviderId,
				agentId,
				browserSnapshot,
				config,
				freeCredit,
				grantByPoolId,
				grantedPoolIds,
				hasManagedPlan,
				localActive,
				localStems,
				servedStem,
				shownProviders,
				surface,
				tl,
			});

			const teamEntries: TeamEntry[] = teams.map((t) => ({
				id: t.id,
				name: t.name,
				isActive: teamId === t.id,
				engines: t.members.map((id) => {
					const member = agents.find((a) => a.id === id);
					return member ? engineForAgent(member) : null;
				}),
			}));

			const notifyProviderModelSelection = (
				providerId: string,
				modelId: string | null
			) => {
				const provider = providers.find((item) => item.id === providerId);
				onProviderModelSelection?.({
					modelId,
					providerId,
					providerLabel: provider?.label ?? providerId,
				});
			};
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
					notifyProviderModelSelection(providerId, modelId);
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
						notifyProviderModelSelection(providerId, model);
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
						notifyProviderModelSelection(providerId, model);
						return;
					}
					if (providerId === LOCAL_PROVIDER_ID) {
						if (model) {
							switchToLocalModel(model, null);
						}
						notifyProviderModelSelection(providerId, model);
						return;
					}
					saveProvider(providerId, model, null);
					notifyProviderModelSelection(providerId, model);
				},
				onSelectProviderModel: (providerId, modelId) => {
					if (onSelectProviderModel) {
						onSelectProviderModel(providerId, modelId);
						notifyProviderModelSelection(providerId, modelId);
						return;
					}
					if (providerId === BROWSER_PROVIDER_ID) {
						browserProviderHost.selectModel(
							agentId ?? RYU_AGENT_ID,
							surface,
							modelId
						);
						onSelectAgent(RYU_AGENT_ID);
						notifyProviderModelSelection(providerId, modelId);
						return;
					}
					if (providerId === LOCAL_PROVIDER_ID) {
						switchToLocalModel(modelId, null);
						notifyProviderModelSelection(providerId, modelId);
						return;
					}
					saveProvider(providerId, modelId, null);
					notifyProviderModelSelection(providerId, modelId);
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
				...buildAccountHandlers({
					applyCatalog,
					node,
					providerScope,
					queryClient,
				}),
			};

			return createElement(UniversalPickerBody, { data, close, mode });
		},
		[
			providerScope,
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
			freeCredit,
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
			onProviderModelSelection,
			onSelectProviderModel,
			onSelectProviderThinking,
			openGateway,
			requestUpgrade,
			saveProvider,
			applyCatalog,
			surface,
			tl,
		]
	);

	return { renderBody };
}
