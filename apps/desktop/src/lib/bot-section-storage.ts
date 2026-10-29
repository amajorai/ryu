import { appRequestValueSchema } from "@ryuhq/core-client/app-request-json.ts";
import { z } from "zod";

// Persisted section storage is raw JSON, not an already normalized section DTO.
// Legacy arrays have enumerable numeric entries just like object maps.
const sectionStorageMapFieldsSchema = z.record(
	z.string(),
	appRequestValueSchema
);
export const sectionStorageMapSchema = z.preprocess(
	(value) => (Array.isArray(value) ? { ...value } : value),
	z.custom<z.output<typeof sectionStorageMapFieldsSchema>>(
		(value) =>
			sectionStorageMapFieldsSchema.safeParse(value).success &&
			appRequestValueSchema.safeParse(value).success
	)
);
export const sectionLabelSchema = z.string().trim().min(1);
