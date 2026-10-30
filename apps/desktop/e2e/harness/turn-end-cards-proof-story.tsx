// Real-browser proof for the completed assistant-turn result surfaces: edited
// file summaries, end-of-turn JSON UI, safe web links, and artifact affordances.

import {
	ArtifactHostContext,
	type ArtifactHostValue,
} from "@ryu/blocks/desktop/agent-elements/artifact-host-context.tsx";
import { ChatDisplayPrefsProvider } from "@ryu/blocks/desktop/agent-elements/chat-display-prefs.tsx";
import type {
	FileEditsTurnEndCard,
	FileEditUndoPlan,
} from "@ryu/blocks/desktop/agent-elements/turn-end-cards.ts";
import { TurnEndCards } from "@ryu/blocks/desktop/agent-elements/turn-end-cards.tsx";
import type { UIMessage } from "ai";
import { useCallback, useState } from "react";
import { createRoot } from "react-dom/client";
import { AgentChat } from "../../components/agent-elements/agent-chat.tsx";
import { InlineArtifact } from "../../src/components/chat/InlineArtifact.tsx";
import "../../src/index.css";

const releaseSpec = {
	elements: {
		card: {
			children: ["body"],
			props: { title: "Release reference" },
			type: "Card",
		},
		body: {
			children: ["summary", "link"],
			props: { gap: "sm" },
			type: "Stack",
		},
		link: {
			children: [],
			props: {
				description: "Open the public release guide in a new tab.",
				href: "https://example.com/release-guide",
				title: "Public release guide",
			},
			type: "LinkPreview",
		},
		summary: {
			children: [],
			props: {
				muted: true,
				text: "The completed release checklist is ready for review.",
			},
			type: "Text",
		},
	},
	root: "card",
};

const a2uiEndOfTurnSpec = [
	{
		version: "v0.9",
		createSurface: {
			surfaceId: "turn-end-a2ui",
			catalogId:
				"https://a2ui.org/specification/v0_9/catalogs/basic/catalog.json",
		},
	},
	{
		version: "v0.9",
		updateComponents: {
			surfaceId: "turn-end-a2ui",
			components: [
				{
					id: "root",
					component: "Column",
					children: ["title", "status", "submit"],
				},
				{
					id: "title",
					component: "Text",
					text: "A2UI end-of-turn card",
					variant: "h2",
				},
				{
					id: "status",
					component: "Text",
					text: { path: "/status" },
				},
				{
					id: "submit_label",
					component: "Text",
					text: "Confirm A2UI",
				},
				{
					action: {
						event: {
							context: { status: { path: "/status" } },
							name: "confirm_end_of_turn",
						},
					},
					child: "submit_label",
					component: "Button",
					id: "submit",
				},
			],
		},
	},
	{
		version: "v0.9",
		updateDataModel: {
			surfaceId: "turn-end-a2ui",
			path: "/status",
			value: "Preserved through turn-end persistence",
		},
	},
] as const;

const messages: UIMessage[] = [
	{
		id: "turn-end-user",
		parts: [
			{
				text: "Please prepare the release notes and leave the final references here.",
				type: "text",
			},
		],
		role: "user",
	},
	{
		id: "turn-end-assistant",
		parts: [
			{
				text: "I updated the workspace and kept the completed result cards at the end of this turn.",
				type: "text",
			},
			{
				input: {
					file_path: "apps/desktop/src/pages/ChatPage.tsx",
					new_string: "ready\nverified",
					old_string: "draft",
				},
				output: null,
				toolCallId: "turn-end-proof-1",
				state: "output-available",
				type: "tool-Edit",
			},
			{
				input: {
					content: "release\nnotes",
					file_path: "docs/release-notes.md",
				},
				output: null,
				toolCallId: "turn-end-proof-2",
				state: "output-available",
				type: "tool-Write",
			},
			{
				input: {
					file_path:
						"packages/blocks/src/desktop/agent-elements/message-list.tsx",
					new_string: "new\nline\nproof",
					old_string: "old\nline",
				},
				output: null,
				toolCallId: "turn-end-proof-3",
				state: "output-available",
				type: "tool-Edit",
			},
			{
				input: {
					patch:
						"*** Begin Patch\n*** Add File: apps/core/src/sidecar/mcp/README.md\n+end-of-turn proof\n*** End Patch",
				},
				output: null,
				toolCallId: "turn-end-proof-4",
				state: "output-available",
				type: "dynamic-tool",
				toolName: "apply_patch",
			},
			{
				input: {
					placement: "turn-end",
					spec: releaseSpec,
					title: "JSON mention card",
				},
				output: null,
				toolCallId: "turn-end-proof-5",
				state: "output-available",
				type: "tool-ui.render",
			},
			{
				input: {
					format: "a2ui",
					placement: "turn-end",
					spec: a2uiEndOfTurnSpec,
					title: "A2UI end-of-turn card",
				},
				output: null,
				toolCallId: "turn-end-proof-6",
				state: "output-available",
				type: "tool-ui.render",
			},
			{
				input: {
					artifact: {
						content: "# Release checklist\n\nReady for review.",
						kind: "code",
						language: "markdown",
						title: "release-checklist.md",
					},
					placement: "turn-end",
				},
				output: null,
				toolCallId: "turn-end-proof-7",
				state: "output-available",
				type: "tool-artifact.render",
			},
		],
		role: "assistant",
	},
];

