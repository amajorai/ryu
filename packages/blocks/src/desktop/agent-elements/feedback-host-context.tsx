import { createContext, useContext } from "react";
import type {
	FeedbackAttachment,
	FeedbackDraft,
	FeedbackKind,
} from "./tools/feedback-tool.ts";

/** What the user approved on the card, ready to hand to the destination. */
export interface FeedbackSubmission {
	/** Only the lines the user left on the report. */
	attachments: readonly FeedbackAttachment[];
	/** The draft as the user edited it. */
	draft: FeedbackDraft;
	/** The whole report as plain text, exactly as the card showed it. */
	report: string;
}

/**
 * How a report left the device. This first version has one destination: the
 * report is copied and the feedback board opens, where the user posts it.
 * A later destination adds its own variant here.
 */
export interface FeedbackSubmitResult {
	/** False when the copy worked but the board could not be opened. */
	destinationOpened: boolean;
	status: "copied";
}

/**
 * What the feedback card needs from the shell. `packages/blocks` draws the
 * card; the host owns the device details and the destination.
 *
 * `submitFeedback` and `openDestination` run only from a user click. The agent
 * never reaches them, and `collectAttachments` sends nothing: it only reads
 * what the card then shows.
 */
export interface FeedbackActions {
	/**
	 * The lines the app would attach for this kind of report: versions, system,
	 * engine and model, and for bugs the recent errors of this conversation,
	 * already redacted. Never conversation text or file contents.
	 */
	collectAttachments(kind: FeedbackKind): Promise<FeedbackAttachment[]>;
	/** Open the place where reports are posted. */
	openDestination(): Promise<void>;
	/** Send the approved report. Rejects when nothing left the device. */
	submitFeedback(submission: FeedbackSubmission): Promise<FeedbackSubmitResult>;
}

const FeedbackHostContext = createContext<FeedbackActions | null>(null);

export { FeedbackHostContext };

/** Read the injected feedback host, or `null` when none is mounted. The card
 *  is then read-only and says where feedback can be sent instead. */
export function useFeedbackHost(): FeedbackActions | null {
	return useContext(FeedbackHostContext);
}
