import { isBoundedActivityScoreRequest } from "@ryu/app-host/activity-score-input";
import type { HostServices } from "@ryu/app-host/rpc";
import { z } from "zod";
import { persistedAssertionSchema } from "../../lib/prompt-studio.ts";

/** Node responses and normalized optional fields cross the structured-clone bridge. */
type NodeResponseValue =
	| string
	| number
	| boolean
	| null
	| undefined
	| NodeResponseValue[]
	| NodeResponseDocument;
interface NodeResponseDocument {
	[key: string]: NodeResponseValue;
}
const nodeResponseValueSchema: z.ZodType<NodeResponseValue> = z.lazy(() =>
	z.union([
		z.string(),
		z.number(),
		z.boolean(),
		z.null(),
		z.undefined(),
		z.array(nodeResponseValueSchema),
		z.record(z.string(), nodeResponseValueSchema),
	])
);
const nodeResponseDocumentInputSchema = z.record(
	z.string(),
	nodeResponseValueSchema
);
export const nodeResponseDocumentSchema = z.custom<NodeResponseDocument>(
	(value) => nodeResponseDocumentInputSchema.safeParse(value).success
);

function preserveNodeResponse<S extends z.ZodType>(schema: S) {
	return z.custom<z.output<S>>((value) => schema.safeParse(value).success);
}
export const backgroundStopResponseSchema = preserveNodeResponse(
	z.object({
		ok: z.boolean(),
		requested: z.boolean(),
		process_id: z.string(),
	}) satisfies z.ZodType<
		Awaited<ReturnType<NonNullable<HostServices["backgroundStop"]>>>
	>
);
export const spaceDocumentSummarySchema = preserveNodeResponse(
	z.object({ id: z.string(), title: z.string(), updated_at: z.number() })
);
export const spaceDocumentResponseSchema = preserveNodeResponse(
	z.object({
		id: z.string(),
		title: z.string(),
		source: z.string(),
		kind: z.string(),
	})
).nullable();
export const spaceDatabaseResponseSchema = preserveNodeResponse(
	z.object({
		id: z.string(),
		kind: z.literal("database"),
		revision: z.number(),
		space_id: z.string(),
		source: z.string(),
		title: z.string(),
	})
).nullable();
export const notificationSendResponseSchema = preserveNodeResponse(
	z.object({
		notification_id: z.string(),
		target_user_id: z.string(),
	}) satisfies z.ZodType<
		Awaited<ReturnType<NonNullable<HostServices["notificationsSend"]>>>
	>
);

const commandSchema = z.object({
	id: z.string(),
	title: z.string(),
	group: z.string().optional().catch(undefined),
	keywords: z.string().optional().catch(undefined),
});
const tabIconSchema = z.object({
	pathPrefix: z.string().min(1),
	icon: z.string().min(1),
	pathIncludes: z.string().optional().catch(undefined),
	priority: z.number().optional().catch(undefined),
});
const commandEnvelopeSchema = z.object({ commands: z.array(z.unknown()) });
const tabIconEnvelopeSchema = z.object({ icons: z.array(z.unknown()) });
export function parseCompanionCommands(
	input: Parameters<typeof commandEnvelopeSchema.parse>[0]
) {
	const envelope = commandEnvelopeSchema.safeParse(input);
	if (!envelope.success) {
		return [];
	}
	return envelope.data.commands.flatMap((command) => {
		const parsed = commandSchema.safeParse(command);
		return parsed.success ? [parsed.data] : [];
	});
}
export function parseCompanionTabIcons(
	input: Parameters<typeof tabIconEnvelopeSchema.parse>[0]
) {
	const envelope = tabIconEnvelopeSchema.safeParse(input);
	if (!envelope.success) {
		return [];
	}
	return envelope.data.icons.flatMap((icon, index) => {
		const parsed = tabIconSchema.safeParse(icon);
		return parsed.success ? [{ ...parsed.data, index }] : [];
	});
}
const channelEnvelopeSchema = z.object({ channels: z.array(z.unknown()) });
export function parseCompanionEventChannels(
	input: Parameters<typeof channelEnvelopeSchema.parse>[0]
) {
	const parsed = channelEnvelopeSchema.safeParse(input);
	return parsed.success
		? parsed.data.channels.flatMap((channel) => {
				const name = z.string().safeParse(channel);
				return name.success ? [name.data] : [];
			})
		: [];
}

export const questKindInputSchema = z.enum([
	"task",
	"note",
	"link",
	"prompt",
	"snippet",
]);
export const questCaptureInputSchema = preserveNodeResponse(
	z.object({
		body: z.string(),
		kind: questKindInputSchema.optional(),
		title: z.string().optional(),
		source: z
			.object({
				app: z.string().nullable().optional(),
				title: z.string().nullable().optional(),
				url: z.string().nullable().optional(),
			})
			.optional(),
	}) satisfies z.ZodType<import("../../lib/api/quests.ts").CaptureInput>
);
export const questWriteInputSchema = preserveNodeResponse(
	z.object({
		completion_condition: z.string(),
		detail: z.string().nullable().optional(),
		title: z.string(),
	}) satisfies z.ZodType<import("../../lib/api/quests.ts").QuestInput>
);
export const mailProviderInputSchema = z.enum(["webhook", "imap"]).optional();
export const meetingSourceInputSchema = z.enum(["manual", "auto"]).optional();
export const activityScoreInputSchema = z
	.unknown()
	.refine(isBoundedActivityScoreRequest)
	.pipe(
		preserveNodeResponse(
			z.object({
				agent_id: z.string().optional(),
				assertions: z.array(persistedAssertionSchema).optional(),
				cost_micro_usd: z.number().optional(),
				description: z.string().optional(),
				evaluators: z.array(z.string()).optional(),
				expected: z.string().optional(),
				id: z.string().optional(),
				latency_ms: z.number().optional(),
				metadata: nodeResponseDocumentSchema.optional(),
				model: z.string().optional(),
				policy_pass: z.boolean().optional(),
				prompt: z.string().optional(),
				response: nodeResponseValueSchema,
				threshold: z.number().optional(),
				vars: nodeResponseDocumentSchema.optional(),
			}) satisfies z.ZodType<
				Parameters<
					typeof import("../../lib/api/gateway.ts").scoreGatewayOutput
				>[1]
			>
		)
	);
export const mailAttachmentInputSchema = z.object({
	content: z.string().optional(),
	content_base64: z.string().optional(),
	content_id: z.string().optional(),
	content_type: z.string(),
	filename: z.string(),
	inline: z.boolean().optional(),
}) satisfies z.ZodType<import("../../lib/api/mail.ts").AttachmentInput>;
