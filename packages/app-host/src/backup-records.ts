import { z } from "zod";
import {
	jsonResponseDocumentSchema,
	jsonResponseValueSchema,
	type RyuJsonValue,
} from "./json-values.ts";

/** App backup method replies follow Core's backup bridge, not the privileged
 * administrative destination APIs. Restore returns the app's saved JSON. */
export const appBackupMethodSchema = z.enum([
	"backups.destinations",
	"backups.create",
	"backups.list",
	"backups.get",
	"backups.restore",
]);
export type AppBackupMethod = z.output<typeof appBackupMethodSchema>;

const backupScopeSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("node") }),
	z.object({ kind: z.literal("space"), spaceId: z.string() }),
	z.object({
		appId: z.string(),
		kind: z.literal("app"),
		namespace: z.string(),
		tenant: z.string(),
	}),
]);
const backupRecordFieldsSchema = z.object({
	bytes: z.number(),
	createdAt: z.string(),
	id: z.string(),
	objectKey: z.string(),
	scope: backupScopeSchema,
	sha256: z.string(),
	sourceNodeId: z.string().optional(),
	version: z.number(),
});
const backupOperationFieldsSchema = z.object({
	action: z.string(),
	backup: backupRecordFieldsSchema.nullish(),
	completedAt: z.string().nullish(),
	createdAt: z.string(),
	destinationId: z.string(),
	error: z.string().nullish(),
	id: z.string(),
	result: jsonResponseValueSchema.optional(),
	scope: backupScopeSchema,
	status: z.string(),
});
const backupDestinationsFieldsSchema = z.array(
	z.object({ id: z.string(), name: z.string() })
);
const backupRecordsFieldsSchema = z.array(backupRecordFieldsSchema);

/** Preserve nested snapshot data and additive fields. Business validation,
 * namespace limits, destination grants, and tenant derivation remain in Core. */
export function appBackupResponseSchema(method: AppBackupMethod) {
	return z.custom<RyuJsonValue>((value) => {
		if (!jsonResponseValueSchema.safeParse(value).success) {
			return false;
		}
		switch (method) {
			case "backups.destinations":
				return backupDestinationsFieldsSchema.safeParse(value).success;
			case "backups.create":
			case "backups.get":
				return (
					jsonResponseDocumentSchema.safeParse(value).success &&
					backupOperationFieldsSchema.safeParse(value).success
				);
			case "backups.list":
				return backupRecordsFieldsSchema.safeParse(value).success;
			case "backups.restore":
				return true;
			default:
				return false;
		}
	});
}
