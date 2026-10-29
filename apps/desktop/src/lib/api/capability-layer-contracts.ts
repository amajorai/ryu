import { z } from "zod";
import { gatewayJsonValueSchema } from "./gateway-json-contracts.ts";

// Complete fields emitted by Core plugins/binding.rs and server/mod.rs.
// Null/missing optional fields retain the older client's documented fallbacks.
const providerFieldsSchema = z.object({
	id: z.string(),
	is_default: z.boolean().nullish(),
	name: z.string().nullish(),
	serves_route: z.boolean().nullish(),
	serves_verbs: z.boolean().nullish(),
	target: z.string().nullish(),
	verbs: z.array(z.string()).nullish(),
	version: z.string().nullish(),
});
export type CapabilityProviderWire = z.output<typeof providerFieldsSchema>;
const layerFieldsSchema = z.object({
	available: z.array(providerFieldsSchema).nullish(),
	bound: z.string().nullish(),
	capability: z.string(),
	decisionModel: z.boolean().nullish(),
	overridden: z.boolean().nullish(),
	providers: z.array(providerFieldsSchema).nullish(),
	selectable: z.boolean().nullish(),
	title: z.string().nullish(),
	toolkit: z.boolean().nullish(),
});
export type CapabilityLayerWire = z.output<typeof layerFieldsSchema>;
const verbFieldsSchema = z.object({
	capability: z.string().nullish(),
	id: z.string(),
	provider: z.string().nullish(),
	target: z.string().nullish(),
});
const readModelFieldsSchema = z.object({
	capabilities: z.array(layerFieldsSchema).nullish(),
	verbs: z.array(verbFieldsSchema).nullish(),
});
export type CapabilityReadModelWire = z.output<typeof readModelFieldsSchema>;

/** Validate the complete consumed projection while retaining native JSON identity and future metadata. */
export const capabilityReadModelSchema = z.custom<
	z.output<typeof readModelFieldsSchema>
>(
	(value) =>
		readModelFieldsSchema.safeParse(value).success &&
		gatewayJsonValueSchema.safeParse(value).success
);
const overridesFieldsSchema = z.record(z.string(), z.string());
export const capabilityOverridesSchema = z.custom<
	z.output<typeof overridesFieldsSchema>
>(
	(value) =>
		overridesFieldsSchema.safeParse(value).success &&
		Object.values(new Object(value)).every(
			(entry) => z.string().safeParse(entry).success
		)
);
const bindingsFieldsSchema = z.object({
	overrides: capabilityOverridesSchema.nullish(),
});
export const capabilityBindingsReplySchema = z.custom<
	z.output<typeof bindingsFieldsSchema>
>(
	(value) =>
		bindingsFieldsSchema.safeParse(value).success &&
		gatewayJsonValueSchema.safeParse(value).success
);
export const capabilityErrorReplySchema = z.object({
	binding_error: z.string().nullish(),
	error: z.string().nullish(),
	plugin: z.string().nullish(),
});
