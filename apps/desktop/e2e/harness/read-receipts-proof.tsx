import type { MessageReadReceiptState } from "@ryu/blocks/desktop/agent-elements/message-read-receipt.tsx";
import type { UIMessage } from "ai";
import { useMemo } from "react";
import { createRoot } from "react-dom/client";
import { AgentChat } from "../../components/agent-elements/agent-chat.tsx";
import { ChatDisplayPrefs } from "../../src/components/chat/ChatDisplayPrefsProvider.tsx";
import type { createMessageDecorator } from "../../src/lib/chat-message-decoration.ts";
import "../../src/index.css";

type DatedFixtureMessage = ReturnType<
	ReturnType<typeof createMessageDecorator<UIMessage>>
>[number];

const ALEX_AVATAR =
	"https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=96&q=80";

const MESSAGES = [
	{
		createdAt: new Date("2026-09-14T09:30:00.000Z"),
		id: "read-receipt-sent",
		metadata: {
			author: { id: "me", name: "You" },
		},
		parts: [{ text: "I have shared the rollout checklist.", type: "text" }],
		role: "user",
	},
	{
		createdAt: new Date("2026-09-14T09:31:00.000Z"),
		id: "read-receipt-reply",
		parts: [
			{
				text: "Thanks — I will check the production handoff and report back.",
				type: "text",
			},
		],
		role: "user",
		metadata: {
			author: { id: "alex", name: "Alex Chen" },
		},
	},
	{
		createdAt: new Date("2026-09-14T09:32:00.000Z"),
		id: "read-receipt-assistant",
		parts: [
			{
				text: "The checklist is ready for the final team review.",
				type: "text",
			},
		],
		role: "assistant",
	},
	{
		createdAt: new Date("2026-09-14T09:33:00.000Z"),
		id: "read-receipt-read",
		parts: [{ text: "Perfect. I am marking the handoff ready.", type: "text" }],
		role: "user",
	},
] satisfies DatedFixtureMessage[];

function AvatarMark({ letter }: { letter: string }) {
	return (
		<span
			aria-hidden="true"
			className="flex size-full items-center justify-center rounded-full bg-primary/12 font-semibold text-primary text-xs"
		>
			{letter}
		</span>
	);
}

function ReadReceiptsProof() {
	const readReceipts = useMemo<ReadonlyMap<string, MessageReadReceiptState>>(
		() =>
			new Map([
				["read-receipt-sent", { delivered: true, readers: [] }],
				[
					"read-receipt-reply",
					{
						delivered: true,
						readers: [
							{
								avatar: ALEX_AVATAR,
								id: "alex",
								name: "Alex Chen",
							},
							{ id: "me", name: "You" },
						],
					},
				],
				[
					"read-receipt-read",
					{
						delivered: true,
						readers: [{ id: "alex", name: "Alex Chen", avatar: ALEX_AVATAR }],
					},
				],
			]),
		[]
	);

	return (
		<main
			className="min-h-screen bg-background px-5 py-8 text-foreground sm:px-8 sm:py-12"
			data-testid="read-receipts-proof"
		>
			<div className="mx-auto max-w-4xl space-y-6">
				<header className="max-w-3xl space-y-2">
					<p className="font-medium text-muted-foreground text-xs uppercase tracking-(--tracking-section)">
						TEAM CHAT · READ RECEIPTS
					</p>
					<h1 className="font-semibold text-3xl tracking-tight">
						See who has seen every handoff
					</h1>
					<p className="text-muted-foreground text-sm">
						The sender gets a single tick after persistence. A teammate reading
						the message upgrades it to double ticks and adds their avatar;
						select the stack to inspect the full reader list.
					</p>
				</header>

				<section
					aria-label="Team chat read receipt preview"
					className="h-[620px] overflow-hidden rounded-3xl border border-border/70 bg-card/40 shadow-sm"
				>
					<ChatDisplayPrefs>
						<AgentChat
							assistantAvatar={<AvatarMark letter="R" />}
							assistantName="Ryu"
							currentUser={{ id: "me", name: "You" }}
							initialScrollBehavior="top"
							messageReadReceipts={readReceipts}
							messages={MESSAGES}
							onSend={() => undefined}
							onStop={() => undefined}
							showCopyToolbar={false}
							status="ready"
						/>
					</ChatDisplayPrefs>
				</section>

				<div className="flex flex-wrap items-center gap-3 text-muted-foreground text-xs">
					<span className="inline-flex items-center gap-1.5">
						<span className="size-1.5 rounded-full bg-muted-foreground/50" />
						Single tick · persisted
					</span>
					<span className="inline-flex items-center gap-1.5">
						<span className="size-1.5 rounded-full bg-status-info" />
						Double tick + avatars · seen
					</span>
				</div>
			</div>
		</main>
	);
}

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(<ReadReceiptsProof />);
}
