import { toast } from "@ryu/ui/components/sileo.tsx";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AttachedImage } from "@/components/agent-elements/input-bar.tsx";
import { useSpacesContext } from "@/src/contexts/SpacesContext.tsx";
import { useAgents } from "@/src/hooks/useAgents.ts";
import { useApps } from "@/src/hooks/useApps.ts";
import {
	useComposioConnections,
	useComposioStatus,
	useComposioToolkits,
} from "@/src/hooks/useComposioCatalog.ts";
import { useEngineModels } from "@/src/hooks/useEngineModels.ts";
import { useHumanMentionDirectory } from "@/src/hooks/useHumanMentionDirectory.ts";
import { useMcp } from "@/src/hooks/useMcp.ts";
import { useMentionableResources } from "@/src/hooks/useMentionableResources.ts";
import { useSkillsCatalog } from "@/src/hooks/useSkillsCatalog.ts";
import { useTeams } from "@/src/hooks/useTeams.ts";
import { useWorkflows } from "@/src/hooks/useWorkflows.ts";
import type { ConversationParticipant } from "@/src/lib/api/agents.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import type {
	ConversationContextHandoff,
	ConversationModelChange,
	RecordConversationModelSelectionInput,
} from "@/src/lib/api/conversation-model-selection.ts";
import { isAcpAgent } from "@/src/lib/chat-message-selectors.ts";
import { getAgentModel } from "@/src/lib/models.ts";
import { useCreateAgentDialog } from "@/src/store/useCreateAgentDialog.ts";
import { useWorkspaceStore } from "@/src/store/useWorkspaceStore.ts";
import type { useChatPageChrome } from "./ChatPage.chrome.ts";
import type { ChatPageBaseScope } from "./ChatPage.types.ts";

export type UseChatComposerResourcesInput = ChatPageBaseScope &
	ReturnType<typeof useChatPageChrome>;

