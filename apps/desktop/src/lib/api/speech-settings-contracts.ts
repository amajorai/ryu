import { z } from "zod";
import type { GatewayProviderEditResult } from "./gateway.ts";
import { gatewayJsonValueSchema } from "./gateway-json-contracts.ts";

const anonymousSpeechFields = {
	anonymousConsumerOptIn: z.boolean(),
	classification: z.literal("unofficial_anonymous_consumer"),
	mode: z.literal("anonymous"),
};
const edgeSpeechSchema = z.object({
	...anonymousSpeechFields,
	provider: z.literal("edge-tts"),
});
const translateSpeechSchema = z.object({
	...anonymousSpeechFields,
	provider: z.literal("google-translate-tts"),
});
const speechSettingsFieldsSchema = z.object({
	configRevision: z.string().regex(/^[a-f0-9]{64}$/),
	edgeTts: edgeSpeechSchema,
	googleTranslateTts: translateSpeechSchema.optional(),
	speechSettingsSchema: z.literal(1),
});
export type GatewaySpeechSettings = z.output<typeof speechSettingsFieldsSchema>;

/** Validate the complete native projection while retaining future wire metadata. */
export const gatewaySpeechSettingsSchema = z.custom<GatewaySpeechSettings>(
	(value) => {
		const parsed = speechSettingsFieldsSchema.safeParse(value);
		if (!(parsed.success && gatewayJsonValueSchema.safeParse(value).success)) {
			return false;
		}
		// An explicitly present malformed Translate view was never a legacy omission.
		return (
			!("googleTranslateTts" in new Object(value)) ||
			parsed.data.googleTranslateTts !== undefined
		);
	}
);

const revisionFields = { requestedRevision: z.string() };
const providerApplicationSchema = z.union([
	z.object({
		...revisionFields,
		status: z.enum(["applied", "already_applied"]),
		appliedRevision: z.string(),
		epoch: z.object({ boot: z.string(), sequence: z.number() }),
	}),
	z.object({
		...revisionFields,
		status: z.literal("superseded"),
		currentRevision: z.string(),
	}),
	z.object({
		...revisionFields,
		status: z.literal("failed"),
		activeRevision: z.string().nullable().optional(),
		code: z.string(),
	}),
	z.object({ ...revisionFields, status: z.enum(["offline", "unmanaged"]) }),
]);
const speechEditFieldsSchema = z.object({
	accountsApplied: z.boolean().optional(),
	configRevision: z.string().optional(),
	gateway_application: providerApplicationSchema.optional(),
	gateway_outcome: z.string().optional(),
	gateway_restarted: z.boolean(),
	persisted: z.boolean().optional(),
	success: z.boolean(),
	provider: z.enum(["edge-tts", "google-translate-tts"]).optional(),
	anonymousConsumerOptIn: z.boolean().optional(),
	edgeTts: edgeSpeechSchema.optional(),
	googleTranslateTts: translateSpeechSchema.optional(),
});
/** Both legacy restart receipts and current revision application receipts are native replies. */
export const gatewaySpeechEditResultSchema = z.custom<
	z.output<typeof speechEditFieldsSchema>
>(
	(value) =>
		speechEditFieldsSchema.safeParse(value).success &&
		gatewayJsonValueSchema.safeParse(value).success
) satisfies z.ZodType<GatewayProviderEditResult>;

export const gatewaySpeechEditInputSchema = z.object({
	anonymousConsumerOptIn: z.boolean(),
	expectedRevision: z.string(),
	provider: z.literal("google-translate-tts").optional(),
});
export type GatewaySpeechEditInput = z.output<
	typeof gatewaySpeechEditInputSchema
>;
