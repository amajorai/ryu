import {
	type AppResponseValue,
	appResponseValueSchema,
} from "@ryuhq/core-client/app-request-json.ts";
import { invoke } from "@tauri-apps/api/core";
import { z } from "zod";
import { isNewerVersion } from "./app-version.ts";

const appUpdateSourceSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("stable") }),
	z.object({
		channel: z.enum(["beta", "canary", "nightly"]),
		kind: z.literal("channel"),
	}),
	z.object({
		channel: z.enum(["beta", "canary", "nightly", "stable"]),
		kind: z.literal("tag"),
		tag: z.string().min(1),
	}),
]);
export type AppUpdateSource = z.output<typeof appUpdateSourceSchema>;

export interface PrepareAppUpdateRequest {
	expectedVersion: string;
	source: AppUpdateSource;
}

/** Complete public PreparedAppUpdate from native app_update.rs. Strip extra
 * fields as the previous projection did; preserve all known metadata exactly. */
const preparedAppUpdateSchema = z.object({
	artifactFile: z
		.string()
		.min(1)
		.refine((value) => !(value.includes("/") || value.includes("\\"))),
	artifactSize: z.number().int().nonnegative(),
	schemaVersion: z.literal(1),
	signature: z.string().min(1),
	source: appUpdateSourceSchema,
	version: z.string().min(1),
});
export type PreparedAppUpdate = z.output<typeof preparedAppUpdateSchema>;
type AppUpdateNativeReplyInput = Parameters<
	typeof appResponseValueSchema.parse
>[0];
type AppUpdateNativeCommand =
	| "get_app_update_download_preference"
	| "set_app_update_download_preference"
	| "get_prepared_app_update"
	| "prepare_app_update"
	| "install_prepared_app_update"
	| "clear_prepared_app_update";
type AppUpdateNativeArgs =
	| { enabled: boolean }
	| { request: PrepareAppUpdateRequest };

export type PreparedAppUpdateSnapshot =
	| { kind: "empty" }
	| { kind: "loading" }
	| { kind: "ready"; update: PreparedAppUpdate };

type InvokeNative = (
	command: AppUpdateNativeCommand,
	args?: AppUpdateNativeArgs
) => Promise<AppResponseValue>;

function parsePreparedResult(
	value: AppUpdateNativeReplyInput
): PreparedAppUpdate | null {
	if (value === null || value === undefined) {
		return null;
	}
	const prepared = preparedAppUpdateSchema.safeParse(value);
	if (!prepared.success) {
		throw new Error("Invalid prepared app update returned by Tauri");
	}
	return prepared.data;
}

export class AppUpdatePreparationCoordinator {
	private readonly inFlight = new Map<
		string,
		Promise<PreparedAppUpdate | null>
	>();
	private readonly inFlightOperationIds = new Map<string, number>();
	private readonly listeners = new Set<() => void>();
	private snapshot: PreparedAppUpdateSnapshot = { kind: "loading" };
	private nextOperationId = 0;
	private lastPublishedOperationId = 0;

	constructor(private readonly invokeNative: InvokeNative) {}

