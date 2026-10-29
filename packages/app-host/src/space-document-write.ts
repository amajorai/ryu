import { z } from "zod";
import { jsonResponseDocumentSchema } from "./json-values.ts";

/** The applied DocumentUpdateResult returned by Core's revision-aware writer.
 * Version ids may be absent for a duplicate write; retained metadata is JSON. */
const spaceDocumentWriteFieldsSchema = z.object({
	changed: z.boolean(),
	duplicate: z.boolean(),
	revision: z.number(),
	updated_at: z.number(),
	version_id: z.string().optional(),
});
export const spaceDocumentWriteResultSchema = z.custom<
	z.output<typeof spaceDocumentWriteFieldsSchema>
>(
	(value) =>
		jsonResponseDocumentSchema.safeParse(value).success &&
		spaceDocumentWriteFieldsSchema.safeParse(value).success
);
export type SpaceDocumentWriteResult = z.output<
	typeof spaceDocumentWriteResultSchema
>;
