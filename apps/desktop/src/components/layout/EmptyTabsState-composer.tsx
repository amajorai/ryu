import { cn } from "@ryu/ui/lib/utils.ts";
import type { UIMessage } from "ai";
import {
	type DragEvent,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import type { PluginComposerControlRow } from "@/components/agent-elements/input/goal-plus-button.tsx";
import { useComposerSlot } from "@/src/components/assistant/useComposerSlot.tsx";
import { WorkspaceBar } from "@/src/components/chat/WorkspaceBar.tsx";
import { useTabsContext } from "@/src/contexts/TabsContext.tsx";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import { useAgents } from "@/src/hooks/useAgents.ts";
import { useEngineModels } from "@/src/hooks/useEngineModels.ts";
import { useInterfaceLevel } from "@/src/hooks/useInterfaceLevel.ts";
import { useNodeDefaultAgentId } from "@/src/hooks/useNodeDefaultAgent.ts";
import { useNodeTabOverride } from "@/src/hooks/useNodeDisplayMode.ts";
import { usePluginContributions } from "@/src/hooks/usePluginContributions.ts";
import { useTeams } from "@/src/hooks/useTeams.ts";
import { TEMPORARY_CONTEXT_FLAG } from "@/src/lib/api/temporary-chat.ts";
import {
	readLastUsedAgentId,
	rememberLastUsedAgent,
	seedComposerAgentId,
	shouldAdoptNodeDefault,
} from "@/src/lib/composer-target.ts";
import {
	getAgentModel,
	modelsForAgent,
	setAgentModel,
} from "@/src/lib/models.ts";
import { useCreateAgentDialog } from "@/src/store/useCreateAgentDialog.ts";

/**
 * The real chat composer, surfaced on the launchpad — literally the same composer
 * the Ask Ryu dock and the builder panes render, built by the one shared
 * `useComposerSlot`: agent/model/thinking pickers, the "+" dropdown, staged image
 * attachments, live voice input (STT), and voice mode. It used to re-wire those
 * pieces itself, which is exactly how the "+" here silently stayed a bare file
 * dialog while the chat page's grew a dropdown. Sending opens a fresh chat tab
 * seeded with the typed text, the chosen agent, the temporary-chat pick, and any
 * staged images (which have no conversation to live on yet, so they ride the tab
 * seed into the new chat). The model pick is persisted per-agent
 * (`setAgentModel`), so the new chat surfaces the same agent/model.
 */
export function LaunchpadComposer() {
	const { openTab } = useTabsContext();
	const { openCreateAgent } = useCreateAgentDialog();
	const { agents } = useAgents();
	const { teams } = useTeams();
	const engineModels = useEngineModels();
	const activeNode = useActiveNode();
	const interfaceLevel = useInterfaceLevel();
	const pluginContributions = usePluginContributions();

	// The launchpad is always a BRAND NEW chat, so it runs the same seed chain a
	// fresh ChatPage does — minus the conversation link, which does not exist yet.
	// The pick rides `initialAgent` into the tab it opens, so whatever resolves
	// here is what that chat starts on.
	const [agentId, setAgentId] = useState<string | null>(() =>
		seedComposerAgentId({ lastUsedAgentId: readLastUsedAgentId() })
	);
	const agentIdRef = useRef(agentId);
	agentIdRef.current = agentId;
	const [teamId, setTeamId] = useState<string | null>(null);
	const [selectedModel, setSelectedModel] = useState<string | null>(() =>
		getAgentModel(agentIdRef.current)
	);

	// Last link in the chain: the node-wide default (`default-agent-selection`).
	// Async, so it fills a hole rather than seeding — see `shouldAdoptNodeDefault`.
	const nodeDefaultAgentId = useNodeDefaultAgentId();
	useEffect(() => {
		if (shouldAdoptNodeDefault(agentIdRef.current, nodeDefaultAgentId)) {
			setAgentId(nodeDefaultAgentId);
			setSelectedModel(getAgentModel(nodeDefaultAgentId));
		}
	}, [nodeDefaultAgentId]);
	// Temporary chat, picked BEFORE the thread exists — the launchpad is the
	// new-chat surface, which is the only place ChatPage offers the toggle too. It
	// rides the tab seed so the spawned chat opens already unsaved.
	const [ghost, setGhost] = useState(false);
	// The computer chip's pick (`null` = the default computer); rides the new tab
	// as its computer binding.
	const [computer, setComputer] = useState<string | null>(null);
	const tabOverridesEnabled = useNodeTabOverride();
	const [temporaryMemory, setTemporaryMemory] = useState(false);
	const [isDragOver, setIsDragOver] = useState(false);
	const temporaryMemoryControl =
		useMemo<PluginComposerControlRow | null>(() => {
			const contribution = pluginContributions.composer_controls.find(
				(control) =>
					control.type === "toggle" && control.flag === TEMPORARY_CONTEXT_FLAG
			);
			if (!contribution) {
				return null;
			}
			return {
				description: contribution.description,
				enabled: temporaryMemory,
				flag: contribution.flag,
				id: contribution.id,
				label: contribution.label,
				onToggle: (_flag, next) => setTemporaryMemory(next),
			};
		}, [pluginContributions.composer_controls, temporaryMemory]);

	const modelOptions = useMemo(
		() => modelsForAgent(agentId, agents, engineModels),
		[agentId, agents, engineModels]
	);
	const effectiveModel =
		[selectedModel, getAgentModel(agentId)].find(
			(id) => id && modelOptions.some((m) => m.id === id)
		) ??
		modelOptions[0]?.id ??
		null;

	// Persist an engine-catalog model pick per-agent so the spawned chat surfaces it.
	const handleEngineModelChange = useCallback(
		(modelId: string) => {
			setSelectedModel(modelId);
			if (agentId) {
				setAgentModel(agentId, modelId);
			}
		},
		[agentId]
	);

	// Picking an agent clears any team target and becomes the remembered seed for
	// the next brand-new chat. It does NOT reach into any open chat tab: each one
	// owns its own target, pinned by its conversation.
	const handleSelectAgent = useCallback((next: string) => {
		setTeamId(null);
		setAgentId(next);
		rememberLastUsedAgent(next);
		setSelectedModel(getAgentModel(next));
	}, []);

	// The node the composer's mic / voice mode / image staging talk to.
	const target = useMemo(
		() => ({
			url: activeNode.url,
			token: activeNode.token,
			userJwt: activeNode.userJwt ?? null,
		}),
		[activeNode.url, activeNode.token]
	);

	// The launchpad owns its agent/model pick (persisted to localStorage) but
	// nothing else — those five bindings are all the shared composer needs.
	const runtime = useMemo(
		() => ({
			agentId,
			effectiveModel,
			modelOptions,
			setAgentId: handleSelectAgent,
			setModel: handleEngineModelChange,
		}),
		[
			agentId,
			effectiveModel,
			modelOptions,
			handleSelectAgent,
			handleEngineModelChange,
		]
	);

	// The ONE composer. No conversation id: the launchpad always opens a new chat,
	// so voice-mode turns stay ephemeral and `atConversationStart` derives true.
	const composer = useComposerSlot(runtime, {
		target,
		surface: "new-tab",
		teams,
		teamId,
		onSelectTeam: setTeamId,
		onCreateAgent: () => openCreateAgent(),
		ghost: { active: ghost, onToggle: () => setGhost((on) => !on) },
		pluginControls:
			ghost && temporaryMemoryControl ? [temporaryMemoryControl] : undefined,
	});
	const { addFiles, clear, images, onAttach, onPaste, onRemoveImage } =
		composer.attachments;
	const Composer = composer.inputBar;

	const handleDrop = useCallback(
		(e: DragEvent) => {
			e.preventDefault();
			setIsDragOver(false);
			addFiles(Array.from(e.dataTransfer.files));
		},
		[addFiles]
	);
	const composerNode = (
		<Composer
			attachedImages={images}
			autoFocus
			isDragOver={isDragOver}
			liveCall={
				composer.voiceMode.active ? composer.voiceMode.liveCall : undefined
			}
			onAttach={onAttach}
			onPaste={onPaste}
			onRemoveImage={onRemoveImage}
			onSend={(message: { role: "user"; content: string }) => {
				const content = message.content.trim();
				if (!content && images.length === 0) {
					return;
				}
				openTab("/chat", {
					forceNew: true,
					initialPrompt: content,
					// User-initiated send: actually SEND it in the new chat tab, not
					// just pre-fill the composer (that's the deep-link/Inbox behavior).
					// A team target isn't carried into the tab, so for a team pick we
					// fall back to pre-fill rather than auto-send to the wrong agent.
					initialSubmit: true,
					initialImages: images.length > 0 ? images : undefined,
					initialAgent: teamId ? undefined : (agentId ?? undefined),
					initialTeamId: teamId ?? undefined,
					initialGhost: ghost ? true : undefined,
					initialPluginFlags: temporaryMemory
						? { [TEMPORARY_CONTEXT_FLAG]: true }
						: undefined,
					// Ignored by the tab while per-tab computers are off, so only
					// bind when the binding will be honoured.
					node: tabOverridesEnabled ? (computer ?? undefined) : undefined,
				});
				// The images now live on the tab seed; drop them here so they don't
				// re-attach to the next thing typed on the launchpad.
				clear();
			}}
			onStop={() => undefined}
			placeholder="What do you want to do?"
			status="ready"
			workspaceBar={
				interfaceLevel === "simple" ? undefined : (
					<WorkspaceBar
						computer={{ value: computer, onChange: setComputer }}
						target={target}
					/>
				)
			}
		/>
	);

	return (
		<div
			className="relative"
			onDragLeave={(e) => {
				if (
					!(
						e.relatedTarget instanceof Node &&
						e.currentTarget.contains(e.relatedTarget)
					)
				) {
					setIsDragOver(false);
				}
			}}
			onDragOver={(e) => {
				e.preventDefault();
				setIsDragOver(true);
			}}
			onDrop={handleDrop}
		>
			{composer.voiceMode.active && composer.voiceMode.messages?.length ? (
				<VoiceLaunchpadTranscript messages={composer.voiceMode.messages} />
			) : null}
			{composerNode}
		</div>
	);
}

/**
 * Completed voice-call turns on the launchpad. There is no chat transcript here
 * (the launchpad never binds a conversation), so honour "Show transcript in
 * voice mode" with a compact read-only list above the call composer.
 */
function VoiceLaunchpadTranscript({ messages }: { messages: UIMessage[] }) {
	return (
		<ol
			aria-label="Voice call transcript"
			aria-live="polite"
			className="scroll-fade mb-3 flex max-h-48 flex-col gap-1.5 overflow-y-auto px-1 text-sm"
			data-testid="voice-launchpad-transcript"
		>
			{messages.map((message) => (
				<li
					className={cn(
						"max-w-[85%] whitespace-pre-wrap rounded-2xl px-3 py-1.5",
						message.role === "user"
							? "self-end bg-muted text-foreground"
							: "self-start text-foreground"
					)}
					key={message.id}
				>
					{message.parts
						.map((part) => (part.type === "text" ? part.text : ""))
						.join("")}
				</li>
			))}
		</ol>
	);
}