	getSnapshot = (): PreparedAppUpdateSnapshot => this.snapshot;

	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};

	private setSnapshot(snapshot: PreparedAppUpdateSnapshot): void {
		this.snapshot = snapshot;
		for (const listener of this.listeners) {
			listener();
		}
	}

	private publish(
		operationId: number,
		snapshot: PreparedAppUpdateSnapshot
	): boolean {
		if (operationId < this.lastPublishedOperationId) {
			return false;
		}
		this.lastPublishedOperationId = operationId;
		this.setSnapshot(snapshot);
		return true;
	}

	async getAutomaticDownload(): Promise<boolean> {
		try {
			const value = await this.invokeNative(
				"get_app_update_download_preference"
			);
			const parsed = z.boolean().safeParse(value);
			return parsed.success ? parsed.data : true;
		} catch {
			return true;
		}
	}

	async setAutomaticDownload(enabled: boolean): Promise<boolean> {
		try {
			await this.invokeNative("set_app_update_download_preference", {
				enabled,
			});
			return true;
		} catch {
			return false;
		}
	}

	async refresh(): Promise<PreparedAppUpdate | null> {
		const operationId = ++this.nextOperationId;
		const value = await this.invokeNative("get_prepared_app_update");
		const prepared = parsePreparedResult(value);
		const published = this.publish(
			operationId,
			prepared ? { kind: "ready", update: prepared } : { kind: "empty" }
		);
		return published ? prepared : null;
	}

	prepare(request: PrepareAppUpdateRequest): Promise<PreparedAppUpdate | null> {
		const key = JSON.stringify(request);
		const existing = this.inFlight.get(key);
		if (existing) {
			return existing;
		}
		const operationId = ++this.nextOperationId;
		const operation = this.invokeNative("prepare_app_update", { request })
			.then(parsePreparedResult)
			.then((prepared) => {
				if (
					prepared &&
					(!(
						isNewerVersion("", request.expectedVersion) &&
						isNewerVersion("", prepared.version)
					) ||
						isNewerVersion(request.expectedVersion, prepared.version) ||
						isNewerVersion(prepared.version, request.expectedVersion))
				) {
					throw new Error(
						"Prepared app update returned a different version; check again before installing"
					);
				}
				const published = this.publish(
					operationId,
					prepared ? { kind: "ready", update: prepared } : { kind: "empty" }
				);
				return published ? prepared : null;
			})
			.finally(() => {
				if (this.inFlight.get(key) === operation) {
					this.inFlight.delete(key);
					this.inFlightOperationIds.delete(key);
				}
			});
		this.inFlight.set(key, operation);
		this.inFlightOperationIds.set(key, operationId);
		return operation;
	}

	async install(): Promise<boolean | null> {
		const operationId = ++this.nextOperationId;
		const value = await this.invokeNative("install_prepared_app_update");
		const installed = z.boolean().nullable().safeParse(value);
		if (!installed.success) {
			throw new Error("Invalid prepared app update install result from Tauri");
		}
		if (installed.data) {
			this.publish(operationId, { kind: "empty" });
		}
		return installed.data;
	}

	async clear(): Promise<boolean> {
		const operationId = ++this.nextOperationId;
		try {
			await this.invokeNative("clear_prepared_app_update");
			this.publish(operationId, { kind: "empty" });
			// A new preparation after clearing must not join a superseded promise.
			for (const [key, preparationId] of this.inFlightOperationIds) {
				if (preparationId <= operationId) {
					this.inFlight.delete(key);
					this.inFlightOperationIds.delete(key);
				}
			}
			return true;
		} catch {
			return false;
		}
	}
}

export function createAppUpdatePreparationCoordinator(
	invokeNative: InvokeNative
): AppUpdatePreparationCoordinator {
	return new AppUpdatePreparationCoordinator(invokeNative);
}

const coordinator = createAppUpdatePreparationCoordinator((command, args) =>
	invoke<AppUpdateNativeReplyInput>(command, args).then(
		appResponseValueSchema.parse
	)
);

export const getAutomaticAppUpdateDownload = (): Promise<boolean> =>
	coordinator.getAutomaticDownload();
export const setAutomaticAppUpdateDownload = (
	enabled: boolean
): Promise<boolean> => coordinator.setAutomaticDownload(enabled);
export const getPreparedAppUpdate = (): Promise<PreparedAppUpdate | null> =>
	coordinator.refresh();
export const prepareAppUpdate = (
	request: PrepareAppUpdateRequest
): Promise<PreparedAppUpdate | null> => coordinator.prepare(request);
export const installPreparedAppUpdate = (): Promise<boolean | null> =>
	coordinator.install();
export const clearPreparedAppUpdate = (): Promise<boolean> =>
	coordinator.clear();
export const subscribePreparedAppUpdate = (
	listener: () => void
): (() => void) => coordinator.subscribe(listener);
export const getPreparedAppUpdateSnapshot = (): PreparedAppUpdateSnapshot =>
	coordinator.getSnapshot();
