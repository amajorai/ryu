import { z } from "zod";
import { gatewayJsonValueSchema } from "./gateway-json-contracts.ts";

const capabilityFieldsSchema = z.object({
	available: z.boolean().nullable().optional(),
	builtin_extensions: z.array(z.string()).nullable().optional(),
	extensions: z.array(z.string()).nullable().optional(),
	max_input_bytes: z.number().nullable().optional(),
	missing_dependencies: z.array(z.string()).nullable().optional(),
	provider: z.string().nullable().optional(),
	provider_name: z.string().nullable().optional(),
});
/** The complete Core capability projection, with older missing fields retained. */
export const documentCapabilityWireSchema = z.custom<
	z.output<typeof capabilityFieldsSchema>
>(
	(value) =>
		capabilityFieldsSchema.safeParse(value).success &&
		gatewayJsonValueSchema.safeParse(value).success
);
const jobFieldsSchema = z.object({
	error: z.string().nullable().optional(),
	job_id: z.string().nullable().optional(),
	markdown: z.string().nullable().optional(),
	missing_dependencies: z.array(z.string()).nullable().optional(),
	status: z.string().nullable().optional(),
	truncated: z.boolean().nullable().optional(),
	via: z.string().optional(),
	// Core clones provider filename metadata as serde_json::Value.
	filename: gatewayJsonValueSchema.optional(),
});
/** Core forwards the provider's status string, including future nonterminal states. */
export const documentJobWireSchema = z.custom<z.output<typeof jobFieldsSchema>>(
	(value) =>
		jobFieldsSchema.safeParse(value).success &&
		gatewayJsonValueSchema.safeParse(value).success
);
export type DocumentJobWire = z.output<typeof documentJobWireSchema>;
export const documentErrorWireSchema = z.object({
	error: z.string().optional(),
});
