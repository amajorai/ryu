import { handleComposerSettingsShortcut } from "@ryu/blocks/composer/composer-shortcuts.ts";
import type {
	ComposerMenuGroup,
	ComposerMenuItem,
} from "@ryu/blocks/desktop/agent-elements/input/composer-menu.tsx";
import { useDeferredComposerPrompt } from "@ryu/blocks/desktop/agent-elements/use-deferred-question.ts";
import {
	createElement,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import type { ComposerSettingsSection } from "@/components/agent-elements/input/composer-settings-menu.tsx";
import type { InputBarProps } from "@/components/agent-elements/input-bar.tsx";
import { InputBar } from "@/components/agent-elements/input-bar.tsx";
import { MentionMenu } from "@/src/components/chat/MentionMenu.tsx";
import {
	type ActivePermission,
	PermissionPrompt,
} from "@/src/components/chat/PermissionPrompt.tsx";
import { SlashCommandAutocomplete } from "@/src/components/chat/SlashCommandAutocomplete.tsx";
import { CHAT_REFERENCE_DRAG_MIME } from "@/src/components/layout/tabDnd.tsx";
import { useIsActiveTab } from "@/src/contexts/TabsContext.tsx";
import { useComposerShortcutBindings } from "@/src/hooks/useComposerShortcutBindings.ts";
import { useInterfaceLevel } from "@/src/hooks/useInterfaceLevel.ts";
import type { AgentSummary } from "@/src/lib/api/agents.ts";
import type { PluginChatWidgetTemplate } from "@/src/lib/api/plugins.ts";
import type { Team } from "@/src/lib/api/teams.ts";
import type { Workflow } from "@/src/lib/api/workflows.ts";
import {
	type DraggedChatReference,
	readDraggedChatReference,
} from "@/src/lib/chat-reference-drag.ts";
import {
	appendToComposerValue,
	CHAT_COMPOSER_INSERT_EVENT,
	type ChatComposerInsertDetail,
} from "@/src/lib/file-annotations.ts";
import {
	applyMention,
	buildMentionGroups,
	CHAT_MENTION_KINDS,
	resolveFirstNamedMentionId,
	resolveReferencedChatIds,
} from "@/src/lib/mentions/candidates.ts";
import {
	type SelectedHumanMention,
	selectHumanNotificationTargets,
} from "@/src/lib/mentions/human-notification.ts";
import type { MentionItem, MentionSources } from "@/src/lib/mentions/types.ts";
import { useProductMode } from "@/src/lib/product-mode.ts";
import {
	applySlashCommandOption,
	parseSlashMenuState,
	type SlashCommand,
	type SlashCommandOptionSelection,
} from "@/src/lib/slash-commands.ts";

const MENTION_QUERY_RE = /(?:^|\s)@(\w*)$/;

/**
 * Parse the last "@word" being typed in a string.
 * Returns the partial name after "@" if the cursor is at an in-progress mention,
 * or null if the cursor is not on a mention.
 */
function parseMentionQuery(value: string): string | null {
	const match = MENTION_QUERY_RE.exec(value);
	if (!match) {
		return null;
	}
	return match[1];
}

/** Scan message text for the first "@Name" that matches a chat-triggerable
 *  workflow, returning its id. A workflow mention is the most specific target
 *  of all — the message becomes the run's input, so it wins over agent/team.
 *
 *  Unlike agents/teams (matched on a `@word` token), workflow names are
 *  arbitrary ("Plan → Implement → Verify"), so the check is an exact
 *  `@Name` substring match — the same form the composer inserts when you pick a
 *  workflow from the mention menu. */
function resolveFirstWorkflowMention(
	text: string,
	workflows: Workflow[]
): string | null {
	const lower = text.toLowerCase();
	const found = workflows.find((w) =>
		lower.includes(`@${w.name.toLowerCase()}`)
	);
	return found?.id ?? null;
}

// #415: Council-aware InputBar — adds @mention autocomplete above the textarea
// ---------------------------------------------------------------------------
interface CouncilInputBarProps extends InputBarProps {
	allAgents: AgentSummary[];
	allTeams: Team[];
	/** Chat-triggerable workflows (a root Input node), for @workflow mentions. */
	allWorkflows: Workflow[];
	/** Slash commands offered in the "/" popover (agent-advertised + local). */
	availableCommands: SlashCommand[];
	/** Host-owned metadata affordances for available app widgets. */
	chatWidgetTemplates: PluginChatWidgetTemplate[];
	composerSections: ComposerSettingsSection[];
	/** Current signed-in Core user, excluded from Inbox mention fan-out. */
	currentUserId: string | null;
	/** Sources for the grouped "@" mention menu (apps/plugins/agents/workflows/users
	 *  plus the existing reference sources). Agents/teams/workflows also drive the target. */
	mentionSources: MentionSources;
	/** Sends selected human mentions to the optional Inbox bridge after chat send. */
	onHumanMentions: (mentions: SelectedHumanMention[], content: string) => void;
	/** Supplies the resolved chat mentions to the request body for this turn. */
	onReferencedChats: (conversationIds: string[]) => void;
	onRespondPermission?: (
		permission: ActivePermission,
		optionId: string | null
	) => void;
	onTargetAgentChange: (agentId: string | null) => void;
	onTeamChange: (teamId: string | null) => void;
	/** Fired on each composer keystroke so the surface can broadcast a debounced
	 * "typing" presence delta to the conversation room (multi-user collaboration). */
	onTyping?: () => void;
	onWorkflowChange: (workflowId: string | null) => void;
	/** Active interactive ACP tool-permission prompt, rendered above the composer. */
	permission?: ActivePermission | null;
}

export function CouncilInputBar({
	allAgents,
	allTeams,
	allWorkflows,
	availableCommands,
	chatWidgetTemplates,
	composerSections,
	currentUserId,
	mentionSources,
	onHumanMentions,
	onReferencedChats,
	onTargetAgentChange,
	onTeamChange,
	onWorkflowChange,
	onTyping,
	permission,
	onRespondPermission,
	value,
	onChange,
	onSend,
	onTextareaKeyDown,
	...rest
}: CouncilInputBarProps) {
	const botProduct = useProductMode() === "bot";
	const isActiveTab = useIsActiveTab();
	const composerShortcuts = useComposerShortcutBindings();
	const showTechnicalPermissionDetails = useInterfaceLevel() !== "simple";
	const [mentionQuery, setMentionQuery] = useState<string | null>(null);
	const [dismissedSlashValue, setDismissedSlashValue] = useState<string | null>(
		null
	);
	const textareaWrapRef = useRef<HTMLDivElement | null>(null);
	const referencedChatIdsRef = useRef<Set<string>>(new Set());
	const selectedHumanMentionsRef = useRef<SelectedHumanMention[]>([]);
	const slashMenuCandidate = useMemo(
		() => parseSlashMenuState(value ?? "", availableCommands),
		[value, availableCommands]
	);
	const slashMenu =
		botProduct || dismissedSlashValue === (value ?? "")
			? null
			: slashMenuCandidate;
	const {
		markComposerActivity: markPermissionActivity,
		markComposerIdle: markPermissionIdle,
		visiblePrompt: visiblePermission,
	} = useDeferredComposerPrompt(permission);
	const insertChatReference = useCallback(
		(chat: DraggedChatReference) => {
			referencedChatIdsRef.current.add(chat.id);
			onChange?.(
				`${value?.trimEnd() ?? ""}${value?.trim() ? " " : ""}@${chat.label} `
			);
			setMentionQuery(null);
		},
		[onChange, value]
	);
	useEffect(() => {
		if (!isActiveTab) {
			return;
		}
		const handleChatReferenceDrop = (event: Event) => {
			// SAFETY: ChatPage publishes this named event only after readDraggedChatReference
			// returns its full id/label owner; DOM EventListener erases that detail type.
			insertChatReference((event as CustomEvent<DraggedChatReference>).detail);
		};
		window.addEventListener("ryu:chat-reference-drop", handleChatReferenceDrop);
		return () =>
			window.removeEventListener(
				"ryu:chat-reference-drop",
				handleChatReferenceDrop
			);
	}, [insertChatReference, isActiveTab]);
	// Quoted context from the dock (file viewer notes) lands in the visible
	// tab's draft for the user to finish, rather than being sent on their behalf.
	useEffect(() => {
		if (!(isActiveTab && onChange)) {
			return;
		}
		const handleComposerInsert = (event: Event) => {
			if (event.defaultPrevented) {
				return;
			}
			// SAFETY: requestChatComposerInsert is this event's only publisher and
			// always attaches a ChatComposerInsertDetail.
			const { text } = (event as CustomEvent<ChatComposerInsertDetail>).detail;
			event.preventDefault();
			onChange(appendToComposerValue(value ?? "", text));
			textareaWrapRef.current?.querySelector("textarea")?.focus();
		};
		window.addEventListener(CHAT_COMPOSER_INSERT_EVENT, handleComposerInsert);
		return () =>
			window.removeEventListener(
				CHAT_COMPOSER_INSERT_EVENT,
				handleComposerInsert
			);
	}, [isActiveTab, onChange, value]);

	// Grouped "@" candidates for the current fragment (empty when the menu is
	// closed). Recomputed per keystroke; buildMentionGroups is pure.
	const mentionGroups = useMemo(
		() =>
			botProduct || mentionQuery === null
				? []
				: buildMentionGroups(mentionSources, mentionQuery, CHAT_MENTION_KINDS),
		[botProduct, mentionQuery, mentionSources]
	);
	const directoryMentionGroups = useMemo(
		() => (botProduct ? [] : buildMentionGroups(mentionSources, "")),
		[botProduct, mentionSources]
	);
	const composerMenuGroups = useMemo<ComposerMenuGroup[]>(
		() =>
			botProduct
				? []
				: directoryMentionGroups
						.filter((group) => group.kind !== "user")
						.map((group) => ({
							id: `directory:${group.kind}`,
							label: group.label,
							items: group.items.map((item) => ({
								id: `${item.kind}:${item.id}`,
								label: item.label,
								description: item.description,
								badge:
									item.kind === "app"
										? "App"
										: item.kind === "app-item"
											? "App item"
											: item.kind === "plugin"
												? "Plugin"
												: item.kind === "integration"
													? "Integration"
													: item.kind === "page"
														? "Page"
														: item.kind === "output-style"
															? "Profile"
															: undefined,
								icon:
									item.visualIcon ??
									(item.icon
										? createElement(item.icon, { className: "size-4" })
										: undefined),
							})),
						})),
		[botProduct, directoryMentionGroups]
	);
	const composerMentionItems = useMemo(
		() =>
			botProduct
				? []
				: directoryMentionGroups
						.flatMap((group) => group.items)
						.map((item) => ({
							accentColor: item.accentColor,
							icon: item.icon
								? createElement(item.icon, { className: "size-3.5" })
								: undefined,
							kind: item.kind,
							label: item.label,
							visualIcon: item.visualIcon,
						})),
		[botProduct, directoryMentionGroups]
	);

	const handleChange = useCallback(
		(next: string) => {
			onChange?.(next);
			setDismissedSlashValue(null);
			onTyping?.();
			if (next.length > 0) {
				markPermissionActivity();
			} else {
				markPermissionIdle();
			}
			const query = parseMentionQuery(next);
			setMentionQuery(query);
			if (query === null) {
				onTargetAgentChange(null);
				onTeamChange(null);
				onWorkflowChange(null);
			}
		},
		[
			markPermissionActivity,
			markPermissionIdle,
			onChange,
			onTyping,
			onTargetAgentChange,
			onTeamChange,
			onWorkflowChange,
		]
	);

	const handleSelectSlash = useCallback(
		(command: SlashCommand) => {
			// An imported user command (Codex prompt) expands straight into its
			// template body — the "prompt fills the box, then send" convention
			// Cursor/Codex use. Everything else inserts "/name " and leaves the
			// cursor for the argument.
			if (command.body) {
				onChange?.(command.body);
			} else {
				onChange?.(`/${command.name} `);
			}
		},
		[onChange]
	);
	const handleSelectSlashArgument = useCallback(
		(selection: SlashCommandOptionSelection) => {
			if (slashMenu?.kind !== "arguments") {
				return;
			}
			const hasNextArgument =
				slashMenu.argumentIndex < slashMenu.command.args.length - 1;
			const nextValue = applySlashCommandOption(
				value ?? "",
				selection.option.value,
				hasNextArgument
			);
			onChange?.(nextValue);
			if (!hasNextArgument) {
				setDismissedSlashValue(nextValue);
			}
		},
		[onChange, slashMenu, value]
	);

	const handleSelect = useCallback(
		(item: MentionItem) => {
			if (botProduct) {
				return;
			}
			onChange?.(applyMention(value ?? "", item));
			if (item.kind === "chat") {
				referencedChatIdsRef.current.add(item.id);
			}
			if (item.kind === "user") {
				selectedHumanMentionsRef.current.push({
					id: item.id,
					label: item.label,
				});
			}
			setMentionQuery(null);
			// Agents/teams/workflows set the target directly from the picked id;
			// spaces/skills/mcp/folders are plain reference tokens and plugins
			// rewrite the composer — none of those set a target.
			if (item.kind === "workflow") {
				onWorkflowChange(item.id);
				onTeamChange(null);
				onTargetAgentChange(null);
			} else if (item.kind === "team") {
				onTeamChange(item.id);
				onTargetAgentChange(null);
				onWorkflowChange(null);
			} else if (item.kind === "agent") {
				onTargetAgentChange(item.id);
				onTeamChange(null);
				onWorkflowChange(null);
			}
		},
		[
			value,
			onChange,
			onTargetAgentChange,
			onTeamChange,
			onWorkflowChange,
			botProduct,
		]
	);
	const handleDirectorySelect = useCallback(
		(item: ComposerMenuItem) => {
			if (botProduct) {
				return;
			}
			const mention = directoryMentionGroups
				.flatMap((group) => group.items)
				.find((candidate) => `${candidate.kind}:${candidate.id}` === item.id);
			if (!mention) {
				return;
			}
			if (mention.kind === "workflow") {
				onWorkflowChange(mention.id);
				onTeamChange(null);
				onTargetAgentChange(null);
			} else if (mention.kind === "team") {
				onTeamChange(mention.id);
				onTargetAgentChange(null);
				onWorkflowChange(null);
			} else if (mention.kind === "agent") {
				onTargetAgentChange(mention.id);
				onTeamChange(null);
				onWorkflowChange(null);
			}
		},
		[
			directoryMentionGroups,
			botProduct,
			onWorkflowChange,
			onTeamChange,
			onTargetAgentChange,
		]
	);

	const handleSend = useCallback(
		(msg: { role: "user"; content: string }) => {
			if (botProduct) {
				setMentionQuery(null);
				setDismissedSlashValue(value ?? "");
				onTargetAgentChange(null);
				onTeamChange(null);
				onWorkflowChange(null);
				onSend(msg);
				return;
			}
			// A workflow mention is the most specific target — the message becomes
			// the run's input — so it wins over a team mention, which wins over an
			// agent mention.
			const workflowId = resolveFirstWorkflowMention(msg.content, allWorkflows);
			const teamId = resolveFirstNamedMentionId(msg.content, allTeams);
			if (workflowId) {
				onWorkflowChange(workflowId);
				onTeamChange(null);
				onTargetAgentChange(null);
			} else if (teamId) {
				onTeamChange(teamId);
				onTargetAgentChange(null);
				onWorkflowChange(null);
			} else {
				onTeamChange(null);
				onWorkflowChange(null);
				onTargetAgentChange(resolveFirstNamedMentionId(msg.content, allAgents));
			}
			setMentionQuery(null);
			setDismissedSlashValue(value ?? "");
			const referencedConversationIds = resolveReferencedChatIds(
				msg.content,
				mentionSources.chats,
				referencedChatIdsRef.current
			);
			const humanMentions = selectHumanNotificationTargets({
				content: msg.content,
				currentUserId,
				selected: selectedHumanMentionsRef.current,
			});
			referencedChatIdsRef.current.clear();
			selectedHumanMentionsRef.current = [];
			onReferencedChats(referencedConversationIds);
			onSend(msg);
			onHumanMentions(humanMentions, msg.content);
		},
		[
			onSend,
			allAgents,
			allTeams,
			allWorkflows,
			mentionSources.chats,
			currentUserId,
			onHumanMentions,
			onTargetAgentChange,
			onTeamChange,
			onWorkflowChange,
			onReferencedChats,
			botProduct,
		]
	);

	return (
		<div
			className="relative"
			onDragOver={(event) => {
				if (event.dataTransfer.types.includes(CHAT_REFERENCE_DRAG_MIME)) {
					event.preventDefault();
					event.stopPropagation();
					event.dataTransfer.dropEffect = "copy";
				}
			}}
			onDrop={(event) => {
				const chat = readDraggedChatReference(event.dataTransfer);
				if (!chat) {
					return;
				}
				event.preventDefault();
				event.stopPropagation();
				insertChatReference(chat);
			}}
			ref={textareaWrapRef}
		>
			{chatWidgetTemplates.length > 0 && (
				<div className="mx-auto mb-2 flex w-full max-w-[880px] flex-wrap items-center gap-1.5 px-3">
					<span className="type-caption text-muted-foreground">
						Available widgets
					</span>
					{chatWidgetTemplates.map((template) => {
						const prompt = template.examples[0] ?? template.triggers[0];
						if (!prompt) {
							return null;
						}
						return (
							<button
								className="rounded-full border border-border/70 bg-background px-2.5 py-1 text-muted-foreground text-xs transition-colors hover:bg-muted hover:text-foreground"
								key={`${template.plugin ?? "widget"}:${template.id}`}
								onClick={() => onChange?.(prompt)}
								type="button"
							>
								{template.title}
							</button>
						);
					})}
				</div>
			)}
			{!botProduct && mentionQuery !== null && (
				<MentionMenu
					anchorRef={textareaWrapRef}
					groups={mentionGroups}
					onDismiss={() => setMentionQuery(null)}
					onSelect={handleSelect}
				/>
			)}
			{slashMenu?.kind === "commands" && (
				<SlashCommandAutocomplete
					anchorRef={textareaWrapRef}
					commands={availableCommands}
					menu={slashMenu}
					mode="commands"
					onDismiss={() => setDismissedSlashValue(value ?? "")}
					onSelect={handleSelectSlash}
				/>
			)}
			{slashMenu?.kind === "arguments" && (
				<SlashCommandAutocomplete
					anchorRef={textareaWrapRef}
					menu={slashMenu}
					mode="arguments"
					onDismiss={() => setDismissedSlashValue(value ?? "")}
					onSelectArgument={handleSelectSlashArgument}
				/>
			)}
			<InputBar
				{...rest}
				composerMenuGroups={composerMenuGroups}
				composerPrompt={
					visiblePermission && onRespondPermission
						? {
								content: (
									<PermissionPrompt
										embedded
										onRespond={(optionId) =>
											onRespondPermission(visiblePermission, optionId)
										}
										permission={visiblePermission}
										showTechnicalDetails={showTechnicalPermissionDetails}
									/>
								),
								id: `permission:${visiblePermission.requestId}`,
							}
						: undefined
				}
				mentionItems={composerMentionItems}
				onChange={handleChange}
				onComposerMenuSelect={handleDirectorySelect}
				onSend={handleSend}
				onTextareaKeyDown={(event) => {
					if (
						handleComposerSettingsShortcut(
							event,
							composerSections,
							composerShortcuts
						)
					) {
						event.preventDefault();
					}
					onTextareaKeyDown?.(event);
				}}
				value={value}
			/>
		</div>
	);
}
