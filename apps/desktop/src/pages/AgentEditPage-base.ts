import type { AgentBannerPreferenceStore } from "@ryu/blocks/desktop/agent-banner-dialog.tsx";
import type { SlotOption } from "@ryu/blocks/desktop/agent-edit.tsx";
import { getMarketplaceBackdrops } from "@ryu/ui/components/backdrop/marketplace-backdrops.ts";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useTabSelector } from "@/src/contexts/TabsContext.tsx";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import { useAgents } from "@/src/hooks/useAgents.ts";
import { usePluginContributions } from "@/src/hooks/usePluginContributions.ts";
import { agentEngineOptionId } from "@/src/lib/agent-engine.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import { listOutputStyles } from "@/src/lib/api/output-styles.ts";
import { getPreference, setPreference } from "@/src/lib/api/preferences.ts";
import { usePluginBackgrounds } from "@/src/lib/plugin-backgrounds.ts";
import { useProductMode, useProductModeStore } from "@/src/lib/product-mode.ts";
import { useWorkspaceStore } from "@/src/store/useWorkspaceStore.ts";
import { ACP_CUSTOM_ENGINE } from "./AgentEditPage-options.ts";

export type AgentEditBase = ReturnType<typeof useAgentEditBase>;

export function useAgentEditBase({
	agentIdProp,
	onClose,
}: {
	agentIdProp?: string;
	onClose?: () => void;
}) {
	const { agentId: routeAgentId } = useParams<{ agentId: string }>();
	const agentId = agentIdProp ?? routeAgentId;
	const navigate = useNavigate();
	const openTab = useTabSelector((state) => state.openTab);
	const openAgentsCatalog = useCallback(() => {
		openTab("/store/agents", { title: "Customize" });
	}, [openTab]);
	// Stable identity so the callbacks that close over it don't churn every render.
	const goBack = useCallback(() => {
		if (onClose) {
			onClose();
		} else {
			navigate("/library/agent");
		}
	}, [onClose, navigate]);
	const isNew = agentId === "new" || !agentId;
	const { agents, activeEngine, loading, create, reload, update } = useAgents();
	// Bot gets the essentials-only editor; Agent and OS get every tab.
	const productMode = useProductMode();
	const simpleEditor = productMode === "bot";
	const consoleAccess = useProductModeStore((state) => state.consoleAccess);

	const activeNode = useActiveNode();
	const projectCwd = useWorkspaceStore((state) => state.folder);
	const pluginContributions = usePluginContributions();
	const target: ApiTarget = useMemo(
		() => ({
			url: activeNode.url,
			token: activeNode.token,
			userJwt: activeNode.userJwt ?? null,
		}),
		[activeNode.url, activeNode.token, activeNode.userJwt]
	);
	// Each actual authority/agent transition gets a new opaque identity, including
	// A→B→A. Equivalent node snapshots retain the current unsaved draft.
	const recordScope = useMemo(() => ({}), [agentId, isNew, target]);
	const editorMounted = useRef(true);
	useEffect(() => {
		editorMounted.current = true;
		return () => {
			editorMounted.current = false;
		};
	}, []);
	const activeRecordScope = useRef(recordScope);
	activeRecordScope.current = recordScope;
	const loadedRecordScope = useRef<object | null>(null);
	const recordReadGeneration = useRef(0);
	const posturePendingScope = useRef<object | null>(null);
	const pluginBackgrounds = usePluginBackgrounds();
	const marketplaceWallpapers = useMemo(
		() => getMarketplaceBackdrops(pluginBackgrounds),
		[pluginBackgrounds]
	);
	const agentBannerPreferenceStore = useMemo<AgentBannerPreferenceStore>(
		() => ({
			get: (agentId) =>
				getPreference(
					target,
					`ryu.agent-banner.v1:${encodeURIComponent(agentId)}`
				),
			set: async (agentId, value) => {
				await setPreference(
					target,
					`ryu.agent-banner.v1:${encodeURIComponent(agentId)}`,
					value
				);
			},
		}),
		[target]
	);
	const personalityProfilesQuery = useQuery({
		queryKey: ["agent-personality-profiles", target.url, target.token],
		queryFn: () => listOutputStyles(target),
		staleTime: 30_000,
		retry: false,
	});
	const agentEditPanels = useMemo(
		() =>
			pluginContributions.agent_edit_panels.filter(
				(panel) => panel.type === "rules"
			),
		[pluginContributions.agent_edit_panels]
	);

	const installedAgentEngineOptions = useMemo(() => {
		const options: SlotOption[] = [];
		const seen = new Set<string>();
		for (const agent of agents) {
			const id = agentEngineOptionId(agent);
			if (!id || seen.has(id)) {
				continue;
			}
			seen.add(id);
			options.push({
				id,
				label:
					activeEngine?.active === id ? `${agent.name} (active)` : agent.name,
			});
		}
		return options;
	}, [agents, activeEngine]);
	const installedAgentEngineIds = useMemo(
		() => new Set(installedAgentEngineOptions.map((option) => option.id)),
		[installedAgentEngineOptions]
	);

	// Sentinel engine option that reveals a free-text command box so the user can
	// point this agent at ANY ACP-compatible binary/command (a binary-only
	// registry agent they installed — goose/cursor/opencode/… — a private/
	// in-house agent, or a future one). Saved as the `acp-exec:<command>` engine
	// Core runs as an ACP subprocess; all session controls + diff rendering apply.
	const engineOptions: SlotOption[] = useMemo(
		() => [
			...installedAgentEngineOptions,
			{ id: ACP_CUSTOM_ENGINE, label: "Run a custom agent command…" },
		],
		[installedAgentEngineOptions]
	);
	return {
		routeAgentId,
		agentId,
		navigate,
		openTab,
		openAgentsCatalog,
		goBack,
		isNew,
		agents,
		activeEngine,
		loading,
		create,
		reload,
		update,
		productMode,
		simpleEditor,
		consoleAccess,
		activeNode,
		projectCwd,
		pluginContributions,
		target,
		recordScope,
		editorMounted,
		activeRecordScope,
		loadedRecordScope,
		recordReadGeneration,
		posturePendingScope,
		pluginBackgrounds,
		marketplaceWallpapers,
		agentBannerPreferenceStore,
		personalityProfilesQuery,
		agentEditPanels,
		installedAgentEngineOptions,
		installedAgentEngineIds,
		engineOptions,
	};
}
