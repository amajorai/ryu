import { ApiError } from "@ryuhq/core-client/client.ts";
import type {
	BackupOperation,
	BackupOverview,
	BackupScope,
} from "@/src/lib/api/backups.ts";

export type BackupAct = <TResult>(
	action: () => Promise<TResult>,
	success: string
) => Promise<void>;

export const EMPTY: BackupOverview = {
	destinations: [],
	operations: [],
	policies: [],
};

export function message<TError>(error: TError): string {
	if (error instanceof ApiError && error.serverMessage) {
		return error.serverMessage;
	}
	return error instanceof Error
		? error.message
		: "Backup request failed. Try again.";
}
export function bytes(value: number): string {
	return value < 1024 * 1024
		? `${(value / 1024).toFixed(1)} KB`
		: `${(value / (1024 * 1024)).toFixed(1)} MB`;
}
export function active(operation: BackupOperation): boolean {
	return operation.status === "pending" || operation.status === "running";
}
export function scopeLabel(scope: BackupScope): string {
	return scope.kind === "node"
		? "Entire node"
		: scope.kind === "space"
			? "Space"
			: `App · ${scope.namespace}`;
}