const singleFileCard: FileEditsTurnEndCard = {
	files: [{ deletions: 0, insertions: 1, path: ".env" }],
	id: "single-file",
	kind: "file-edits",
	undoPlan: {
		edits: [
			{
				after: "TOKEN=new",
				before: "TOKEN=old",
				kind: "replace",
				path: ".env",
			},
		],
		kind: "text-replacements",
	},
};

function Story() {
	const [action, setAction] = useState("No card action yet");
	const artifactHostValue: ArtifactHostValue = {
		Renderer: InlineArtifact,
		fetchContent: async (payload) => payload.content ?? null,
		openInPanel: (_payload, id) => setAction(`Opened artifact ${id} in panel`),
		openInTab: (_payload, id) => setAction(`Opened artifact ${id} in tab`),
		submitFollowUp: (text) => setAction(`Follow-up: ${text}`),
	};
	// Stable like ChatPage's `handleUndoFileEdits`: the card scopes an undo to
	// the handler that started it, so a new handler identity on every render
	// would drop the finished undo's "Undone" state.
	const handleUndo = useCallback(async (plan: FileEditUndoPlan) => {
		setAction(`Undid ${plan.edits.map((edit) => edit.path).join(", ")}`);
	}, []);

	return (
		<div className="min-h-screen bg-muted/30 text-foreground">
			<header className="border-border/70 border-b bg-background/90 px-6 py-5 backdrop-blur">
				<div className="mx-auto flex max-w-4xl items-end justify-between gap-4">
					<div>
						<p className="font-semibold text-primary text-xs uppercase tracking-(--tracking-section)">
							Chat history proof
						</p>
						<h1 className="mt-1 font-semibold text-2xl tracking-tight">
							Completed turn cards
						</h1>
						<p className="mt-1 max-w-2xl text-muted-foreground text-sm">
							Edited files and agent-authored result cards stay together at the
							end of a completed assistant turn.
						</p>
					</div>
					<output
						aria-live="polite"
						className="hidden rounded-full bg-muted px-3 py-1.5 text-muted-foreground text-xs sm:block"
						data-testid="action-state"
					>
						{action}
					</output>
				</div>
			</header>
			<main className="mx-auto h-[calc(100vh-108px)] max-w-4xl px-4 py-4 sm:px-6">
				<ChatDisplayPrefsProvider value={{ hideToolDetail: true }}>
					<ArtifactHostContext.Provider value={artifactHostValue}>
						<div className="space-y-4">
							<AgentChat
								conversationKey="turn-end-cards-proof"
								currentUser={{ id: "proof-user", name: "You" }}
								initialScrollBehavior="bottom"
								messages={messages}
								onAgentUiSubmit={() => setAction("JSON UI submitted")}
								onOpenFile={(path) => setAction(`Opened ${path}`)}
								onReviewFileEdits={(paths) =>
									setAction(`Reviewing ${paths.join(", ")}`)
								}
								onSend={() => undefined}
								onStop={() => undefined}
								onUndoFileEdits={handleUndo}
								status="ready"
							/>
							<section aria-label="Undo proof">
								<TurnEndCards
									cards={[singleFileCard]}
									onOpenFile={(path) => setAction(`Opened ${path}`)}
									onReviewFileEdits={() => setAction("Reviewing Last turn")}
									onUndoFileEdits={handleUndo}
								/>
							</section>
						</div>
					</ArtifactHostContext.Provider>
				</ChatDisplayPrefsProvider>
			</main>
		</div>
	);
}

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(<Story />);
}
