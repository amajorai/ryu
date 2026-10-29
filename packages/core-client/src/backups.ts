import {
	backupDestinationResponseSchema,
	backupNoContentResponseSchema,
	backupOperationResponseSchema,
	backupOverviewResponseSchema,
	backupPolicyResponseSchema,
	backupRecordsResponseSchema,
	backupRecoveryKeyResponseSchema,
	backupTestResponseSchema,
} from "./backup-response-contracts.ts";
import type {
	BackupDestination,
	BackupOperation,
	BackupPolicy,
	BackupRecord,
	CreateBackup,
	SaveBackupDestination,
	SaveBackupPolicy,
} from "./backups.types.ts";
import { type ApiTarget, request } from "./client.ts";

export type * from "./backups.types.ts";

export interface RestoreBackup {
	backupId: string;
	destinationId: string;
	dryRun?: boolean;
	idempotencyKey: string;
}

export interface BackupOverview {
	destinations: BackupDestination[];
	operations: BackupOperation[];
	policies: BackupPolicy[];
}

export function getBackups(
	target: ApiTarget,
	signal?: AbortSignal
): Promise<BackupOverview> {
	return request(
		target,
		"/api/backups",
		{ signal },
		backupOverviewResponseSchema
	);
}
export function generateBackupKey(
	target: ApiTarget
): Promise<{ recoveryKey: string }> {
	return request(
		target,
		"/api/backups/recovery-key",
		{ method: "POST" },
		backupRecoveryKeyResponseSchema
	);
}
export function saveBackupDestination(
	target: ApiTarget,
	body: SaveBackupDestination,
	id?: string
): Promise<BackupDestination> {
	return request(
		target,
		`/api/backups/destinations${id ? `/${encodeURIComponent(id)}` : ""}`,
		{ method: id ? "PUT" : "POST", body },
		backupDestinationResponseSchema
	);
}
export function deleteBackupDestination(
	target: ApiTarget,
	id: string
): Promise<void> {
	return request(
		target,
		`/api/backups/destinations/${encodeURIComponent(id)}`,
		{ method: "DELETE" },
		backupNoContentResponseSchema
	);
}
export function testBackupDestination(
	target: ApiTarget,
	id: string
): Promise<{ ok: boolean }> {
	return request(
		target,
		`/api/backups/destinations/${encodeURIComponent(id)}/test`,
		{ method: "POST" },
		backupTestResponseSchema
	);
}
/** Browse the node catalog by default, or a specified Space's catalog. */
export function listBackups(
	target: ApiTarget,
	id: string,
	spaceId?: string,
	signal?: AbortSignal
): Promise<BackupRecord[]> {
	return request(
		target,
		`/api/backups/destinations/${encodeURIComponent(id)}/backups${spaceId ? `?spaceId=${encodeURIComponent(spaceId)}` : "?scope=node"}`,
		{ signal },
		backupRecordsResponseSchema
	);
}
export function saveBackupPolicy(
	target: ApiTarget,
	body: SaveBackupPolicy
): Promise<BackupPolicy> {
	return request(
		target,
		"/api/backups/policies",
		{ method: "POST", body },
		backupPolicyResponseSchema
	);
}
export function deleteBackupPolicy(
	target: ApiTarget,
	id: string
): Promise<void> {
	return request(
		target,
		`/api/backups/policies/${encodeURIComponent(id)}`,
		{
			method: "DELETE",
		},
		backupNoContentResponseSchema
	);
}
export function createBackup(
	target: ApiTarget,
	body: CreateBackup
): Promise<BackupOperation> {
	return request(
		target,
		"/api/backups/runs",
		{ method: "POST", body },
		backupOperationResponseSchema
	);
}
export function restoreBackup(
	target: ApiTarget,
	body: RestoreBackup
): Promise<BackupOperation> {
	return request(
		target,
		"/api/backups/restore",
		{ method: "POST", body },
		backupOperationResponseSchema
	);
}
export function getBackupOperation(
	target: ApiTarget,
	id: string
): Promise<BackupOperation> {
	return request(
		target,
		`/api/backups/operations/${encodeURIComponent(id)}`,
		{},
		backupOperationResponseSchema
	);
}