/** Model selection state, composer attachments, and the directories the composer mentions draw from. */
export function useChatComposerResources({
	agentId,
	initialModel,
	activeNode,
	initialImages,
	teamId,
	pluginContributions,
	statusLoading,
	coreReachable,
	gatewayReachable,
}: UseChatComposerResourcesInput) {
	// "Create new agent" in the composer's agent picker opens the create dialog
	// rather than a whole editor tab.
	const { openCreateAgent } = useCreateAgentDialog();

	// Per-agent model selection for the composer model picker. Recomputed when
	// the active agent changes; the chosen id is persisted per agent and sent in
	// the chat body. The ref keeps the transport closure reading the live value.
	//
	// Seeded from THIS tab's own agent, not from the last-used one: a tab opened
	// on a specific agent (merged view, launchpad seed) otherwise started on some
	// other agent's model until the first pick.
	const [selectedModel, setSelectedModel] = useState<string | null>(
		() => initialModel ?? getAgentModel(agentId)
	);
	const [providerModelSelection, setProviderModelSelection] = useState<Pick<
		ConversationModelChange,
		"modelId" | "providerId" | "providerLabel"
	> | null>(null);
	const [conversationModelChanges, setConversationModelChanges] = useState<
		ConversationModelChange[]
	>([]);
	const providerModelSelectionRef = useRef(providerModelSelection);
	providerModelSelectionRef.current = providerModelSelection;
	const conversationModelChangesRef = useRef(conversationModelChanges);
	conversationModelChangesRef.current = conversationModelChanges;
	const [contextHandoffs, setContextHandoffs] = useState<
		ConversationContextHandoff[]
	>([]);
	const contextHandoffsRef = useRef(contextHandoffs);
	contextHandoffsRef.current = contextHandoffs;
	// A new opaque owner is created for every semantic authority transition,
	// including A → B → A. Credentials never become a React key.
	const modelSelectionScope = useMemo(
		() => ({
			target: {
				url: activeNode.url,
				token: activeNode.token ?? null,
				userJwt: activeNode.userJwt ?? null,
			} satisfies ApiTarget,
		}),
		[activeNode.url, activeNode.token, activeNode.userJwt]
	);
	const modelSelectionScopeRef = useRef(modelSelectionScope);
	modelSelectionScopeRef.current = modelSelectionScope;
	const modelSelectionMountedRef = useRef(true);
	useEffect(() => {
		modelSelectionMountedRef.current = true;
		return () => {
			modelSelectionMountedRef.current = false;
		};
	}, []);
	const [modelHistoryReady, setModelHistoryReady] = useState<{
		conversationId: string;
		scope: typeof modelSelectionScope;
	} | null>(null);
	const modelSelectionWriteQueueRef = useRef<Promise<void>>(Promise.resolve());
	const pendingModelSelectionRef = useRef<
		| (RecordConversationModelSelectionInput & {
				conversationId: string | null;
				draftConversationId: string;
				scope: typeof modelSelectionScope;
		  })
		| null
	>(null);
	// A streamed control can explicitly clear the model. Keep that distinction
	// from an unset picker value so the fallback model is not reintroduced.
	const [modelSelectionCleared, setModelSelectionCleared] = useState(false);
	const selectedModelRef = useRef(selectedModel);
	const ghostChatActiveRef = useRef(false);

	// Image attachments — managed here so handleSend can include them in the
	// AI SDK message and clear them after send. Seeded once from `initialImages`
	// when this tab was opened from the launchpad composer (files staged before a
	// conversation existed), so they aren't lost across the launcher → chat handoff.
	const [attachedImages, setAttachedImages] = useState<
		{
			id: string;
			filename: string;
			url: string;
			mimeType: string;
			size?: number;
		}[]
	>(
		() =>
			initialImages?.map((img) => ({
				id: img.id,
				filename: img.filename,
				url: img.url,
				mimeType: img.mimeType ?? "image/png",
				size: img.size,
			})) ?? []
	);
	const clipsDraftInsertionSequence = useRef(0);
	const [clipsDraftInsertion, setClipsDraftInsertion] = useState<{
		id: number;
		text: string;
	} | null>(null);
	const [isDragOver, setIsDragOver] = useState(false);
	const attachmentRef = useRef({ attachedImages, isDragOver });
	attachmentRef.current = { attachedImages, isDragOver };
	const handleAttachTextFile = useCallback((attachment: AttachedImage) => {
		setAttachedImages((previous) => [
			...previous,
			{ ...attachment, mimeType: attachment.mimeType ?? "text/plain" },
		]);
		toast.success("CI failure report attached", {
			description: "It will be included with your next message in this chat.",
		});
	}, []);

	// #415: target_agent_id for council @mentions — written by CouncilInputBar on
	// each send and consumed by the transport body closure below.
	const targetAgentIdRef = useRef<string | null>(null);

	// team_id for @group mentions — when set, Core fans the message out to the
	// group's members per its coordination strategy (takes precedence over
	// agent_id/target_agent_id). Reset after each send.
	const teamIdRef = useRef<string | null>(null);

	// Mirror of the persistent group selection for the send-time body closure
	// (assigned every render, like selectedModelRef). The transient `@group`
	// mention in teamIdRef wins for one send, then falls back to this.
	const composerTeamIdRef = useRef<string | null>(null);
	composerTeamIdRef.current = teamId;

	// workflow_id for @workflow mentions — when set, Core runs the workflow with
	// the message as its chat input (takes precedence over agent/team targets).
	// Reset after each send, mirroring teamIdRef.
	const workflowIdRef = useRef<string | null>(null);
	// Chat @mentions are context references, not routing targets. The composer
	// resolves labels to durable ids and hands them to the next request once.
	const referencedConversationIdsRef = useRef<string[]>([]);

	// #415: Current participants list for labelling assistant messages per-agent.
	const [participants, setParticipants] = useState<ConversationParticipant[]>(
		[]
	);

	// #415: Maps assistant-message index (string) to an agent display name for labels.
	const agentLabelMapRef = useRef<Record<string, string>>({});

	// Load agents to inspect the selected agent's transport type.
	const { agents } = useAgents();
	const { apps: registeredApps } = useApps();
	const inboxEnabled = registeredApps.some(
		(app) => app.id === "@ryu/approvals" && app.enabled
	);
	const humanMentionDirectory = useHumanMentionDirectory({
		enabled: inboxEnabled,
	});
	const pullRequestsEnabled = registeredApps.some(
		(app) => app.id === "@ryu/pull-requests" && app.enabled
	);
	// Composio connections are mentionable only when Core reports a configured
	// credential. That same redacted status covers a local BYOK key and a
	// provisioned managed/proxy credential; never infer access from the catalog.
	const composioStatus = useComposioStatus();
	const composioConfigured = composioStatus.data?.configured ?? false;
	const { data: composioConnections = [] } = useComposioConnections(
		"",
		composioConfigured
	);
	const { data: composioToolkits = [] } = useComposioToolkits(
		composioConfigured && composioConnections.length > 0
	);
	// Load groups so @group mentions resolve in the composer autocomplete.
	const { teams } = useTeams();
	// Load workflows so @workflow mentions resolve in the composer autocomplete.
	// Only chat-triggerable ones (a root Input node, per Core) surface in the
	// mention menu; the rest can still be run from the Workflows app.
	const { resume: resumeWorkflow, workflows } = useWorkflows();
	const handleWorkflowResume = useCallback(
		(runId: string, payload: string) => resumeWorkflow(runId, payload),
		[resumeWorkflow]
	);
	// Extra "@" mention sources: spaces, installed skills, MCP servers, connected
	// integrations, and recent project folders. Composer plugins (goal/proof/double-check) come
	// from the client-side registry. See docs/rfc-mention-composer.md.
	const {
		error: spacesError,
		loading: spacesLoading,
		spaces,
	} = useSpacesContext();
	const contributedSections = useMemo(
		() =>
			[...pluginContributions.sidebar_sections].sort(
				(a, b) =>
					(a.order ?? 0) - (b.order ?? 0) || a.title.localeCompare(b.title)
			),
		[pluginContributions.sidebar_sections]
	);
	const [remoteMentionQuery, setRemoteMentionQuery] = useState<string | null>(
		null
	);
	const mentionableResources = useMentionableResources(contributedSections, {
		agentId: agentId ?? undefined,
		query: remoteMentionQuery,
	});
	const remoteMentionItemsRef = useRef(mentionableResources.appItems);
	remoteMentionItemsRef.current = mentionableResources.appItems;
	const { installedSkills } = useSkillsCatalog();
	const { servers: mcpServers } = useMcp();
	const recentFolders = useWorkspaceStore((s) => s.recentFolders);
	// Core-owned per-engine model catalog (offline fallback lives in models.ts).
	const engineModels = useEngineModels();

	// #402: Derive transport-aware gating flags.
	// Core down = all chat off regardless of agent.
	// Gateway required only when the selected agent uses openai-compat transport.
	const acpAgent = isAcpAgent(agentId, agents);
	const chatDisabled = statusLoading ? false : !coreReachable;
	const gatewayRequiredForAgent = !(acpAgent || gatewayReachable);

	// The reason a blocked composer is disabled is surfaced in the sidebar
	// Announcements section (see useSystemAnnouncements) rather than as an
	// inline overlay banner, so the composer just quietly disables here.

	const baseComposerBlocked = chatDisabled || gatewayRequiredForAgent;

	// Long-term (cross-session) memory is opt-in per the privacy-by-default
	// principle. Persisted locally so the choice survives restarts.
	const [longTermMemory] = useState<boolean>(
		() => localStorage.getItem("ryu_long_term_memory") === "true"
	);
	return {
		openCreateAgent,
		selectedModel,
		setSelectedModel,
		providerModelSelection,
		setProviderModelSelection,
		conversationModelChanges,
		setConversationModelChanges,
		providerModelSelectionRef,
		conversationModelChangesRef,
		contextHandoffs,
		setContextHandoffs,
		contextHandoffsRef,
		modelSelectionScope,
		modelSelectionScopeRef,
		modelSelectionMountedRef,
		modelHistoryReady,
		setModelHistoryReady,
		modelSelectionWriteQueueRef,
		pendingModelSelectionRef,
		modelSelectionCleared,
		setModelSelectionCleared,
		selectedModelRef,
		ghostChatActiveRef,
		attachedImages,
		setAttachedImages,
		clipsDraftInsertionSequence,
		clipsDraftInsertion,
		setClipsDraftInsertion,
		isDragOver,
		setIsDragOver,
		attachmentRef,
		handleAttachTextFile,
		targetAgentIdRef,
		teamIdRef,
		composerTeamIdRef,
		workflowIdRef,
		referencedConversationIdsRef,
		participants,
		setParticipants,
		agentLabelMapRef,
		agents,
		registeredApps,
		inboxEnabled,
		humanMentionDirectory,
		pullRequestsEnabled,
		composioConfigured,
		composioConnections,
		composioToolkits,
		teams,
		workflows,
		handleWorkflowResume,
		spacesError,
		spacesLoading,
		spaces,
		setRemoteMentionQuery,
		mentionableResources,
		remoteMentionItemsRef,
		installedSkills,
		mcpServers,
		recentFolders,
		engineModels,
		acpAgent,
		baseComposerBlocked,
		longTermMemory,
	} as const;
}
