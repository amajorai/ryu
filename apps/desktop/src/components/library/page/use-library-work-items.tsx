import {
	DeliverySecure01Icon,
	Target01Icon,
	WorkflowCircle06Icon,
} from "@hugeicons/core-free-icons";
import { formatCount } from "@ryu/ui/lib/number-format.ts";
import { useCallback, useMemo } from "react";
import { SECTION_ICONS } from "@/src/components/layout/sidebar-sections.ts";
import { useChatHistoryContext } from "@/src/contexts/ChatHistoryContext.tsx";
import { useSpacesContext } from "@/src/contexts/SpacesContext.tsx";
import { useAgents } from "@/src/hooks/useAgents.ts";
import { useCanManagePermission } from "@/src/hooks/useGatewayConfigurable.ts";
import { useWorkflows } from "@/src/hooks/useWorkflows.ts";
import { normalizeTimestamp, stampRecent } from "@/src/lib/library.ts";
import { WorkflowFlowStrip } from "@/src/lib/workflow-triggers.tsx";
import { type LibraryItem, mutationResult } from "./library-sections.ts";
import type { LibraryTabsValue } from "./library-tabs.ts";

/** Agents, workflows, chats and spaces, normalised into `LibraryItem`s. Each
 *  collection's mutation handles are destructured beside its list because the
 *  card's right-click menu offers rename/delete inline. */
export function useLibraryWorkItems(openTab: LibraryTabsValue["openTab"]) {
	const {
		agents,
		engines,
		loading: agentsLoading,
		remove: removeAgent,
	} = useAgents();
	const {
		workflows,
		loading: workflowsLoading,
		remove: removeWorkflow,
	} = useWorkflows();
	const {
		spaces,
		loading: spacesLoading,
		create: createSpace,
		remove: removeSpace,
	} = useSpacesContext();
	const {
		conversations,
		conversationsLoading,
		deleteConversation,
		renameConversation,
	} = useChatHistoryContext();
	const canDeleteAgents = useCanManagePermission("agent.delete");
	const canDeleteSpaces = useCanManagePermission("space.delete");

	const engineLabel = useCallback(
		(engine: string | null): string | null => {
			if (!engine) {
				return null;
			}
			const match = engines.find(
				(e) => e.id === engine || e.id.endsWith(`:${engine}`)
			);
			return match?.name ?? engine;
		},
		[engines]
	);

	const agentItems = useMemo<LibraryItem[]>(
		() =>
			agents.map((a) => ({
				type: "agent",
				id: a.id,
				name: a.name,
				subtitle: engineLabel(a.engine) ?? a.description,
				badge: null,
				// A glyph, not the word: on the mixed tabs `badge` is already spoken
				// for by the type label, and "Built-in" spelled out down a column of
				// agent rows was the noisiest thing on the page.
				status: a.builtIn ? ("builtin" as const) : null,
				icon: Target01Icon,
				updatedAt: normalizeTimestamp(a.createdAt),
				// openTab stamps recents from the route; no explicit stamp needed.
				open: () => openTab(`/agents/${a.id}/edit`, { title: a.name }),
				openInNewTab: () =>
					openTab(`/agents/${a.id}/edit`, { title: a.name, forceNew: true }),
				// No rename row: the agent hook's `update` takes a whole `AgentInput`,
				// and the editor this card opens is where a name is changed.
				remove: () => {
					return Promise.resolve(removeAgent(a.id)).then(mutationResult);
				},
				removeBlockedReason: a.builtIn
					? "Built-in agents ship with Ryu and can't be deleted."
					: canDeleteAgents
						? undefined
						: "Only organization admins can delete agents.",
			})),
		// engines feed engineLabel; rebuild when either changes.
		[agents, canDeleteAgents, engineLabel, openTab, removeAgent]
	);

	const workflowItems = useMemo<LibraryItem[]>(
		() =>
			workflows.map((w) => ({
				type: "workflow",
				id: w.id,
				name: w.name,
				subtitle:
					w.description ??
					`${formatCount(w.nodes.length) ?? "—"} ${w.nodes.length === 1 ? "node" : "nodes"}`,
				badge: null,
				icon: WorkflowCircle06Icon,
				updatedAt: normalizeTimestamp(w.updatedAt ?? w.createdAt),
				open: () => openTab(`/workflows/${w.id}`, { title: w.name }),
				openInNewTab: () =>
					openTab(`/workflows/${w.id}`, { title: w.name, forceNew: true }),
				preview: (
					<WorkflowFlowStrip
						edges={w.edges}
						nodes={w.nodes}
						triggers={w.triggers}
					/>
				),
				remove: () => {
					return Promise.resolve(removeWorkflow(w.id)).then(mutationResult);
				},
			})),
		[workflows, openTab, removeWorkflow]
	);

	const chatItems = useMemo<LibraryItem[]>(
		() =>
			conversations.map((c) => ({
				type: "chat",
				id: c.id,
				name: c.title || "Untitled chat",
				subtitle: c.folderPath ?? null,
				badge: c.archived ? "Archived" : null,
				icon: SECTION_ICONS.chats,
				updatedAt: normalizeTimestamp(c.updatedAt ?? c.createdAt),
				open: () => openTab("/chat", { conversationId: c.id }),
				openInNewTab: () =>
					openTab("/chat", { conversationId: c.id, forceNew: true }),
				rename: (title: string) => {
					return Promise.resolve(renameConversation(c.id, title)).then(
						mutationResult
					);
				},
				remove: () => {
					return Promise.resolve(deleteConversation(c.id)).then(mutationResult);
				},
			})),
		[conversations, openTab, renameConversation, deleteConversation]
	);

	const spaceItems = useMemo<LibraryItem[]>(
		() =>
			spaces
				// Hide the auto-created Meetings space (surfaced under Meetings).
				.filter((s) => s.name !== "Meetings")
				.map((s) => ({
					type: "space",
					id: s.id,
					name: s.name,
					subtitle:
						s.description ??
						`${s.documentCount} ${s.documentCount === 1 ? "doc" : "docs"}`,
					badge: null,
					icon: DeliverySecure01Icon,
					updatedAt: normalizeTimestamp(s.updatedAt ?? s.createdAt),
					open: () => {
						stampRecent("space", s.id);
						// Path segment (not a query string): openTab strips query strings,
						// so the space id must live in the route to survive.
						openTab(`/spaces/${s.id}`, { title: s.name });
					},
					openInNewTab: () => {
						stampRecent("space", s.id);
						openTab(`/spaces/${s.id}`, { title: s.name, forceNew: true });
					},
					remove: () => {
						return Promise.resolve(removeSpace(s.id)).then(mutationResult);
					},
					// Core's `SpaceStore::delete_space` bails on `system = 1`, so the
					// row would only ever produce a failure toast — same call the
					// sidebar's Spaces row makes.
					removeBlockedReason: s.system
						? "System spaces can't be deleted — Ryu creates and maintains this one."
						: canDeleteSpaces
							? undefined
							: "You don't have permission to delete Spaces.",
				})),
		[canDeleteSpaces, spaces, openTab, removeSpace]
	);

	return {
		agents,
		agentItems,
		agentsLoading,
		chatItems,
		conversations,
		conversationsLoading,
		createSpace,
		spaceItems,
		spaces,
		spacesLoading,
		workflowItems,
		workflowsLoading,
	};
}
