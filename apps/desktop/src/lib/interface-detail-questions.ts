// Open Question cards on a thread's newest message page as interface asks
// (spec §3.2, phase 1b), with the conversation each answer posts to.

import {
	answeredQuestionIds,
	isAsyncQuestionPart,
	isQuestionPartOpen,
} from "@ryu/blocks/desktop/agent-elements/question/async-question.ts";
import { readToolTiming } from "@ryu/blocks/desktop/agent-elements/tools/tool-timing.tsx";
import type {
	InterfaceAsk,
	InterfaceAskChoice,
} from "@ryuhq/protocol/interfaces";
import {
	clamp,
	DETAIL_MAX,
	iso,
	MAX_CHOICES,
	partsOf,
	QUESTION_WAIT_MS,
	TEXT_MAX,
} from "./interface-detail-parts.ts";
import type {
	DeriveDetailExtras,
	DetailMessage,
	ThreadDetail,
} from "./interface-detail-types.ts";

type QuestionPart = Parameters<typeof isQuestionPartOpen>[0];

interface QuestionInput {
	allowCustom?: boolean;
	description?: string;
	kind?: string;
	options?: Array<{ id?: unknown; label?: unknown }>;
	title?: string;
}

function questionsOf(input: unknown): QuestionInput[] {
	if (!input || typeof input !== "object") {
		return [];
	}
	const record = input as {
		question?: QuestionInput;
		questions?: QuestionInput[];
	};
	if (Array.isArray(record.questions)) {
		return record.questions;
	}
	return record.question ? [record.question] : [];
}

function choiceLabel(label: string): string {
	const words = label.trim().split(/\s+/);
	return words.length <= 2 ? label.trim() : `${words.slice(0, 2).join(" ")}…`;
}

function singleChoices(
	questions: QuestionInput[]
): InterfaceAskChoice[] | null {
	const [only] = questions;
	const options = only?.options ?? [];
	if (
		questions.length !== 1 ||
		only?.kind !== "single" ||
		only.allowCustom ||
		options.length < 1 ||
		options.length > MAX_CHOICES
	) {
		return null;
	}
	const choices: InterfaceAskChoice[] = [];
	for (const option of options) {
		if (typeof option.id !== "string" || typeof option.label !== "string") {
			return null;
		}
		choices.push({
			id: option.id,
			label: choiceLabel(option.label),
			tone: "neutral",
		});
	}
	// Cut labels that collide would give two buttons one name: Open only.
	// Compared without case or the cut mark: "Use the" and "Use the…" collide.
	const labels = new Set(
		choices.map((choice) => choice.label.replace(/…$/, "").toLowerCase())
	);
	return labels.size === choices.length ? choices : null;
}

export function deriveQuestions(
	messages: readonly DetailMessage[],
	extras: DeriveDetailExtras
): ThreadDetail["questionAsks"] {
	const asks: ThreadDetail["questionAsks"] = [];
	const owner = extras.liftTo ?? {
		agentId: extras.agentId,
		threadId: extras.threadId,
	};
	// Async cards stay open until an answer message for them appears.
	const answered = answeredQuestionIds(
		messages as Parameters<typeof answeredQuestionIds>[0]
	);
	for (const message of messages) {
		for (const part of partsOf(message)) {
			if (part.type !== "tool-Question" || !part.toolCallId) {
				continue;
			}
			if (!isQuestionPartOpen(part as unknown as QuestionPart, answered)) {
				continue;
			}
			const questions = questionsOf(part.input);
			const first = questions[0];
			if (!first?.title) {
				continue;
			}
			const asyncPart = isAsyncQuestionPart(part as unknown as QuestionPart);
			const timing = readToolTiming(part);
			const since = timing ? timing.startedAt : null;
			const ask: InterfaceAsk = {
				agentId: owner.agentId,
				blocking: !asyncPart,
				holdsRun: !asyncPart,
				id: `question:${part.toolCallId}`,
				kind: "question",
				reason: first.description ? clamp(first.description, DETAIL_MAX) : null,
				since: since === null ? null : iso(since),
				source: "messages",
				subject: null,
				target: null,
				text: clamp(first.title, TEXT_MAX),
				threadId: owner.threadId,
			};
			if (!asyncPart) {
				// Blocking only while its thread runs and before Core's waiter ends.
				if (!extras.running) {
					continue;
				}
				const startedMs = since ?? message.timestamp;
				const expires = startedMs + QUESTION_WAIT_MS;
				if (extras.nowMs > expires) {
					continue;
				}
				ask.since ??= iso(message.timestamp);
				ask.sinceApprox = since === null;
				ask.expiresAt = iso(expires);
				ask.expiresApprox = true;
				const choices = singleChoices(questions);
				if (choices) {
					ask.choices = choices;
				}
			}
			asks.push({
				ask,
				holderId: extras.threadId,
				toolCallId: part.toolCallId,
			});
		}
	}
	return asks;
}
