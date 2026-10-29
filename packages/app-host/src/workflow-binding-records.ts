import { z } from "zod";
import {
	jsonResponseDocumentSchema,
	jsonResponseValueSchema,
} from "./json-values.ts";

/** Complete normalized Connect subscription shared by the workflow pickers.
 * Legacy subscriptions may omit target metadata; the producing client handles
 * workflow association and the binding confirmation before returning it. */
const workflowConnectBindingFieldsSchema = z.object({
	agentId: z.string(),
	composioTriggerId: z.string().nullable(),
	connectedAccountId: z.string(),
	createdAt: z.string(),
	id: z.string(),
	targetKind: z.enum(["agent", "workflow"]).optional(),
	toolkit: z.string(),
	triggerSlug: z.string(),
	workflowId: z.string().optional(),
});
export const workflowConnectBindingRecordSchema = z.custom<
	z.output<typeof workflowConnectBindingFieldsSchema>
>(
	(value) =>
		jsonResponseDocumentSchema.safeParse(value).success &&
		workflowConnectBindingFieldsSchema.safeParse(value).success
);
export type WorkflowConnectBindingRecord = z.output<
	typeof workflowConnectBindingRecordSchema
>;
export const workflowConnectBindingRecordsSchema = z.custom<
	WorkflowConnectBindingRecord[]
>(
	(value) =>
		jsonResponseValueSchema.safeParse(value).success &&
		z.array(workflowConnectBindingRecordSchema).safeParse(value).success
);

/** A host-resolved webhook URL. Empty is the existing unavailable-URL signal. */
const workflowWebhookFieldsSchema = z.object({ url: z.string() });
export const workflowWebhookRecordSchema = z.custom<
	z.output<typeof workflowWebhookFieldsSchema>
>(
	(value) =>
		jsonResponseDocumentSchema.safeParse(value).success &&
		workflowWebhookFieldsSchema.safeParse(value).success
);
export type WorkflowWebhookRecord = z.output<
	typeof workflowWebhookRecordSchema
>;
