import { useLiteralMessages } from "@ryu/i18n/react";
import { memo } from "react";
import { useFeedbackHost } from "../feedback-host-context.tsx";
import {
	FeedbackDraftCard,
	type FeedbackFollowUp,
	FeedbackUnavailableCard,
} from "./feedback-card.tsx";
import { feedbackDraftFromInput } from "./feedback-tool.ts";
import { GenericTool } from "./generic-tool.tsx";

export { isFeedbackDraftPart } from "./feedback-tool.ts";

/**
 * Inline card for `feedback.draft`: an idea or a bug report about Ryu that the
 * agent drafted and the user reviews. The user's decision goes back to the
 * agent through `onFollowUp` as their next message. Without a host or a
 * follow-up channel, the card is read-only.
 */
export const FeedbackTool = memo(function FeedbackTool({
	onFollowUp,
	part,
}: {
	onFollowUp?: FeedbackFollowUp;
	part: { input?: unknown; state?: string; toolCallId?: string };
}) {
	const host = useFeedbackHost();
	const tl = useLiteralMessages();
	const streaming = part.state === "input-streaming";
	// Core rejected the call (the agent sees the error): never offer to send a
	// draft that did not go through.
	const rejected = part.state === "output-error";
	const draft =
		streaming || rejected ? null : feedbackDraftFromInput(part.input);
	if (!draft) {
		if (streaming) {
			return <GenericTool isPending title={tl("Drafting a report")} />;
		}
		// Core rejects the same malformed shapes, so the agent already sees the
		// error; keep the row quiet rather than drawing a half card.
		return (
			<GenericTool
				isError={rejected}
				isPending={false}
				title={tl("Feedback draft")}
			/>
		);
	}
	// An actionable card needs both the host (to collect details and send) and
	// a way to tell the agent what the user chose.
	if (!(host && onFollowUp)) {
		return <FeedbackUnavailableCard draft={draft} />;
	}
	return (
		<FeedbackDraftCard
			actions={host}
			draft={draft}
			onFollowUp={onFollowUp}
			toolCallId={part.toolCallId}
		/>
	);
});
