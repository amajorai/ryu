import { z } from "zod";
import type {
	GatewayComputerUseConfig,
	GatewayConfigPatch,
} from "../src/lib/api/gateway.ts";
import { pluginDocumentSchema } from "../src/lib/api/plugin-wire-values.ts";

export const computerUseFieldsSchema = z.object({
	locked_use: z.boolean(),
	security_key: z.boolean().optional(),
}) satisfies z.ZodType<GatewayComputerUseConfig>;
export const computerUseProofSchema = z.custom<GatewayComputerUseConfig>(
	(value) =>
		pluginDocumentSchema.safeParse(value).success &&
		computerUseFieldsSchema.safeParse(value).success
);
const computerUsePatchFieldsSchema = z.object({
	computer_use: computerUseProofSchema.optional(),
}) satisfies z.ZodType<Pick<GatewayConfigPatch, "computer_use">>;
export const computerUsePatchProofSchema = z.custom<
	z.output<typeof computerUsePatchFieldsSchema>
>(
	(value) =>
		pluginDocumentSchema.safeParse(value).success &&
		computerUsePatchFieldsSchema.safeParse(value).success
);
export const computerUseEventSchema = z.string();

export const computerUseBodyTextSchema = z.string();
