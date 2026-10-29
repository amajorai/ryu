import { z } from "zod";
import { jsonResponseDocumentSchema } from "./json-values.ts";

/** The host client normalizes Core's webhook metadata to these camelCase DTOs.
 * Keep the original objects, nested endpoints, and additive JSON metadata. */
function preserveWebhookResponse<S extends z.ZodObject>(fields: S) {
	return z.custom<z.output<S>>(
		(value) =>
			jsonResponseDocumentSchema.safeParse(value).success &&
			fields.safeParse(value).success
	);
}

export const webhookEndpointRecordSchema = preserveWebhookResponse(
	z.object({
		hasSecret: z.boolean(),
		id: z.string(),
		kind: z.enum(["composio", "workflow"]),
		label: z.string(),
		lastDelivery: z.number().nullable(),
		path: z.string(),
		publicUrl: z.string().nullable(),
		subscriptionCount: z.number().nullable(),
		workflowId: z.string().nullable(),
		workflowName: z.string().nullable(),
	})
);
export type WebhookEndpointRecord = z.output<
	typeof webhookEndpointRecordSchema
>;

export const webhookRegistryRecordSchema = preserveWebhookResponse(
	z.object({
		endpoints: z.array(webhookEndpointRecordSchema),
		ingressKind: z.string(),
		publicBaseUrl: z.string().nullable(),
		up: z.boolean(),
	})
);
export type WebhookRegistryRecord = z.output<
	typeof webhookRegistryRecordSchema
>;

export const webhookIngressStatusRecordSchema = preserveWebhookResponse(
	z.object({
		kind: z.string(),
		publicUrl: z.string().nullable(),
		up: z.boolean(),
	})
);
export type WebhookIngressStatusRecord = z.output<
	typeof webhookIngressStatusRecordSchema
>;
export const webhookSecretReadSchema = preserveWebhookResponse(
	z.object({ secret: z.string().nullable() })
);
export type WebhookSecretReadRecord = z.output<typeof webhookSecretReadSchema>;
export const webhookSecretWriteSchema = preserveWebhookResponse(
	z.object({ secret: z.string() })
);
export type WebhookSecretWriteRecord = z.output<
	typeof webhookSecretWriteSchema
>;
