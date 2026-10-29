// Complete current canonical Core OpenAPI backup response fields.
// Native Rust publishers: crates/core/backup/src/types.rs and apps/core/src/server/backups.rs.
import { z } from "zod";
import {
	appJsonValueSchema,
	appResponseValueSchema,
} from "./app-request-json.ts";
import type {
	BackupDestination,
	BackupOperation,
	BackupPolicy,
	BackupRecord,
} from "./backups.types.ts";

const BackupScopeFields = z.union([
	z.object({ kind: z.literal("node") }),
	z.object({ kind: z.literal("space"), spaceId: z.string() }),
	z.object({
		appId: z.string(),
		kind: z.literal("app"),
		namespace: z.string(),
		tenant: z.string(),
	}),
]);
const BackupDestinationFields = z.object({
	allowHttp: z.boolean(),
	allowedApps: z.array(z.string()),
	bucket: z.string(),
	createdAt: z.string(),
	endpoint: z.string(),
	id: z.string(),
	name: z.string(),
	pathStyle: z.boolean(),
	prefix: z.string(),
	region: z.string(),
}) satisfies z.ZodType<BackupDestination>;
const BackupRecordFields = z.object({
	bytes: z.number(),
	createdAt: z.string(),
	id: z.string(),
	objectKey: z.string(),
	scope: BackupScopeFields,
	sha256: z.string(),
	sourceNodeId: z.string().optional(),
	version: z.number(),
}) satisfies z.ZodType<BackupRecord>;
const BackupPolicyFields = z.object({
	destinationId: z.string(),
	enabled: z.boolean(),
	id: z.string(),
	lastAttemptAt: z.union([z.string(), z.null()]).optional(),
	retentionCount: z.number(),
	schedule: z.string(),
	scope: BackupScopeFields,
}) satisfies z.ZodType<BackupPolicy>;
const BackupOperationFields = z.object({
	action: z.string(),
	backup: z.union([z.null(), BackupRecordFields]).optional(),
	completedAt: z.union([z.string(), z.null()]).optional(),
	createdAt: z.string(),
	destinationId: z.string(),
	error: z.union([z.string(), z.null()]).optional(),
	id: z.string(),
	result: appJsonValueSchema.optional(),
	scope: BackupScopeFields,
	status: z.string(),
}) satisfies z.ZodType<BackupOperation>;
const BackupOverviewFields = z.object({
	destinations: z.array(BackupDestinationFields),
	operations: z.array(BackupOperationFields),
	policies: z.array(BackupPolicyFields),
});
function backupResponse<S extends z.ZodType>(fields: S) {
	return z.custom<z.output<S>>(
		(value) =>
			appResponseValueSchema.safeParse(value).success &&
			fields.safeParse(value).success
	);
}
export const backupDestinationResponseSchema = backupResponse(
	BackupDestinationFields
);
export const backupRecordResponseSchema = backupResponse(BackupRecordFields);
export const backupPolicyResponseSchema = backupResponse(BackupPolicyFields);
export const backupOperationResponseSchema = backupResponse(
	BackupOperationFields
);
export const backupOverviewResponseSchema =
	backupResponse(BackupOverviewFields);
export const backupRecordsResponseSchema = backupResponse(
	z.array(BackupRecordFields)
);
export const backupRecoveryKeyResponseSchema = backupResponse(
	z.object({ recoveryKey: z.string() })
);
export const backupTestResponseSchema = backupResponse(
	z.object({ ok: z.literal(true) })
);
export const backupNoContentResponseSchema = z.undefined();
