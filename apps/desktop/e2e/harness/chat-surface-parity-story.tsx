// Browser proof for the shared chat surface contract. Each card mounts the real
// AgentChat, InputBar, message navigation rail, mention token, and tool renderer.

import type { UIMessage } from "ai";
import { createRoot } from "react-dom/client";
import { AgentChat } from "../../components/agent-elements/agent-chat.tsx";
import type {
	ComposerMenuGroup,
	ComposerMenuItem,
} from "../../components/agent-elements/input/composer-menu.tsx";
import type { MentionItem } from "../../components/agent-elements/types.ts";
import "../../src/index.css";

const TURN_COUNT = 22;

const mentionItems: MentionItem[] = [
	{
		accentColor: "#7c3aed",
		id: "ryu",
		kind: "agent",
		label: "Ryu",
	},
	{
		accentColor: "#0f766e",
		id: "research",
		kind: "app",
		label: "Research",
	},
];

const composerMenuGroups: ComposerMenuGroup[] = [
	{
		id: "shared-directory",
		items: [
			{
				description: "Ask the same assistant from any chat surface",
				id: "directory:ryu",
				keywords: ["assistant", "agent", "chat"],
				label: "Ryu",
			},
			{
				description: "Search across connected sources",
				id: "directory:research",
				keywords: ["sources", "web", "search"],
				label: "Research",
			},
		],
		label: "Shared directory",
	},
];

const sharedUiSpec = {
	elements: {
		badge: {
			children: [],
			props: { text: "Shared renderer" },
			type: "Badge",
		},
		body: {
			children: ["summary", "progress", "badge"],
			props: { gap: "sm" },
			type: "Stack",
		},
		card: {
			children: ["body"],
			props: { title: "Shared JSON UI" },
			type: "Card",
		},
		progress: {
			children: [],
			props: { value: 72 },
			type: "Progress",
		},
		summary: {
			children: [],
			props: { muted: true, text: "Rendered by the same tool UI contract" },
			type: "Text",
		},
	},
	root: "card",
};

const sharedA2uiSpec = [
	{
		version: "v0.9",
		createSurface: {
			surfaceId: "shared-a2ui",
			catalogId:
				"https://a2ui.org/specification/v0_9/catalogs/basic/catalog.json",
		},
	},
	{
		version: "v0.9",
		updateComponents: {
			surfaceId: "shared-a2ui",
			components: [
				{
					id: "root",
					component: "Column",
					children: ["title", "message"],
				},
				{
					id: "title",
					component: "Text",
					text: "A2UI shared preview",
					variant: "h2",
				},
				{
					id: "message",
					component: "Text",
					text: { path: "/message" },
				},
			],
		},
	},
	{
		version: "v0.9",
		updateDataModel: {
			surfaceId: "shared-a2ui",
			path: "/message",
			value: "Mapped into Ryu's native catalog",
		},
	},
] as const;

function buildHistory(surfaceId: string): UIMessage[] {
	const messages: UIMessage[] = [];
	for (let index = 0; index < TURN_COUNT; index += 1) {
		messages.push({
			id: `${surfaceId}-user-${index}`,
			parts: [
				{
					text:
						index === TURN_COUNT - 1
							? "@Ryu show the shared surface contract here"
							: `Turn ${index + 1}: keep this shared chat surface easy to scan`,
					type: "text",
				},
			],
			role: "user",
		});
		messages.push({
			id: `${surfaceId}-assistant-${index}`,
			parts:
				index === TURN_COUNT - 1
					? [
							{
								text: "The transcript, composer, and tool UI stay on the shared primitives.",
								type: "text",
							},
							{
								input: { spec: sharedUiSpec, title: "Tool UI preview" },
								state: "output-available",
								output: null,
								toolCallId: `${surfaceId}-ui-render`,
								type: "tool-ui.render",
							},
							{
								input: {
									format: "a2ui",
									spec: sharedA2uiSpec,
									title: "A2UI tool preview",
								},
								state: "output-available",
								output: null,
								toolCallId: `${surfaceId}-a2ui-render`,
								type: "tool-ui.render",
							},
						]
					: [
							{
								text: `Reply ${index + 1}: this history keeps the preview rail populated in every surface.`,
								type: "text",
							},
						],
			role: "assistant",
		});
	}
	return messages;
}

interface SurfaceCardProps {
	density?: "comfortable" | "compact";
	label: string;
	surfaceId: string;
}

function SurfaceCard({ density, label, surfaceId }: SurfaceCardProps) {
	const messages = buildHistory(surfaceId);
	const handleComposerMenuSelect = (_item: ComposerMenuItem) => {
		// The shared InputBar owns insertion; this callback proves the host hook is
		// available on every surface without coupling the fixture to app state.
	};

	return (
		<section
			className="flex h-[27rem] min-h-0 flex-col overflow-hidden rounded-3xl border border-border/70 bg-background shadow-sm"
			data-surface={surfaceId}
			data-testid={`surface-${surfaceId}`}
		>
			<div className="flex shrink-0 items-center justify-between border-border/60 border-b px-4 py-3">
				<div>
					<p className="font-medium text-sm">{label}</p>
					<p className="text-muted-foreground text-xs">
						Shared transcript · composer · tool renderer
					</p>
				</div>
				<span className="type-compact rounded-full bg-muted px-2 py-1 text-muted-foreground">
					{density === "compact" ? "compact" : "comfortable"}
				</span>
			</div>
			<div className="min-h-0 flex-1">
				<AgentChat
					composerMenuGroups={composerMenuGroups}
					conversationKey={surfaceId}
					currentUser={{ id: "me", name: "You" }}
					density={density}
					emptyStatePosition="center"
					mentionItems={mentionItems}
					messages={messages}
					onAgentUiSubmit={() => undefined}
					onComposerMenuSelect={handleComposerMenuSelect}
					onSend={() => undefined}
					onStop={() => undefined}
					seedDraft="@Ryu review this shared surface"
					status="ready"
				/>
			</div>
		</section>
	);
}

function Story() {
	return (
		<main className="min-h-screen bg-muted/30 px-5 py-6 text-foreground sm:px-8">
			<div className="mx-auto max-w-[1440px]">
				<div className="mb-5 flex items-end justify-between gap-4">
					<div>
						<p className="font-semibold text-primary text-xs uppercase tracking-(--tracking-section)">
							Ryu chat surfaces
						</p>
						<h1 className="mt-1 font-semibold text-2xl tracking-tight">
							One set of chat primitives
						</h1>
						<p className="mt-1 max-w-2xl text-muted-foreground text-sm">
							The preview rail, tool UI JSON renderer, mention tokens, and
							searchable composer directory stay consistent across the main and
							compact surfaces.
						</p>
					</div>
					<div
						className="hidden rounded-2xl border border-border/70 bg-background px-3 py-2 text-right text-muted-foreground text-xs shadow-sm sm:block"
						data-testid="surface-state"
					>
						<div className="font-medium text-foreground">
							4 surfaces · 22 turns
						</div>
						<div>rail + @ token + + menu + ui.render</div>
					</div>
				</div>
				<div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
					<SurfaceCard label="Desktop chat" surfaceId="desktop" />
					<SurfaceCard label="Ryu floating assistant" surfaceId="floating" />
					<SurfaceCard
						density="compact"
						label="Island mini chat"
						surfaceId="island"
					/>
					<SurfaceCard density="compact" label="Side chat" surfaceId="side" />
				</div>
			</div>
		</main>
	);
}

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(<Story />);
}
