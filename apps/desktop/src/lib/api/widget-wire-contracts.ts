import { rpcJsonResponseSchema } from "@ryu/app-host/rpc";
import { z } from "zod";
import type { WidgetCallToolResult, WidgetFollowUpResult } from "./widgets.ts";

export const widgetWireRequestSchema = z.union([
	z.object({
		instance_id: z.string(),
		server_id: z.string(),
		tool_id: z.string(),
		tool_call_id: z.string(),
		arguments: rpcJsonResponseSchema.optional(),
	}),
	z.object({
		instance_id: z.string(),
		tool_call_id: z.string(),
		prompt: z.string(),
	}),
	z.object({
		instance_id: z.string(),
		tool_call_id: z.string(),
		state: rpcJsonResponseSchema.optional(),
	}),
]);
export type WidgetWireRequest = z.output<typeof widgetWireRequestSchema>;
const widgetToolResultContract = z.object({
	ok: z.boolean(),
	output: z.json(),
}) satisfies z.ZodType<WidgetCallToolResult>;
export const widgetToolResultSchema = z.custom<WidgetCallToolResult>(
	(value) =>
		rpcJsonResponseSchema.safeParse(value).success &&
		widgetToolResultContract.safeParse(value).success
);
const widgetFollowUpResultContract = z.object({
	injected: z.object({
		conversation_id: z.string(),
		origin_server: z.string(),
		prompt: z.string(),
		role: z.literal("user"),
		source: z.literal("widget"),
		tool_call_id: z.string().nullable(),
		widget_instance_id: z.string(),
	}),
	ok: z.literal(true),
	ticket: z.string(),
}) satisfies z.ZodType<WidgetFollowUpResult>;
export const widgetFollowUpResultSchema = z.custom<WidgetFollowUpResult>(
	(value) =>
		rpcJsonResponseSchema.safeParse(value).success &&
		widgetFollowUpResultContract.safeParse(value).success
);
const stringFieldSchema = z.string().optional().catch(undefined);
const nestedErrorObjectSchema = z.object({
	code: stringFieldSchema,
	message: stringFieldSchema,
});
export const widgetNestedErrorSchema = z.union([
	nestedErrorObjectSchema,
	z
		.array(rpcJsonResponseSchema)
		.transform(() => ({ code: undefined, message: undefined })),
]);
export const widgetErrorBodySchema = nestedErrorObjectSchema.extend({
	error: rpcJsonResponseSchema.optional(),
});
export const widgetErrorStringSchema = z.string();
