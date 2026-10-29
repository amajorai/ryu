import type {
	ContributedMessageAction,
	MessageActionRuntimeState,
} from "@ryu/blocks/desktop/agent-elements/types.ts";
import { MarketplacePassPlanCard } from "@ryu/blocks/web/pricing.tsx";
import StoreCatalogCard from "@ryu/marketplace/catalog/chrome/store-catalog-card";
import {
	Card,
	CardContent,
	CardHeader,
	CardTitle,
} from "@ryu/ui/components/card.tsx";
import type { UIMessage } from "ai";
import { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import type { MessageReactionBucket } from "../../../../packages/blocks/src/desktop/agent-elements/message-reactions.tsx";
import { MessageList } from "../../components/agent-elements/message-list.tsx";
import { ChatDisplayPrefs } from "../../src/components/chat/ChatDisplayPrefsProvider.tsx";
import "../../src/index.css";

const USER_MESSAGE_IDS = [
	"0198b6fb-8ee1-7f4e-9a9e-3e0de0e78c61",
	"0198b6fb-8ee1-7f4e-9a9e-3e0de0e78c62",
	"0198b6fb-8ee1-7f4e-9a9e-3e0de0e78c63",
] as const;
const ASSISTANT_MESSAGE_IDS = [
	"0198b6fb-8ee1-7f4e-9a9e-3e0de0e78c64",
	"0198b6fb-8ee1-7f4e-9a9e-3e0de0e78c65",
	"0198b6fb-8ee1-7f4e-9a9e-3e0de0e78c66",
] as const;

const REACTION_ACTION: ContributedMessageAction = {
	args: {
		dispatch: "reactions.toggle",
		renderer: "reaction-picker",
	},
	capability: "reactions.toggle",
	icon: "smile",
	id: "reactions.picker",
	kind: "menu",
	label: "Add reaction",
	order: 100,
	plugin: "@ryu/reactions",
	target: "any",
};

const MESSAGES: UIMessage[] = [
	{
		id: USER_MESSAGE_IDS[0],
		parts: [{ text: "Can you check the deployment notes?", type: "text" }],
		role: "user",
	},
	{
		id: USER_MESSAGE_IDS[1],
		parts: [{ text: "I am sending the follow-up details now.", type: "text" }],
		role: "user",
	},
	{
		id: USER_MESSAGE_IDS[2],
		parts: [
			{ text: "Please keep these three messages together.", type: "text" },
		],
		role: "user",
	},
	{
		id: ASSISTANT_MESSAGE_IDS[0],
		parts: [{ text: "The deployment notes are clear.", type: "text" }],
		role: "assistant",
	},
	{
		id: ASSISTANT_MESSAGE_IDS[1],
		parts: [
			{
				text: "The retry policy is documented beside the release steps.",
				type: "text",
			},
		],
		role: "assistant",
	},
	{
		id: ASSISTANT_MESSAGE_IDS[2],
		parts: [
			{
				text: "I would ship this sequence as one coherent answer.",
				type: "text",
			},
		],
		role: "assistant",
	},
];

function AssistantAvatar() {
	return (
		<span className="flex size-full items-center justify-center rounded-full bg-primary/12 font-semibold text-primary text-xs">
			R
		</span>
	);
}

function messageState(buckets: readonly MessageReactionBucket[]) {
	return { reactionBuckets: buckets } satisfies MessageActionRuntimeState;
}

function MessagePassProof() {
	const [reactionBuckets, setReactionBuckets] = useState<
		Readonly<Record<string, readonly MessageReactionBucket[]>>
	>({
		[USER_MESSAGE_IDS[2]]: [{ count: 2, emoji: "👍", reactedByMe: false }],
		[ASSISTANT_MESSAGE_IDS[2]]: [{ count: 1, emoji: "✨", reactedByMe: true }],
	});
	const [replyMessageId, setReplyMessageId] = useState<string | null>(null);
	const messageActionStates = useMemo(() => {
		const states = new Map<string, MessageActionRuntimeState>();
		for (const [messageId, buckets] of Object.entries(reactionBuckets)) {
			states.set(messageId, messageState(buckets));
		}
		return states;
	}, [reactionBuckets]);

	const toggleReaction = (messageId: string, emoji: string) => {
		setReactionBuckets((current) => {
			const buckets = [...(current[messageId] ?? [])];
			const existing = buckets.find((bucket) => bucket.emoji === emoji);
			if (existing) {
				return {
					...current,
					[messageId]: buckets.map((bucket) =>
						bucket.emoji === emoji
							? {
									...bucket,
									count: bucket.reactedByMe
										? Math.max(0, bucket.count - 1)
										: bucket.count + 1,
									reactedByMe: !bucket.reactedByMe,
								}
							: bucket
					),
				};
			}
			return {
				...current,
				[messageId]: [...buckets, { count: 1, emoji, reactedByMe: true }],
			};
		});
	};

	return (
		<main className="min-h-screen bg-background px-5 py-8 text-foreground sm:px-8 sm:py-12">
			<div className="mx-auto max-w-6xl space-y-6">
				<header className="max-w-3xl space-y-2">
					<p className="font-medium text-muted-foreground text-xs uppercase tracking-(--tracking-section)">
						CHAT + MARKETPLACE
					</p>
					<h1 className="font-semibold text-3xl tracking-tight sm:text-4xl">
						Grouped messages, compact actions, one app pass.
					</h1>
					<p className="text-muted-foreground text-sm sm:text-base">
						A real transcript keeps sender runs visually together, while
						supported paid apps advertise access through A Major Pass.
					</p>
				</header>

				<div className="grid gap-6 lg:grid-cols-[minmax(0,1.4fr)_minmax(19rem,0.8fr)]">
					<Card className="min-w-0 overflow-hidden" data-testid="chat-proof">
						<CardHeader appearance="message-review">
							<CardTitle>Message actions</CardTitle>
							<p className="text-muted-foreground text-xs">
								Three user messages and three agent replies form compact sender
								runs.
							</p>
						</CardHeader>
						<CardContent className="h-[530px] min-h-0" inset="none">
							<ChatDisplayPrefs>
								<MessageList
									assistantAvatar={<AssistantAvatar />}
									assistantName="Ryu"
									conversationKey="message-pass-proof"
									currentUser={{ id: "me", name: "You" }}
									initialScrollBehavior="top"
									messageActionStates={messageActionStates}
									messageActions={[REACTION_ACTION]}
									messages={MESSAGES}
									onBranch={() => undefined}
									onContributedMessageAction={(_action, context) => {
										if (context.value) {
											toggleReaction(context.messageId, context.value);
										}
									}}
									onEditMessage={() => undefined}
									onQuote={() => undefined}
									onRegenerateMessage={() => undefined}
									onReply={(reply) => setReplyMessageId(reply.messageId)}
									onSpeak={() => undefined}
									showCopyToolbar
									status="ready"
								/>
							</ChatDisplayPrefs>
						</CardContent>
					</Card>

					<div className="space-y-6">
						<div data-testid="pricing-proof">
							<MarketplacePassPlanCard
								onCheckout={() => undefined}
								onUsersChange={() => undefined}
								users={1}
							/>
						</div>
						<Card data-testid="marketplace-proof">
							<CardHeader>
								<p className="font-medium text-muted-foreground text-xs uppercase tracking-(--tracking-section)">
									MARKETPLACE ACCESS
								</p>
								<CardTitle variant="plan">A Major Pass</CardTitle>
								<p className="text-muted-foreground text-sm">
									All supported paid Marketplace apps and publishers for
									<strong className="text-foreground"> $20/user/month</strong>.
								</p>
							</CardHeader>
							<CardContent spacing="relaxed">
								<div className="rounded-xl border border-primary/20 bg-primary/5 p-3 text-muted-foreground text-xs">
									The ticket marks listings covered by the pass. Select it to
									see the access explanation.
								</div>
								<div data-testid="eligible-listing">
									<StoreCatalogCard
										action={
											<button
												className="rounded-md border border-border/70 px-2 py-1 text-xs"
												type="button"
											>
												Open
											</button>
										}
										brandIcon={
											<span className="flex size-full items-center justify-center rounded-lg bg-primary/12 font-semibold text-primary text-sm">
												H
											</span>
										}
										description="A focused workspace for small operations teams."
										membershipIncluded
										name="Harbor CRM"
										onClick={() => undefined}
										seedId="@ryu/harbor-crm"
									/>
								</div>
								<div className="flex items-center justify-between border-border/60 border-t pt-4 text-sm">
									<span className="text-muted-foreground">Starting price</span>
									<span className="font-semibold tabular-nums">
										$20/user/month
									</span>
								</div>
								{replyMessageId ? (
									<p className="text-muted-foreground text-xs">
										Reply selected for {replyMessageId.slice(-4)}.
									</p>
								) : null}
							</CardContent>
						</Card>
					</div>
				</div>
			</div>
		</main>
	);
}

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(<MessagePassProof />);
}
