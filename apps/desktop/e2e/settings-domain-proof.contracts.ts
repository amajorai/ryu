import { z } from "zod";
import {
	type PluginDocument,
	type PluginValue,
	pluginDocumentSchema,
	pluginValueSchema,
} from "../src/lib/api/plugin-wire-values.ts";

const preferenceValueFieldsSchema = z.object({ value: z.string() });
const selectedPacksFieldsSchema = z.object({
	selectedPackIds: z.array(z.string()),
});
const databaseQueryFieldsSchema = z.object({ query: z.string() });
export const preferenceValueProofSchema = z.custom<
	z.output<typeof preferenceValueFieldsSchema> & PluginDocument
>(
	(value) =>
		pluginDocumentSchema.safeParse(value).success &&
		preferenceValueFieldsSchema.safeParse(value).success
);
export const selectedPacksProofSchema = z.custom<
	z.output<typeof selectedPacksFieldsSchema> & PluginDocument
>(
	(value) =>
		pluginDocumentSchema.safeParse(value).success &&
		selectedPacksFieldsSchema.safeParse(value).success
);
export const databaseQueryProofSchema = z.custom<
	z.output<typeof databaseQueryFieldsSchema> & PluginDocument
>(
	(value) =>
		pluginDocumentSchema.safeParse(value).success &&
		databaseQueryFieldsSchema.safeParse(value).success
);
interface ProofApiCall {
	body: PluginValue;
	method: string;
	path: string;
}
const apiCallFieldsSchema = z.object({
	body: pluginValueSchema,
	method: z.string(),
	path: z.string(),
}) satisfies z.ZodType<ProofApiCall>;
export const apiCallsProofSchema = z.custom<ProofApiCall[]>(
	(value) =>
		pluginValueSchema.safeParse(value).success &&
		z.array(apiCallFieldsSchema).safeParse(value).success
);
