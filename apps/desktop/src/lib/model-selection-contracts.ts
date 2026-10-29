import { appRequestValueSchema } from "@ryuhq/core-client/app-request-json.ts";
import { z } from "zod";

// Retain complete stored dictionaries and old array-shaped snapshots. The
// renderer consumes only string model IDs; writes preserve all unrelated rows.
const modelSelectionFieldsSchema = z.union([
	z.record(z.string(), appRequestValueSchema),
	z.array(appRequestValueSchema),
]);
export const modelSelectionSnapshotSchema = z.custom<
	z.output<typeof modelSelectionFieldsSchema>
>(
	(value) =>
		appRequestValueSchema.safeParse(value).success &&
		modelSelectionFieldsSchema.safeParse(value).success
);
export const selectedModelIdSchema = z.string();
