import type {
	MentionItem as AgentElementMentionItem,
	ContributedSelectionAction,
} from "@ryu/blocks/desktop/agent-elements/types.ts";
import { toast } from "@ryu/ui/components/sileo.tsx";
import { useCallback, useMemo, useState } from "react";
import { openExternal, previewLinkMetadata } from "@/lib/tauri-bridge.ts";
import type { ActivePermission } from "@/src/components/chat/PermissionPrompt.tsx";
import { pluginCompanionPath } from "@/src/hooks/usePluginContributions.ts";
import { respondPermission } from "@/src/lib/api/acp.ts";
import type { PluginSelectionAction } from "@/src/lib/api/plugins.ts";
import { openContributedLink } from "@/src/lib/contributed-link-handler.ts";
import { basename, readProjectFile } from "@/src/lib/files.ts";
import { permissionPartKey } from "@/src/lib/interface-live-tab.ts";
import {
	mergeComposerCommands,
	parseSlashCommandContribution,
	type SlashCommand,
} from "@/src/lib/slash-commands.ts";
import { resolveWorkspaceFilePath } from "@/src/lib/workspace-links.ts";
import { useDockPanelRequestStore } from "@/src/store/useDockPanelRequestStore.ts";
import {
	answeredPermissionKey,
	isPermissionAnswered,
	useInterfaceDetailStore,
} from "@/src/store/useInterfaceDetailStore.ts";
import type { useChatAssistantIdentity } from "./ChatPage.assistant-identity.tsx";
import type { useChatPageChrome } from "./ChatPage.chrome.ts";
import type { useChatComposerResources } from "./ChatPage.composer-resources.ts";
import type { useChatConversationState } from "./ChatPage.conversation-state.ts";
import type { useChatConversationSync } from "./ChatPage.conversation-sync.ts";
import { LOCAL_SLASH_COMMANDS } from "./ChatPage.helpers.ts";
import type { useChatModelSelection } from "./ChatPage.model-selection.ts";
import type { useChatTransport } from "./ChatPage.transport.ts";

export type UseChatPermissionsAndLinksInput = ReturnType<
	typeof useChatPageChrome
> &
	ReturnType<typeof useChatComposerResources> &
	ReturnType<typeof useChatAssistantIdentity> &
	ReturnType<typeof useChatModelSelection> &
	ReturnType<typeof useChatConversationState> &
	ReturnType<typeof useChatConversationSync> &
	ReturnType<typeof useChatTransport>;

