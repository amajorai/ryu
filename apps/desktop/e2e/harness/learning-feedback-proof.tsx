import type {
	ContributedMessageAction,
	MessageActionRuntimeState,
} from "@ryu/blocks/desktop/agent-elements/types.ts";
import type { UIMessage } from "ai";
import { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { MessageList } from "../../components/agent-elements/message-list.tsx";
import "../../src/index.css";

const ASSISTANT_MESSAGE_ID = "learning-feedback-assistant";

const FEEDBACK_ACTION: ContributedMessageAction = {
	capability: "learning.recordFeedback",
	icon: "tabler:thumb-up",
	id: "learning.feedback",
	kind: "toggle-group",
	label: "Rate response",
	order: 10,
	plugin: "@ryu/learning",
	states: [
		{
			active_icon: "tabler:thumb-up",
			icon: "tabler:thumb-up",
			label: "Good response",
			value: "up",
		},
		{
			active_icon: "tabler:thumb-down",
			icon: "tabler:thumb-down",
			label: "Bad response",
			value: "down",
		},
	],
	target: "assistant",
};

const MESSAGES: UIMessage[] = [
	{
		id: "learning-feedback-user",
		parts: [
			{ text: "How should I structure the first release?", type: "text" },
		],
		role: "user",
	},
	{
		id: ASSISTANT_MESSAGE_ID,
		parts: [
			{
				text: "Start with one durable workflow, a clear success metric, and a small group of real users. Keep the feedback loop close to the work.",
				type: "text",
			},
		],
		role: "assistant",
	},
];

function LearningFeedbackProof() {
	const [rating, setRating] = useState<string | null>(null);
	const messageActionStates = useMemo(() => {
		const state: MessageActionRuntimeState = rating
			? { toggleValues: { "learning.feedback": rating } }
			: {};
		return new Map([[ASSISTANT_MESSAGE_ID, state]]);
	}, [rating]);

	return (
		<main
			className="min-h-screen bg-background px-6 py-10 text-foreground"
			data-testid="learning-feedback-proof"
		>
			<div className="mx-auto flex w-full max-w-4xl flex-col gap-6">
				<header className="space-y-2">
					<p className="font-medium text-muted-foreground text-xs uppercase tracking-(--tracking-section)">
						@RYU/LEARNING · DESKTOP CHAT
					</p>
					<h1 className="font-semibold text-3xl tracking-tight">
						Rate a reply where you read it.
					</h1>
					<p className="max-w-2xl text-muted-foreground text-sm">
						The Learning plugin contributes the same Good response / Bad
						response toggle group to the native assistant toolbar. An active
						choice can be clicked again to clear it.
					</p>
				</header>

				<section
					className="grid gap-3 sm:grid-cols-3"
					data-testid="feedback-contract"
				>
					<div className="rounded-2xl border border-border/70 bg-card/60 p-4">
						<p className="text-muted-foreground text-xs">Owner</p>
						<p className="mt-1 font-medium text-sm">@ryu/learning</p>
					</div>
					<div className="rounded-2xl border border-border/70 bg-card/60 p-4">
						<p className="text-muted-foreground text-xs">Capability</p>
						<p className="mt-1 font-medium text-sm">learning.recordFeedback</p>
					</div>
					<div className="rounded-2xl border border-border/70 bg-card/60 p-4">
						<p className="text-muted-foreground text-xs">Persistence</p>
						<p className="mt-1 font-medium text-sm">Core message feedback</p>
					</div>
				</section>

				<section className="overflow-hidden rounded-3xl border border-border/70 bg-card/40 shadow-sm">
					<div className="flex items-center justify-between border-border/60 border-b px-5 py-4">
						<div>
							<p className="font-medium text-sm">Native chat transcript</p>
							<p className="text-muted-foreground text-xs">
								Hover the settled reply; the toolbar stays open for the latest
								answer.
							</p>
						</div>
						<span className="rounded-full bg-primary/10 px-2.5 py-1 text-primary text-xs">
							Plugin action loaded
						</span>
					</div>
					<div className="h-[370px] min-h-0">
						<MessageList
							conversationKey="learning-feedback-proof"
							currentUser={{ id: "me", name: "You" }}
							initialScrollBehavior="top"
							messageActionStates={messageActionStates}
							messageActions={[FEEDBACK_ACTION]}
							messages={MESSAGES}
							onContributedMessageAction={(_action, context) => {
								if (context.messageId === ASSISTANT_MESSAGE_ID) {
									setRating(context.value ?? null);
								}
							}}
							status="ready"
						/>
					</div>
				</section>

				<div
					className="rounded-2xl border border-border/70 bg-muted/30 p-4 text-sm"
					data-testid="feedback-status"
				>
					<p className="font-medium">
						{rating === "up"
							? "Good response selected"
							: rating === "down"
								? "Bad response selected"
								: "No response rating selected"}
					</p>
					<p className="mt-1 text-muted-foreground">
						{rating
							? "The action state is now bound to this exact assistant message."
							: "Choose a thumb to record a rating, or choose the active thumb again to clear it."}
					</p>
				</div>
			</div>
		</main>
	);
}

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(<LearningFeedbackProof />);
}
