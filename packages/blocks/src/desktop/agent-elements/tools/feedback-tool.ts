import { z } from "zod";

/**
 * Pure helpers for the built-in feedback card (`feedback.draft`). Kept free of
 * React so parsing, the report text and the remembered decision are
 * unit-testable on their own.
 *
 * The agent writes only the title and the text. Everything else on the report
 * (versions, system, model, recent errors) is collected by the host on the
 * user's device and shown line by line before anything is sent.
 */

export type FeedbackKind = "idea" | "bug";

/** The agent's draft, as the user may still edit it on the card. */
export interface FeedbackDraft {
	actual: string | null;
	body: string;
	expected: string | null;
	kind: FeedbackKind;
	steps: string | null;
	title: string;
}

/** One line the app would attach. The user can remove any of them. */
export interface FeedbackAttachment {
	group: "environment" | "error";
	id: string;
	/** Report wording, in English: the report is read by the Ryu team. */
	label: string;
	value: string;
}

// Limits mirror Core's dispatch (`feedback_tool.rs`) so a draft Core rejects
// never renders an actionable card, and one Core accepts always does. Core
// counts Unicode scalar values, not UTF-16 code units.
export const FEEDBACK_TITLE_MAX = 120;
export const FEEDBACK_BODY_MAX = 4000;
export const FEEDBACK_DETAIL_MAX = 1000;

function scalarLength(value: string): number {
	return [...value].length;
}

/** Cut `value` to at most `max` characters without splitting an emoji. */
export function clampFeedbackText(value: string, max: number): string {
	if (value.length <= max) {
		return value;
	}
	const scalars = [...value];
	return scalars.length <= max ? value : scalars.slice(0, max).join("");
}

function boundedText(max: number, min = 0) {
	return z
		.string()
		.trim()
		.refine((value) => scalarLength(value) >= min, { message: "too short" })
		.refine((value) => scalarLength(value) <= max, {
			message: `at most ${max} characters`,
		});
}

const detailText = boundedText(FEEDBACK_DETAIL_MAX).nullish();

const draftInputSchema = z.object({
	actual: detailText,
	body: boundedText(FEEDBACK_BODY_MAX, 1),
	expected: detailText,
	kind: z
		.string()
		.trim()
		.pipe(z.enum(["idea", "bug"])),
	steps: detailText,
	title: boundedText(FEEDBACK_TITLE_MAX, 1),
});

/** Whether a tool part is the feedback draft. Core surfaces the call either as
 *  a typed `tool-feedback.draft` part or as a `dynamic-tool` carrying the name. */
export function isFeedbackDraftPart(
	partType: string,
	toolName: string | undefined
): boolean {
	const name =
		partType === "dynamic-tool"
			? toolName
			: partType.startsWith("tool-")
				? partType.slice(5)
				: undefined;
	return name === "feedback.draft";
}

function blankToNull(value: string | null | undefined): string | null {
	return value && value.length > 0 ? value : null;
}

/** Parse a `feedback.draft` input. Null while it is still streaming or when it
 *  is malformed (Core rejects the same shapes). */
export function feedbackDraftFromInput(input: unknown): FeedbackDraft | null {
	const parsed = draftInputSchema.safeParse(input);
	if (!parsed.success) {
		return null;
	}
	return {
		actual: blankToNull(parsed.data.actual),
		body: parsed.data.body,
		expected: blankToNull(parsed.data.expected),
		kind: parsed.data.kind,
		steps: blankToNull(parsed.data.steps),
		title: parsed.data.title,
	};
}

/** Whether the edited draft can still be sent (Core's own minimums). */
export function isSendableDraft(draft: FeedbackDraft): boolean {
	return draft.title.trim().length > 0 && draft.body.trim().length > 0;
}

/** One attachment exactly as it appears in the report. */
export function attachmentLine(attachment: FeedbackAttachment): string {
	return `${attachment.label}: ${attachment.value}`;
}

// The draft keys that become report sections, with each section's name in
// the report. Report wording stays English: the Ryu team reads it.
const REPORT_KEY_NAMES = [
	["steps", "Steps to reproduce"],
	["expected", "Expected"],
	["actual", "What happened"],
] as const;

/**
 * The full report as plain text: what the user approved, and nothing else.
 * The card shows the same title, text and attachment lines, so what is sent is
 * what was read.
 */
export function composeFeedbackReport(
	draft: FeedbackDraft,
	attachments: readonly FeedbackAttachment[]
): string {
	const kindTag = draft.kind === "bug" ? "Bug" : "Idea";
	const sections = [`[${kindTag}] ${draft.title.trim()}`, draft.body.trim()];
	for (const [key, name] of REPORT_KEY_NAMES) {
		const value = draft[key]?.trim();
		if (value) {
			sections.push(`${name}:\n${value}`);
		}
	}
	if (attachments.length > 0) {
		sections.push(
			["Attached by the Ryu app:", ...attachments.map(attachmentLine)].join(
				"\n"
			)
		);
	}
	sections.push(
		"Drafted by an agent in Ryu. The user read and approved it before sending."
	);
	return sections.join("\n\n");
}

/** What the user did with the card. */
export type FeedbackOutcome = "copied" | "declined";

// The follow-up is sent as the USER's message, so it carries only fixed
// wording. Neither the draft nor any attachment text is repeated in it.
export function feedbackFollowUp(
	kind: FeedbackKind,
	outcome: FeedbackOutcome
): string {
	const report = kind === "bug" ? "bug report" : "idea";
	if (outcome === "copied") {
		return `I copied the ${report} and opened the feedback board to post it myself. No need to draft it again.`;
	}
	return `Not now. I don't want to send this ${report}.`;
}

/**
 * Remembers what the user decided on a feedback card, keyed by the tool call,
 * so a reopened conversation shows the closed card instead of offering to send
 * the same report again.
 *
 * Stored on this device only, and only the outcome and the title the user
 * approved. Storage failures (private mode, quota, blocked site data) fall
 * back to the in-memory card state.
 */
const KEY_PREFIX = "ryu.feedback-decision:";

const decisionSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("declined") }),
	z.object({
		kind: z.literal("copied"),
		title: z.string().max(FEEDBACK_TITLE_MAX * 4),
	}),
]);

export type FeedbackDecision = z.output<typeof decisionSchema>;

export function readFeedbackDecision(
	toolCallId: string | undefined
): FeedbackDecision | null {
	if (!toolCallId) {
		return null;
	}
	try {
		const raw = globalThis.localStorage?.getItem(KEY_PREFIX + toolCallId);
		if (!raw) {
			return null;
		}
		const parsed = decisionSchema.safeParse(JSON.parse(raw));
		return parsed.success ? parsed.data : null;
	} catch {
		return null;
	}
}

export function writeFeedbackDecision(
	toolCallId: string | undefined,
	decision: FeedbackDecision
): void {
	if (!toolCallId) {
		return;
	}
	try {
		globalThis.localStorage?.setItem(
			KEY_PREFIX + toolCallId,
			JSON.stringify(decision)
		);
	} catch {
		// Keep the in-memory state; the card still closes for this session.
	}
}
