import { appJsonValueSchema } from "@ryuhq/core-client/app-request-json.ts";
import { z } from "zod";
import { marketplaceBundleKindSchema } from "./marketplace-response-contracts.ts";

/** Authoring bundle.json members omit source; normalized catalog members include it. */
const memberFieldsSchema = z.object({
	id: z.string(),
	kind: marketplaceBundleKindSchema,
	name: z.string().nullable(),
	required: z.boolean(),
	source: z.string().nullable().optional(),
});
export const marketplaceBundleMemberInputSchema = z.custom<
	z.output<typeof memberFieldsSchema>
>(
	(value) =>
		memberFieldsSchema.safeParse(value).success &&
		appJsonValueSchema.safeParse(value).success
);
export type MarketplaceBundleMemberInput = z.output<
	typeof marketplaceBundleMemberInputSchema
>;
const definitionFieldsSchema = z.object({
	kind: z.literal("bundle"),
	sourceUrl: z.string().optional(),
	members: z.array(marketplaceBundleMemberInputSchema),
});
export const marketplaceBundleDefinitionSchema = z.custom<
	z.output<typeof definitionFieldsSchema>
>(
	(value) =>
		definitionFieldsSchema.safeParse(value).success &&
		appJsonValueSchema.safeParse(value).success
);
