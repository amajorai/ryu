import {
	isNativeObjectLike,
	isNativeText,
} from "@ryu/ui/lib/native-primitive-observation.ts";
import { z } from "zod";
import { nativeSdkSchemaAdmits } from "../utils/native-sdk-admission.ts";
import type { NativeSdkValue } from "../utils/native-sdk-observation.ts";
import type { QuestionAnswer, QuestionConfig } from "./question-prompt.tsx";

/**
 * Async (non-blocking) agent questions.
 *
 * A Question card is async when the agent marked it non-urgent or Core released
 * the turn because nobody was available. The card then carries
 * `input.async === true` and a `{ deferred: true }` tool output, and the agent
 * has already moved on. Its answer cannot go back through the tool call, so the
 * host sends it as a normal user message that ends with a hidden marker naming
 * the card. The marker is what keeps an answered card closed after a reload.
 */

/** HTML comment appended to an async answer so the card can be matched later. */
const ANSWER_MARKER_PREFIX = "<!-- ryu-question-answer:";
const ANSWER_MARKER_PATTERN = /<!-- ryu-question-answer:([^\s>]+) -->/g;

interface QuestionPartLike {
	input?: { async?: NativeSdkValue } | null;
	output?: NativeSdkValue;
	state?: string;
	toolCallId?: string;
	type?: string;
}

/** Only the live output fields read by this decision. Their contents remain in
 * the actual opaque AI SDK domain; this is not a complete tool-result DTO. */
interface QuestionOutputObservation {
	answer?: NativeSdkValue;
	answers?: NativeSdkValue;
	deferred?: NativeSdkValue;
	output?: NativeSdkValue;
}
const questionOutputObservationSchema =
	z.custom<QuestionOutputObservation>(isNativeObjectLike);

function outputRecord(part: QuestionPartLike) {
	const output = part.output;
	if (!nativeSdkSchemaAdmits(questionOutputObservationSchema, output)) {
		return null;
	}
	const record = output;
	// Core wraps tool results as `{ status, output }`; older parts store the
	// payload directly.
	const nested = record.output;
	if (nativeSdkSchemaAdmits(questionOutputObservationSchema, nested)) {
		return nested;
	}
	return record;
}

/** The card did not block its turn: the agent asked it async or was released. */
export function isAsyncQuestionPart(part: QuestionPartLike): boolean {
	return part.input?.async === true || outputRecord(part)?.deferred === true;
}

/** The tool output itself carries an answer (a blocking question resolved). */
export function questionPartHasAnswer(part: QuestionPartLike): boolean {
	const output = outputRecord(part);
	return Boolean(output?.answer || output?.answers);
}

/**
 * Whether a Question part still wants an answer. A blocking card is open until
 * its tool call produces output; an async card stays open until the host has
 * seen an answer message for it.
 */
export function isQuestionPartOpen(
	part: QuestionPartLike,
	answeredIds: ReadonlySet<string>
): boolean {
	if (questionPartHasAnswer(part)) {
		return false;
	}
	if (part.toolCallId && answeredIds.has(part.toolCallId)) {
		return false;
	}
	if (isAsyncQuestionPart(part)) {
		return true;
	}
	return part.output === undefined || part.output === null;
}

interface QuestionTextObservation {
	text?: NativeSdkValue;
	type?: NativeSdkValue;
}

/** Collect the card ids answered by async answer messages in a transcript. */
export function answeredQuestionIds(
	messages: readonly {
		role?: string;
		parts?: readonly NativeSdkValue[];
		content?: NativeSdkValue;
	}[]
): Set<string> {
	const ids = new Set<string>();
	for (const message of messages) {
		if (message.role !== "user") {
			continue;
		}
		const texts: string[] = [];
		if (isNativeText(message.content)) {
			texts.push(message.content);
		}
		for (const part of message.parts ?? []) {
			// SAFETY: Only native member reads are observed here, with scalar
			// boxing and nullish fallback preserved. Both cells stay in the full
			// opaque SDK domain until the existing type/text comparisons below.
			const text = (part as QuestionTextObservation) ?? {};
			if (text.type === "text" && isNativeText(text.text)) {
				texts.push(text.text);
			}
		}
		for (const body of texts) {
			if (!body.includes(ANSWER_MARKER_PREFIX)) {
				continue;
			}
			for (const match of body.matchAll(ANSWER_MARKER_PATTERN)) {
				if (match[1]) {
					ids.add(match[1]);
				}
			}
		}
	}
	return ids;
}

/** Plain-text rendering of one answer, resolving option ids to labels. */
export function describeQuestionAnswer(
	question: QuestionConfig | undefined,
	answer: QuestionAnswer
): string {
	if (answer.kind === "skip") {
		return "(skipped)";
	}
	const labels = (answer.selectedIds ?? []).map(
		(id) => question?.options?.find((option) => option.id === id)?.label ?? id
	);
	const text = answer.text?.trim();
	if (text) {
		labels.push(text);
	}
	return labels.length > 0 ? labels.join(", ") : "(no answer)";
}

/** The user message that delivers answers to an async question. */
export function formatAsyncQuestionAnswer(
	toolCallId: string,
	questions: readonly QuestionConfig[],
	answers: readonly QuestionAnswer[]
): string {
	const lines = answers.map((answer, index) => {
		const question = questions[index];
		const title = question?.title ?? `Question ${index + 1}`;
		return `- ${title}: ${describeQuestionAnswer(question, answer)}`;
	});
	const heading =
		lines.length === 1
			? "Answer to your earlier question:"
			: "Answers to your earlier questions:";
	return `${heading}\n${lines.join("\n")}\n\n${ANSWER_MARKER_PREFIX}${toolCallId} -->`;
}

/** Remove async-answer markers before showing a message to the user. */
export function stripQuestionAnswerMarkers(text: string): string {
	return text.includes(ANSWER_MARKER_PREFIX)
		? text.replace(ANSWER_MARKER_PATTERN, "").trimEnd()
		: text;
}
