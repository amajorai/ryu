import { appResponseValueSchema } from "@ryuhq/core-client/app-request-json";
import { type ApiTarget, request } from "@ryuhq/core-client/client";
import { z } from "zod";

export interface ChatQuestionOption {
	description?: string;
	id: string;
	label: string;
}

export interface ChatQuestionItem {
	description?: string;
	id: string;
	kind: "single" | "multi" | "text";
	options: ChatQuestionOption[];
	title: string;
}

export interface ChatQuestion {
	questions: ChatQuestionItem[];
	toolCallId: string;
}

export interface ChatQuestionAnswer {
	kind: "single" | "multi" | "text" | "skip";
	question_id: string;
	selected_ids?: string[];
	text?: string;
}

const questionOptionSchema = z
	.object({
		id: z.string(),
		label: z.string(),
		description: z.string().optional().catch(undefined),
	})
	.transform((option) => ({
		description: option.description,
		id: option.id,
		label: option.label,
	}));
const questionItemSchema = z
	.object({
		id: z.string(),
		title: z.string(),
		kind: z.enum(["single", "multi", "text"]),
		description: z.string().optional().catch(undefined),
		options: z.array(questionOptionSchema.nullable().catch(null)).catch([]),
	})
	.transform((item) => ({
		description: item.description,
		id: item.id,
		kind: item.kind,
		options: item.options.flatMap((option) => (option ? [option] : [])),
		title: item.title,
	}));
const chatQuestionSchema = z.object({
	toolCallId: z.string(),
	questions: z.array(questionItemSchema).min(1),
});
const questionResolutionSchema = z.object({ resolved: z.boolean() });

export function parseChatQuestion(
	value: Parameters<typeof chatQuestionSchema.safeParse>[0]
): ChatQuestion | null {
	const parsed = chatQuestionSchema.safeParse(value);
	return parsed.success ? parsed.data : null;
}

export async function respondToChatQuestion(
	target: ApiTarget,
	conversationId: string,
	question: ChatQuestion,
	answers: ChatQuestionAnswer[]
): Promise<boolean> {
	const response = questionResolutionSchema.parse(
		await request(
			target,
			"/api/chat/question",
			{
				method: "POST",
				body: {
					answers,
					conversation_id: conversationId,
					tool_call_id: question.toolCallId,
				},
			},
			appResponseValueSchema
		)
	);
	return response.resolved;
}
