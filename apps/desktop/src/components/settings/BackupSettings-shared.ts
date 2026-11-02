import { translate as tl } from "@ryu/i18n/core";
import { formatByteSize } from "@ryu/i18n/format-intl";
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
	return formatByteSize(value, undefined, {
		maxUnit: "megabyte",
		minUnit: "kilobyte",
	});
}
export function active(operation: BackupOperation): boolean {
	return operation.status === "pending" || operation.status === "running";
}
export function scopeLabel(scope: BackupScope): string {
	return scope.kind === "node"
		? tl("Entire node")
		: scope.kind === "space"
			? tl("Space")
			: tl("App · {namespace}", { namespace: scope.namespace });
}
