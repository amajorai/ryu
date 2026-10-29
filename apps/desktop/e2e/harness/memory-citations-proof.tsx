import {
	extractMemoryCitations,
	MEMORY_CITATIONS_PART,
} from "@ryu/blocks/desktop/agent-elements/memory-citations.ts";
import { MEMORY_CITATIONS_RENDERER } from "@ryu/blocks/desktop/agent-elements/message-action-types.ts";
import type {
	ContributedMessageAction,
	MessageActionRuntimeState,
} from "@ryu/blocks/desktop/agent-elements/types.ts";
import type { UIMessage } from "ai";
import { createRoot } from "react-dom/client";
import { MessageList } from "../../components/agent-elements/message-list.tsx";
import "../../src/index.css";

const ASSISTANT_MESSAGE_ID = "memory-citations-assistant";

const MEMORY_PARTS = [
	{
		data: {
			citations: [
				{
					content:
						"Keeps the Marketplace package and provenance boundary intact.",
					id: "memory-marketplace-boundary",
				},
				{
					content:
						"Prefers ordinary functionality to remain in signed Marketplace packages.",
					id: "memory-signed-packages",
				},
			],
		},
		type: MEMORY_CITATIONS_PART,
	},
] as const;

const CITATIONS = extractMemoryCitations(MEMORY_PARTS);

const MEMORY_ACTION: ContributedMessageAction = {
	args: { renderer: MEMORY_CITATIONS_RENDERER },
	icon: "lucide:brain",
	id: "memory.citations",
	kind: "button",
	label: "Memories cited",
	order: 20,
	capability: "memory.read",
	plugin: "@ryu/memory",
	target: "assistant",
};

const MESSAGES: UIMessage[] = [
	{
		id: "memory-citations-user",
		parts: [
			{
				text: "How should this Marketplace package be structured?",
				type: "text",
			},
		],
		role: "user",
	},
	{
		id: ASSISTANT_MESSAGE_ID,
		parts: [
			{
				text: "Keep the package boundary explicit: the signed Marketplace package owns ordinary functionality, while provenance stays tied to the manifest digest.",
				type: "text",
			},
			...MEMORY_PARTS,
		],
		role: "assistant",
	},
];

function MemoryCitationsProof() {
	const messageActionStates = new Map<string, MessageActionRuntimeState>([
		[ASSISTANT_MESSAGE_ID, { memoryCitations: CITATIONS }],
	]);

	return (
		<main
			className="min-h-screen bg-background px-6 py-10 text-foreground"
			data-testid="memory-citations-proof"
		>
			<div className="mx-auto flex w-full max-w-4xl flex-col gap-6">
				<header className="space-y-2">
					<p className="font-medium text-muted-foreground text-xs uppercase tracking-(--tracking-section)">
						@RYU/MEMORY · DESKTOP CHAT
					</p>
					<h1 className="font-semibold text-3xl tracking-tight">
						See which memories shaped a reply.
					</h1>
					<p className="max-w-2xl text-muted-foreground text-sm">
						The Memory app registers the assistant toolbar action. Hover the
						settled reply and open the book icon to inspect the facts carried
						into this turn.
					</p>
				</header>

				<section className="overflow-hidden rounded-3xl border border-border/70 bg-card/40 shadow-sm">
					<div className="flex items-center justify-between border-border/60 border-b px-5 py-4">
						<div>
							<p className="font-medium text-sm">Native chat transcript</p>
							<p className="text-muted-foreground text-xs">
								The action is hidden on turns without built-in memory context.
							</p>
						</div>
						<span className="rounded-full bg-primary/10 px-2.5 py-1 text-primary text-xs">
							Memory action loaded
						</span>
					</div>
					<div className="h-[370px] min-h-0">
						<MessageList
							conversationKey="memory-citations-proof"
							currentUser={{ id: "me", name: "You" }}
							initialScrollBehavior="top"
							messageActionStates={messageActionStates}
							messageActions={[MEMORY_ACTION]}
							messages={MESSAGES}
							status="ready"
						/>
					</div>
				</section>
			</div>
		</main>
	);
}

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(<MemoryCitationsProof />);
}
