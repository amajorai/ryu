import { CONTEXT_PANEL_STATS } from "./chat-page-native-http-context.ts";
import { REACTION_MESSAGE_ID } from "./chat-page-native-http-reactions.ts";
export const CONVERSATION_ID = "conversation-toolbar-share-fixture";
export const CONVERSATION_TITLE = "Toolbar share regression fixture";
export const OWNER_ID = "share-owner";
export const EARLIER_THREAD_ID = "conversation-earlier-thread-fixture";
export const LATEST_THREAD_ID = "conversation-latest-thread-fixture";
export const WORKSPACE_PATH = "/tmp/ryu-chat-controls-project";
// The Side Chats plugin's chat feature and a saved side chat on each thread,
// for the `side-chat-sidebar` scenario.
interface SavedSideChat {
	answer: string;
	conversation_id: string;
	created_at: number;
	id: string;
	model: string;
	question: string;
}
export const SIDE_CHATS_FEATURE = {
	command: "/btw",
	context: "main-chat",
	id: "side-chats",
	kind: "side-chat",
	persistence: "parent-conversation",
	plugin: "@ryu/side-chats",
};
// The Ghost Chats plugin's chat feature, as its manifest declares it: it is what
// offers the "Temporary chat" row in the composer's "+" menu.
export const GHOST_CHATS_FEATURE = {
	id: "ghost-chats",
	kind: "ghost-chat",
	persistence: "none",
	plugin: "@ryu/ghost-chats",
	renderer: "temporary-chat",
	scope: "current-tab",
};
// One saved side chat per thread, keyed by the conversation it belongs to.
export const SAVED_SIDE_CHATS: Record<string, SavedSideChat> = {
	[CONVERSATION_ID]: {
		answer: "The share plan is ready for the organization.",
		conversation_id: CONVERSATION_ID,
		created_at: 1_724_000_030_000,
		id: "saved-side-chat-original",
		model: "fixture-side-model",
		question: "What is left before sharing?",
	},
	[EARLIER_THREAD_ID]: {
		answer: "The earlier thread kept the launch notes.",
		conversation_id: EARLIER_THREAD_ID,
		created_at: 1_724_000_040_000,
		id: "saved-side-chat-earlier",
		model: "fixture-side-model",
		question: "What did the earlier thread decide?",
	},
};
// The agent's `tasks.suggest` call on its finished turn, as Core persists it: a
// typed `tool-tasks.suggest` part whose output the client ignores. `bare` is the
// same thread with no project folder and the Drafts app off.
// `task-suggestion-agent` additionally runs the thread on a second agent (not the
// default a new chat picks), so the agent a Start carries over is observable.
// `task-suggestion-temporary` is a blank new chat (no thread yet) with the Drafts
// app on and the Ghost Chats plugin enabled, so a temporary chat can be turned on
// and its live turn can suggest a task.
export const TASK_SUGGESTION_SCENARIOS = [
	"task-suggestion",
	"task-suggestion-agent",
	"task-suggestion-bare",
	"task-suggestion-temporary",
] as const;
// Where the global project selection points in the suggestion scenarios, apart
// from the thread's own project folder, so a Start that did not carry the
// thread's folder over would run in this one.
export const OTHER_WORKSPACE_PATH = "/tmp/ryu-other-project";
// The scenarios with a project folder and the Drafts app enabled.
export const TASK_SUGGESTION_WITH_DRAFTS = [
	"task-suggestion",
	"task-suggestion-agent",
	"task-suggestion-temporary",
] as const;
export const SUGGESTED_TASK = {
	callId: "suggest-call-fixture",
	description: "The cooldown error escapes as a 500.",
	prompt:
		"Map the step-up email cooldown error to a 429 in the router and add a test.",
	title: "Answer step-up email cooldown with 429",
} as const;
// The suggestion a live turn makes mid-turn (see the live-chat fixture), apart
// from the finished turn's `SUGGESTED_TASK` so the two cannot be mistaken.
export const LIVE_SUGGESTED_TASK = {
	callId: "suggest-call-live-fixture",
	description: "The cooldown copy is missing from the sign-in email.",
	prompt: "Add the cooldown wait time to the step-up email body and a test.",
	title: "Show the cooldown wait in the step-up email",
} as const;
// The `task-suggestion` thread after a follow-up another client asked on it, as
// Core persists it. While that turn runs, Core has stored the question and no
// answer yet; once it finishes, the answer is stored with the turn's own
// `tasks.suggest` call (the live-chat fixture's `LIVE_SUGGESTED_TASK`) before
// its text, the order the turn streamed them in.
export const REATTACHED_TURN_PROMPT = "Is there anything else worth fixing?";
export const REATTACHED_TURN_ANSWER = "Owned live response in progress.";
export function reattachedTurnHistory(phase: "running" | "finished") {
	const finishedTurn = createChatPageProofDtos("task-suggestion").messageRows;
	const question = {
		author_user_id: OWNER_ID,
		content: REATTACHED_TURN_PROMPT,
		created_at: 1_724_000_020_000,
		id: "reattached-turn-user-message",
		role: "user",
	};
	if (phase === "running") {
		return [...finishedTurn, question];
	}
	return [
		...finishedTurn,
		question,
		{
			content: REATTACHED_TURN_ANSWER,
			created_at: 1_724_000_030_000,
			id: "reattached-turn-assistant-message",
			parts: [
				{
					input: {
						description: LIVE_SUGGESTED_TASK.description,
						prompt: LIVE_SUGGESTED_TASK.prompt,
						title: LIVE_SUGGESTED_TASK.title,
					},
					output: { ok: true },
					state: "output-available",
					toolCallId: LIVE_SUGGESTED_TASK.callId,
					type: "tool-tasks.suggest",
				},
				{ text: REATTACHED_TURN_ANSWER, type: "text" },
			],
			role: "assistant",
		},
	];
}
// Tab-label scenarios: what the tab strip shows for a tab the page has, or has not
// yet, taken over. `tab-label-blank` is a new chat that was opened with a name of
// its own, and `tab-label-empty-thread` is a tab on a conversation whose label is
// out of date and whose history holds no message.
export const TAB_LABEL_BLANK_TITLE = "Opened with its own name";
export const TAB_LABEL_STALE_TITLE = "Label from before the rename";
export function createChatPageProofDtos(scenario: string) {
	const taskSuggestionScenario = (
		TASK_SUGGESTION_SCENARIOS as readonly string[]
	).includes(scenario);
	const mergedThreadScenario = [
		"merged-thread-picker",
		"merged-thread-review",
	].includes(scenario);
	const currentConversationId = mergedThreadScenario
		? LATEST_THREAD_ID
		: CONVERSATION_ID;
	const currentConversationTitle = mergedThreadScenario
		? "Latest project thread"
		: CONVERSATION_TITLE;
	const defaultMessageRows = [
		{
			author_user_id: OWNER_ID,
			content: "We need to share the launch plan with the organization.",
			created_at: 1_724_000_000_000,
			id: "toolbar-share-user-message",
			role: "user",
		},
		{
			content: "The organization copy is ready for review.",
			created_at: 1_724_000_010_000,
			id:
				scenario === "message-reactions-caller"
					? REACTION_MESSAGE_ID
					: "toolbar-share-assistant-message",
			role: "assistant",
			...(scenario === "context-breakdown-caller" ||
			scenario === "context-breakdown-empty"
				? {
						parts: [
							{
								type: "text",
								text: "The organization copy is ready for review.",
							},
							{ type: "data-ryu-stats", data: CONTEXT_PANEL_STATS },
						],
					}
				: {}),
		},
	];
	const scenarioMessageRows = taskSuggestionScenario
		? [
				defaultMessageRows[0],
				{
					...defaultMessageRows[1],
					content: "The organization copy is ready for review.",
					parts: [
						{
							text: "The organization copy is ready for review.",
							type: "text",
						},
						{
							input: {
								description: SUGGESTED_TASK.description,
								prompt: SUGGESTED_TASK.prompt,
								title: SUGGESTED_TASK.title,
							},
							output: { ok: true },
							state: "output-available",
							toolCallId: SUGGESTED_TASK.callId,
							type: "tool-tasks.suggest",
						},
					],
				},
			]
		: scenario === "dismiss-plugin-note"
			? [
					defaultMessageRows[0],
					{
						...defaultMessageRows[1],
						parts: [
							{
								text: "The organization copy is ready for review.",
								type: "text",
							},
							{
								data: {
									question: "Review before sharing",
									text: "Review this launch plan before sharing.",
								},
								id: "plugin-note-fixture",
								type: "data-plugin_note",
							},
						],
					},
				]
			: defaultMessageRows;
	// An empty history: the conversation exists and has a title, but no message.
	const messageRows =
		scenario === "tab-label-empty-thread"
			? scenarioMessageRows.slice(0, 0)
			: scenarioMessageRows;

	const earlierThreadMessages = [
		{
			content: "This belongs to the earlier project thread.",
			created_at: 1_724_000_000_000,
			id: "earlier-thread-message",
			role: "user",
		},
		{
			content: "Earlier work is still readable here.",
			created_at: 1_724_000_010_000,
			id: "earlier-thread-reply",
			role: "assistant",
		},
	];
	const latestThreadMessages = [
		{
			content: "This is the most recent project thread.",
			created_at: 1_724_000_020_000,
			id: "latest-thread-message",
			role: "user",
		},
		{
			content: "Continue the current project work here.",
			created_at: 1_724_000_030_000,
			id: "latest-thread-reply",
			role: "assistant",
		},
	];

	const composerControls =
		scenario === "composer-controls"
			? [
					{
						default: "balanced",
						flag: "response_mode",
						id: "response-mode",
						label: "Response mode",
						options: [
							{ label: "Balanced", value: "balanced" },
							{ label: "Precise", value: "precise" },
						],
						placement: "bar",
						plugin: "com.ryu.test-tools",
						type: "select",
					},
					{
						flag: "current_run",
						id: "current-run",
						label: "Current run",
						plugin: "com.ryu.test-tools",
						source: {
							http: { path: "/api/ext/com.ryu.test-tools/current-run" },
							items: "items",
						},
						type: "chip",
					},
					{
						args: { stage: "toolbar-regression" },
						capability: "checks.run",
						flag: "run_checks",
						id: "run-checks",
						label: "Run checks",
						placement: "bar",
						plugin: "com.ryu.test-tools",
						type: "action",
					},
				]
			: [];

	const historyPreview = {
		checkpointId: "a".repeat(64),
		repoAvailable: false,
		repoError: "No project repository is attached to this fixture.",
		repoRoot: null,
		redactions: { custom: 0, pii: 0, secrets: 0 },
		transcript: {
			agentId: null,
			branch: null,
			codeCommit: null,
			createdAt: "2024-08-19T00:00:00.000Z",
			format: "ryu-portable-conversation",
			messages: messageRows.map((message) => ({
				agentId: null,
				content: message.content,
				createdAt: new Date(message.created_at).toISOString(),
				id: message.id,
				role: message.role,
			})),
			omittedStructuredParts: 0,
			redactionPolicy: "locked-sensitive-v1",
			sourceId: "b".repeat(64),
			title: currentConversationTitle,
			updatedAt: "2024-08-19T00:00:10.000Z",
			version: 1,
		},
	};

	function conversationSummary(
		id: string,
		title: string,
		updatedAt: number,
		agentId: string | null = null
	) {
		return {
			agent_id: agentId,
			archived: false,
			branch: null,
			created_at: 1_724_000_000_000,
			folder_path: [
				"worktree-handoff",
				"undo-file-edits",
				"review-pane",
				"merged-thread-review",
				...TASK_SUGGESTION_WITH_DRAFTS,
			].includes(scenario)
				? WORKSPACE_PATH
				: null,
			id,
			last_message_at: updatedAt,
			message_count: 2,
			run_status: null,
			title,
			updated_at: updatedAt,
			worktree_path: null,
		};
	}

	const conversationSummaries = mergedThreadScenario
		? [
				conversationSummary(
					LATEST_THREAD_ID,
					"Latest project thread",
					1_724_000_030_000,
					"agent-fixture"
				),
				conversationSummary(
					EARLIER_THREAD_ID,
					"Earlier project thread",
					1_724_000_010_000,
					"agent-fixture"
				),
			]
		: [
				conversationSummary(
					currentConversationId,
					currentConversationTitle,
					1_724_000_010_000,
					// The suggested-task thread runs an agent that is not the default.
					scenario === "task-suggestion-agent"
						? "agent-second"
						: [
									"copy-transcript",
									"model-selection-caller",
									"blocked-messages",
								].includes(scenario)
							? "agent-fixture"
							: null
				),
			];

	// Two retained chats. In `blocked-messages` the original thread is pinned to
	// the gateway-transport fixture agent, so its composer blocks whenever the
	// gateway is unreachable. `review-pane` is the same pair with both threads
	// owned by the project folder, so a file-edits card can open its review pane.
	// `side-chat-sidebar` is the same pair with the Side Chats plugin enabled and
	// a saved side chat on each thread.
	if (
		[
			"queue-isolation",
			"blocked-messages",
			"review-pane",
			"side-chat-sidebar",
		].includes(scenario)
	) {
		conversationSummaries.push(
			conversationSummary(
				EARLIER_THREAD_ID,
				"Earlier project thread",
				1_724_000_020_000
			)
		);
	}

	const pluginCompanions =
		scenario === "drawesome-dialog"
			? [
					{
						approved_grants: [],
						first_party: true,
						has_ui: true,
						id: "app__drawesome-companion",
						label: "Drawesome",
						name: "Drawesome",
						plugin_id: "@ryu/drawesome",
					},
				]
			: [];

	return {
		messageRows,
		earlierThreadMessages,
		latestThreadMessages,
		composerControls,
		historyPreview,
		conversationSummaries,
		pluginCompanions,
		conversationSummary,
		currentConversationId,
	};
}