/** Permission prompts, link and mention handlers, and composer commands. */
export function useChatPermissionsAndLinks({
	activeNode,
	messages,
	chatId,
	chatTargetRef,
	convIdRef,
	draftConvId,
	chatFolder,
	openTab,
	chatTarget,
	pluginContributions,
	folder,
	installedSkills,
}: UseChatPermissionsAndLinksInput) {
	// Interactive ACP tool-permission prompts. When an agent in a gating mode
	// asks to run a tool, Core streams a `data-ryu-permission` part; we surface
	// the latest unresolved one in the shared composer surface and POST the user's choice
	// back (`/api/chat/permission`) to unblock the awaiting turn. Resolved
	// requests are tracked so the prompt clears once answered, keyed by node,
	// conversation and request id (`answeredPermissionKey`): Core mints
	// `perm-<seq>` from a per-process counter, so the ids repeat across nodes
	// and Core restarts. Both sets are pruned when the turn ends; the prompts
	// answered in that turn stay hidden by where they sit (`permissionPartKey`),
	// so a later turn that reuses an id still shows its own prompt.
	const [resolvedPermissions, setResolvedPermissions] = useState<Set<string>>(
		() => new Set()
	);
	const [spentPermissions, setSpentPermissions] = useState<Set<string>>(
		() => new Set()
	);
	const permissionNodeUrl = activeNode.url;
	const answeredPermissions = useInterfaceDetailStore(
		(state) => state.answeredPermissions
	);
	const activePermission = useMemo<ActivePermission | null>(() => {
		for (let i = messages.length - 1; i >= 0; i--) {
			const m = messages[i];
			if (m.role !== "assistant" || !m.parts) {
				continue;
			}
			for (let j = m.parts.length - 1; j >= 0; j--) {
				const part = m.parts[j];
				if (part?.type !== "data-ryu-permission") {
					continue;
				}
				const data =
					/* SAFETY: The permission discriminator selects Core ACP PermissionRequest serialization: requestId, toolCall and options are emitted together. */ part.data as
						| ActivePermission
						| undefined;
				if (
					!data?.requestId ||
					spentPermissions.has(permissionPartKey(m.id, data.requestId))
				) {
					continue;
				}
				const scope = {
					nodeUrl: permissionNodeUrl,
					requestId: data.requestId,
					threadId: chatId,
				};
				if (
					!(
						resolvedPermissions.has(answeredPermissionKey(scope)) ||
						isPermissionAnswered(answeredPermissions, scope)
					)
				) {
					return data;
				}
			}
		}
		return null;
	}, [
		messages,
		resolvedPermissions,
		spentPermissions,
		answeredPermissions,
		permissionNodeUrl,
		chatId,
	]);

	// Deliver a decision for one permission request. Keeping the request id in
	// this callback makes the composer card answer the exact gate that is on
	// screen, even if another stream update arrives while it is open.
	const respondToPermission = useCallback(
		(requestId: string, optionId: string | null) => {
			const scope = {
				nodeUrl: chatTargetRef.current.url,
				requestId,
				threadId: convIdRef.current ?? draftConvId.current,
			};
			const key = answeredPermissionKey(scope);
			setResolvedPermissions((prev) => {
				if (prev.has(key)) {
					return prev;
				}
				const next = new Set(prev);
				next.add(key);
				return next;
			});
			// Every tab on this thread, and the interfaces, drop the prompt too.
			useInterfaceDetailStore.getState().markPermissionAnswered(scope);
			respondPermission(chatTargetRef.current, requestId, optionId).catch(
				() => {
					// Optimistically cleared already; a failed POST just means the
					// request had already timed out/resolved server-side.
				}
			);
		},
		[]
	);

	// Slash commands contributed by enabled Core plugins (e.g. `/proof` from the
	// proof-of-work turn-hook plugin). Core tags each with its owning `plugin` id
	// and returns the full `command` text (leading "/"); the popover works off the
	// bare name, so strip it. These are plain messages at submit time — Core's
	// turn-hook interprets them — so nothing client-side handles them here.
	const handleOpenFileLink = useCallback(
		(mentionedPath: string) => {
			const path = resolveWorkspaceFilePath(chatFolder, mentionedPath);
			if (!path) {
				toast.error("That file is outside the current workspace.");
				return;
			}
			openTab(`/file/${encodeURIComponent(path)}`, { title: basename(path) });
		},
		[chatFolder, openTab]
	);
	const handleOpenWebsiteLink = useCallback(
		async (href: string) => {
			const opened = await openContributedLink(
				chatTarget,
				pluginContributions.dock_panels,
				href
			).catch(() => null);
			if (opened) {
				useDockPanelRequestStore.getState().open(opened.kind, opened.label);
				return;
			}
			await openExternal(href).catch(() => undefined);
		},
		[chatTarget, pluginContributions.dock_panels]
	);
	const handleOpenMention = useCallback(
		(item: AgentElementMentionItem) => {
			if (item.target) {
				openTab(item.target.path, {
					...item.target.options,
					title: item.label,
				});
				return;
			}
			if (!item.id) {
				openTab("/store", { title: item.label });
				return;
			}
			switch (item.kind) {
				case "agent":
					openTab(`/agents/${encodeURIComponent(item.id)}/edit`, {
						title: item.label,
					});
					break;
				case "app": {
					const companion = pluginContributions.companions.find(
						(entry) => entry.pluginId === item.id
					);
					openTab(companion ? pluginCompanionPath(companion.id) : "/apps", {
						title: item.label,
					});
					break;
				}
				case "chat":
					openTab("/chat", {
						conversationId: item.id,
						title: item.label,
					});
					break;
				case "folder":
					openTab(`/project/files/${encodeURIComponent(item.id)}`, {
						title: basename(item.id),
					});
					break;
				case "integration":
					openTab("/store/integrations", { title: item.label });
					break;
				case "mcp":
					openTab(`/store/mcp/q/${encodeURIComponent(item.id)}`, {
						title: item.label,
					});
					break;
				case "plugin":
					openTab("/extensions", { title: item.label });
					break;
				case "skill":
					openTab("/skills", { title: item.label });
					break;
				case "space":
					openTab(`/spaces/${encodeURIComponent(item.id)}`, {
						title: item.label,
					});
					break;
				case "page":
					openTab("/spaces", { title: item.label });
					break;
				case "app-item":
					openTab("/apps", { title: item.label });
					break;
				case "output-style":
					openTab("/library/agent", { title: item.label });
					break;
				case "team":
					openTab("/library/team", { title: item.label });
					break;
				case "workflow":
					openTab(`/workflows/${encodeURIComponent(item.id)}`, {
						title: item.label,
					});
					break;
				default:
					openTab("/store", { title: item.label });
			}
		},
		[openTab, pluginContributions.companions]
	);
	const linkPreviewResolvers = useMemo(
		() => ({
			previewWebsite: previewLinkMetadata,
			previewFile: async (mentionedPath: string) => {
				const path = resolveWorkspaceFilePath(folder, mentionedPath);
				if (!path) {
					return null;
				}
				const content = await readProjectFile(path);
				const snippet = content
					.split("\n")
					.slice(0, 24)
					.join("\n")
					.slice(0, 6000);
				return { name: basename(path), path, snippet };
			},
		}),
		[folder]
	);
	const pluginSlashCommands = useMemo<SlashCommand[]>(() => {
		const out: SlashCommand[] = [];
		for (const entry of pluginContributions.slash_commands) {
			const command = parseSlashCommandContribution(entry);
			if (command) {
				out.push(command);
			}
		}
		return out;
	}, [pluginContributions.slash_commands]);

	// Contributed per-message toolbar actions (`contributes.message_actions`),
	// passed into blocks presentationally. The shell dispatches each through its
	// renderer or the owning plugin's granted host seam when fired.
	const contributedMessageActions = useMemo(() => {
		return pluginContributions.message_actions.map((a) => ({
			args: a.args,
			id: a.id,
			label: a.label,
			icon: a.icon,
			kind: a.kind,
			target: a.target,
			states: a.states,
			capability: a.capability,
			order: a.order,
			plugin: a.plugin,
		}));
	}, [pluginContributions.message_actions]);

	// Contributed actions for the floating text-selection toolbar. Blocks renders
	// these presentationally; the shell keeps the selected text and dispatch rules
	// on this side of the plugin boundary.
	const contributedSelectionActions = useMemo<ContributedSelectionAction[]>(
		() =>
			pluginContributions.selection_actions.map((a: PluginSelectionAction) => ({
				args: a.args,
				capability: a.capability,
				icon: a.icon,
				id: a.id,
				kind: a.kind,
				label: a.label,
				order: a.order,
				plugin: a.plugin,
			})),
		[pluginContributions.selection_actions]
	);

	// Slash commands the active agent advertised over ACP. Core streams the full
	// list (each update replaces the last) as a `data-ryu-acp-commands` part; we
	// take the most recent one across the thread. Combined with Ryu's own local
	// commands and enabled plugins' contributed commands to drive the composer's
	// "/" popover. Plugin commands are deduped by name against ACP + local ones,
	// which win; enabled installed Skills are appended after those commands and
	// lose any id collision so a real command always keeps its handler.
	const composerCommands = useMemo<SlashCommand[]>(() => {
		const withPlugins = (base: SlashCommand[]): SlashCommand[] => {
			const seen = new Set(base.map((c) => c.name));
			const extra = pluginSlashCommands.filter((c) => !seen.has(c.name));
			return [...base, ...extra];
		};
		const withSkills = (base: SlashCommand[]): SlashCommand[] =>
			mergeComposerCommands(withPlugins(base), installedSkills);
		for (let i = messages.length - 1; i >= 0; i--) {
			const m = messages[i];
			if (m.role !== "assistant" || !m.parts) {
				continue;
			}
			for (let j = m.parts.length - 1; j >= 0; j--) {
				const part = m.parts[j];
				if (part?.type !== "data-ryu-acp-commands") {
					continue;
				}
				// SAFETY: Core maps typed ACP AvailableCommand entries to an explicit Value::Array with string names and descriptions; nullable hints are retained by the nullish fallback below.
				const data = part.data as
					| {
							commands?: {
								name: string;
								description?: string;
								hint?: string;
							}[];
					  }
					| undefined;
				if (!data?.commands) {
					continue;
				}
				const agentCommands: SlashCommand[] = data.commands.map((c) => ({
					args: [],
					name: c.name,
					description: c.description ?? "",
					hint: c.hint ?? null,
					source: "agent",
				}));
				return withSkills([...agentCommands, ...LOCAL_SLASH_COMMANDS]);
			}
		}
		return withSkills(LOCAL_SLASH_COMMANDS);
	}, [installedSkills, messages, pluginSlashCommands]);
	return {
		resolvedPermissions,
		setResolvedPermissions,
		setSpentPermissions,
		permissionNodeUrl,
		activePermission,
		respondToPermission,
		handleOpenFileLink,
		handleOpenWebsiteLink,
		handleOpenMention,
		linkPreviewResolvers,
		contributedMessageActions,
		contributedSelectionActions,
		composerCommands,
	} as const;
}
