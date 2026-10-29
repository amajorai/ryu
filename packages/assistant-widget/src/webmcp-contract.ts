import { z } from "zod";

export const WebMcpJsonSchema = z.json();
export const WebMcpRecordSchema = z.record(z.string(), WebMcpJsonSchema);
export type WebMcpJsonValue = z.infer<typeof WebMcpJsonSchema>;
export type WebMcpRecord = z.infer<typeof WebMcpRecordSchema>;

export const WebMcpInputPropertySchema = z.object({
	description: z.string().optional(),
	enum: z.array(z.string()).optional(),
	maximum: z.number().optional(),
	minimum: z.number().optional(),
	type: z.string().optional(),
});
export const WebMcpInputSchemaSchema = z.object({
	additionalProperties: z.literal(false),
	properties: z.record(z.string(), WebMcpInputPropertySchema),
	required: z.array(z.string()).optional(),
	type: z.literal("object"),
});
export type WebMcpInputProperty = z.infer<typeof WebMcpInputPropertySchema>;
export type WebMcpInputSchema = z.infer<typeof WebMcpInputSchemaSchema>;
