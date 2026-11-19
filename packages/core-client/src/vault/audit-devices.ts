// packages/core-client/src/vault/audit-devices.ts
//
// External audit devices (`/api/vault/audit/devices`, `sys/audit-hash`): part
// of the Secret Vault client. `../vault.ts` re-exports these names and
// documents the wire conventions. Every route needs `admin` on `sys/audit`.
//
// Shapes follow `apps/core/src/vault/audit_devices.rs` (`AuditDevice`,
// `DeviceHealth`) as rendered by `server/vault_audit_events_api.rs`.

import { z } from "zod";
import { type AppJsonValue, appJsonValueSchema } from "../app-request-json.ts";
import { type ApiTarget, request } from "../client.ts";
import { vaultDate, vaultReply, vaultText } from "./codecs-machine.ts";
import type { VaultTimestamp } from "./shared.ts";

export type VaultAuditDeviceKind = "file" | "syslog" | "socket" | "http";

export const VAULT_AUDIT_DEVICE_KINDS: readonly VaultAuditDeviceKind[] = [
	"file",
	"syslog",
	"socket",
	"http",
];

/** Delivery health; the timestamps are absent until the first attempt. */
export interface VaultAuditDeviceHealth {
	failing: boolean;
	lastError?: string;
	lastErrorAt?: VaultTimestamp;
	lastOkAt?: VaultTimestamp;
}

export interface VaultAuditDevice {
	description: string;
	enabled: boolean;
	/** Replace request identifiers with salted HMACs (default on). */
	hmacFields: boolean;
	id: string;
	kind: VaultAuditDeviceKind;
	/**
	 * Kind-specific options: `file` {path, maxBytes, maxFiles}, `syslog`
	 * {address, facility, tag}, `socket` {address, timeoutMs}, `http`
	 * {url, secretRef}.
	 */
	options: AppJsonValue;
	/** `api` or `declarative`. */
	source: string;
}

export interface VaultAuditDeviceListing extends VaultAuditDevice {
	health: VaultAuditDeviceHealth;
}

export interface VaultAuditDeviceInput {
	description?: string;
	enabled?: boolean;
	hmacFields?: boolean;
	kind: VaultAuditDeviceKind;
	options?: Record<string, AppJsonValue>;
}

const kind = z.enum(["file", "syslog", "socket", "http"]);
const deviceFields = z.object({
	id: vaultText,
	kind,
	enabled: z.boolean(),
	description: vaultText,
	hmacFields: z.boolean(),
	options: appJsonValueSchema,
	source: vaultText,
});
const healthFields = z.object({
	failing: z.boolean(),
	lastOkAt: vaultDate.optional(),
	lastErrorAt: vaultDate.optional(),
	lastError: vaultText.optional(),
});

const devicesReply = vaultReply<{
	devices: VaultAuditDeviceListing[];
	failClosed: boolean;
}>(
	z.object({
		devices: z.array(deviceFields.extend({ health: healthFields })),
		failClosed: z.boolean(),
	})
);
const deviceReply = vaultReply<{ device: VaultAuditDevice; ok: boolean }>(
	z.object({ ok: z.boolean(), device: deviceFields })
);
const okReply = vaultReply<{ ok: boolean }>(z.object({ ok: z.boolean() }));
const hashReply = vaultReply<{ device: string; hash: string }>(
	z.object({ device: vaultText, hash: vaultText })
);

function devicePath(id: string): string {
	return `/api/vault/audit/devices/${encodeURIComponent(id)}`;
}

/** Devices with delivery health, and whether fail-closed auditing is on. */
export function listVaultAuditDevices(
	target: ApiTarget
): Promise<{ devices: VaultAuditDeviceListing[]; failClosed: boolean }> {
	return request(target, "/api/vault/audit/devices", {}, devicesReply);
}

/** Create or replace a device. Core validates the options per kind. */
export function putVaultAuditDevice(
	target: ApiTarget,
	id: string,
	input: VaultAuditDeviceInput
): Promise<{ device: VaultAuditDevice; ok: boolean }> {
	return request(
		target,
		devicePath(id),
		{ method: "PUT", body: input },
		deviceReply
	);
}

/** Delete a device; a missing id is a 404 `ApiError`. */
export function deleteVaultAuditDevice(
	target: ApiTarget,
	id: string
): Promise<{ ok: boolean }> {
	return request(target, devicePath(id), { method: "DELETE" }, okReply);
}

/**
 * The salted digest `device` writes for `input` (an accessor, a value name, an
 * actor id), so an admin can search that device's log.
 */
export function hashVaultAuditIdentifier(
	target: ApiTarget,
	device: string,
	input: string
): Promise<{ device: string; hash: string }> {
	return request(
		target,
		"/api/vault/sys/audit-hash",
		{ method: "POST", body: { device, input } },
		hashReply
	);
}
