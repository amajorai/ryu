/**
 * Device tools ("let Ryu use apps on this phone"): the closed catalog and the
 * wire shapes shared by Core and every client.
 *
 * The catalog lives in `packages/protocol/fixtures/device-tools-v1.json`. Core
 * compiles it in (`apps/core/src/device_tools/catalog.rs`); native clients copy
 * it byte for byte and keep a drift test. Clients never send schemas: a phone
 * declares only which app groups it has and their permission state.
 */

import { z } from "zod";
import catalogJson from "../fixtures/device-tools-v1.json" with {
	type: "json",
};

/** Catalog version a client declares in `client_device.catalog_version`. */
export const DEVICE_TOOLS_CATALOG_VERSION = 1 as const;

/** First line of every device-request signature's canonical string. */
export const DEVICE_SIGNATURE_SCHEME = "ryu-device-v1" as const;

/** Signed-request headers. */
export const DEVICE_CLIENT_ID_HEADER = "X-Ryu-Client-Id" as const;
export const DEVICE_TIMESTAMP_HEADER = "X-Ryu-Device-Ts" as const;
export const DEVICE_SIGNATURE_HEADER = "X-Ryu-Device-Sig" as const;

export const deviceAppIdSchema = z.enum([
	"calendar",
	"contacts",
	"location",
	"alarms",
	"reminders",
	"home",
]);
export type DeviceAppId = z.infer<typeof deviceAppIdSchema>;

export const devicePermissionSchema = z.enum([
	"granted",
	"limited",
	"denied",
	"undetermined",
	"restricted",
	"unsupported",
]);
export type DevicePermission = z.infer<typeof devicePermissionSchema>;

const catalogToolSchema = z.object({
	alias: z.string().regex(/^device_[a-z_]+$/),
	app: deviceAppIdSchema,
	description: z.string(),
	id: z.string().regex(/^device\.[a-z_]+\.[a-z_]+$/),
	input_schema: z.record(z.string(), z.unknown()),
	security_class_possible: z.boolean().optional(),
	status: z.enum(["available", "planned"]),
	verb: z.enum(["read", "write", "delete"]),
});
export type DeviceCatalogTool = z.infer<typeof catalogToolSchema>;

const catalogAppSchema = z.object({
	id: deviceAppIdSchema,
	name: z.string(),
	platforms: z.array(z.enum(["ios", "android"])),
	status: z.enum(["available", "planned"]),
});

export const deviceToolCatalogSchema = z.object({
	apps: z.array(catalogAppSchema),
	tools: z.array(catalogToolSchema),
	version: z.literal(DEVICE_TOOLS_CATALOG_VERSION),
});
export type DeviceToolCatalog = z.infer<typeof deviceToolCatalogSchema>;

/** The compiled-in catalog, validated at import. */
export const DEVICE_TOOL_CATALOG: DeviceToolCatalog =
	deviceToolCatalogSchema.parse(catalogJson);

/** Canonical id (`device.calendar.create`) for an alias or canonical id. */
export function canonicalDeviceToolId(name: string): string | null {
	const tool = DEVICE_TOOL_CATALOG.tools.find(
		(entry) => entry.alias === name || entry.id === name
	);
	return tool ? tool.id : null;
}

/** One app group a phone declares. */
export const deviceAppDeclSchema = z.object({
	app: deviceAppIdSchema,
	permission: devicePermissionSchema,
	precision: z.enum(["approximate", "precise"]).optional(),
	user_disabled: z.boolean().optional(),
});
export type DeviceAppDecl = z.infer<typeof deviceAppDeclSchema>;

/** `client_device` on `POST /api/chat/stream` and the presence body. */
export const clientDeviceSchema = z.object({
	app: z.enum(["ryu-bot", "ryu-native"]),
	catalog_version: z.literal(DEVICE_TOOLS_CATALOG_VERSION),
	device_id: z.string().uuid(),
	foreground: z.boolean(),
	label: z.string().max(40).optional(),
	os_version: z.string().max(16).optional(),
	platform: z.enum(["ios", "android"]),
	tools: z.array(deviceAppDeclSchema).max(6),
	tz: z.string().max(64).optional(),
	utc_offset_min: z.number().int().min(-1080).max(1080).optional(),
});
export type ClientDevice = z.infer<typeof clientDeviceSchema>;

/** Stable device-lane error codes. */
export const deviceErrorCodeSchema = z.enum([
	"device_unavailable",
	"device_not_paired",
	"foreground_required",
	"device_locked",
	"permission_denied",
	"permission_limited",
	"permission_pending",
	"user_disabled",
	"admin_blocked",
	"unsupported_platform",
	"unsupported_os",
	"not_own_chat",
	"recurring_event",
	"has_attendees",
	"out_of_range",
	"not_found",
	"quota_exceeded",
	"approval_required",
	"approval_timeout",
	"already_claimed",
	"input_mismatch",
	"device_timeout",
	"pending_on_device",
	"cancelled_by_user",
	"os_error",
	"invalid_input",
	"invalid_signature",
]);
export type DeviceErrorCode = z.infer<typeof deviceErrorCodeSchema>;

/** The result envelope a phone posts (and the model receives). */
export const deviceToolResultSchema = z.union([
	z.object({ data: z.unknown(), ok: z.literal(true) }),
	z.object({
		code: deviceErrorCodeSchema,
		message: z.string().optional(),
		ok: z.literal(false),
	}),
]);
export type DeviceToolResult = z.infer<typeof deviceToolResultSchema>;

/** `data-device-tool-request` (id `devreq-<toolCallId>`). Never carries input. */
export const deviceToolRequestFrameSchema = z.object({
	app: deviceAppIdSchema,
	conversationId: z.string(),
	deviceLabel: z.string(),
	expiresAtMs: z.number(),
	resumableUntilMs: z.number(),
	summary: z.string(),
	targetDeviceId: z.string(),
	tool: z.string(),
	toolCallId: z.string(),
});
export type DeviceToolRequestFrame = z.infer<
	typeof deviceToolRequestFrameSchema
>;

/** `data-device-tool-permission` (id `devperm-<toolCallId>`). */
export const deviceToolPermissionFrameSchema = z.object({
	app: deviceAppIdSchema,
	appName: z.string(),
	/**
	 * The conversation the call belongs to (a non-origin phone needs it to
	 * claim). Optional only for Cores that predate it.
	 */
	conversationId: z.string().optional(),
	deviceLabel: z.string(),
	expiresAtMs: z.number(),
	resumableUntilMs: z.number(),
	state: z.enum(["undetermined", "denied"]),
	targetDeviceId: z.string(),
	/** The canonical tool id (`device.<app>.<verb>`); optional as above. */
	tool: z.string().optional(),
	toolCallId: z.string(),
});
export type DeviceToolPermissionFrame = z.infer<
	typeof deviceToolPermissionFrameSchema
>;

/**
 * `data-device-tool-status` (id `devstat-<toolCallId>`, replaced in place).
 * `parked` means the wait window ended unclaimed: show Retry until
 * `resumableUntilMs`. Retry sends a new user turn ("Retry phone action"); when
 * the model calls the same tool with the same input, Core reuses the recorded
 * approval and pinned phone.
 */
export const deviceToolStatusFrameSchema = z.object({
	/** Catalog app id of a `waiting-device` / `parked` status. */
	app: deviceAppIdSchema.optional(),
	/** The catalog's English app name; clients localize from `app`. */
	appName: z.string().optional(),
	/** The pinned phone's label, when the status names one. */
	deviceLabel: z.string().optional(),
	/**
	 * Legacy free text. Core no longer sends it: clients render the status in
	 * the user's language from `state`, `app` and `deviceLabel`.
	 */
	message: z.string().optional(),
	resumableUntilMs: z.number().int().optional(),
	retry: z.boolean().optional(),
	state: z.enum([
		"waiting-device",
		"awaiting-approval",
		"awaiting-permission",
		"claimed",
		"done",
		"parked",
		"expired",
		"cancelled",
	]),
	toolCallId: z.string(),
});
export type DeviceToolStatusFrame = z.infer<typeof deviceToolStatusFrameSchema>;

/** The `device` block on a `data-ryu-permission` card for a phone action. */
export const devicePermissionBlockSchema = z.object({
	app: deviceAppIdSchema,
	deviceId: z.string(),
	/**
	 * Only when `requiresOnDeviceConfirmation`: the frozen input hash the
	 * target phone signs with its user-presence key (see
	 * `deviceConfirmMessage`).
	 */
	inputSha256: z.string().optional(),
	label: z.string(),
	requiresOnDeviceConfirmation: z.boolean(),
	tool: z.string(),
});

/** `POST /api/device-tools/claim` response. */
export const deviceClaimResponseSchema = z.object({
	claim_id: z.string(),
	deadline_ms: z.number(),
	input: z.record(z.string(), z.unknown()).nullable(),
	input_sha256: z.string(),
	/**
	 * A Home security action the user confirmed on this phone with
	 * biometrics. The phone refuses a security write without it.
	 */
	security_confirmed: z.boolean().optional(),
	tool: z.string(),
});
export type DeviceClaimResponse = z.infer<typeof deviceClaimResponseSchema>;

/** Lowercase hex of `bytes`. */
function toHex(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
		""
	);
}

/**
 * The canonical string a device signs (ECDSA P-256 / SHA-256):
 * `ryu-device-v1\n<METHOD>\n<route>\n<principal_id>\n<device_id>\n<ts_ms>\n<hex sha256(body)>`.
 * `route` is the route template (for example `/api/device-tools/claim`), not
 * the full URL. GET requests hash the empty body.
 */
export async function deviceCanonicalString(input: {
	body: Uint8Array;
	deviceId: string;
	method: string;
	principalId: string;
	route: string;
	timestampMs: number;
}): Promise<string> {
	const digest = new Uint8Array(
		await crypto.subtle.digest("SHA-256", new Uint8Array(input.body))
	);
	return [
		DEVICE_SIGNATURE_SCHEME,
		input.method.toUpperCase(),
		input.route,
		input.principalId,
		input.deviceId,
		String(input.timestampMs),
		toHex(digest),
	].join("\n");
}

/** A per-app admin cap (P5). Caps only restrict the user's own choice. */
export const deviceToolCapSchema = z.enum(["never", "ask", "always"]);
export type DeviceToolCap = z.infer<typeof deviceToolCapSchema>;

/**
 * `caps` on `GET /api/device-tools/catalog`: `"never"` (the caller's rules
 * could not be resolved on an org-bound node) or one cap per capped app.
 */
export const deviceToolCapsSchema = z.union([
	z.literal("never"),
	z.partialRecord(deviceAppIdSchema, deviceToolCapSchema),
]);
export type DeviceToolCaps = z.infer<typeof deviceToolCapsSchema>;

/** First line of an on-device confirmation string. */
export const DEVICE_CONFIRM_SCHEME = "ryu-device-confirm-v1";

/**
 * The string the target phone signs with its user-presence key (usable only
 * after biometrics or the passcode) to approve a card with
 * `requiresOnDeviceConfirmation`:
 * `ryu-device-confirm-v1\n<request_id>\n<input_sha256>\n<option_id>\n<confirmed_at_ms>`.
 */
export function deviceConfirmMessage(input: {
	confirmedAtMs: number;
	inputSha256: string;
	optionId: string;
	requestId: string;
}): string {
	return [
		DEVICE_CONFIRM_SCHEME,
		input.requestId,
		input.inputSha256,
		input.optionId,
		String(input.confirmedAtMs),
	].join("\n");
}

/** `POST /api/device-tools/confirm` response. */
export const deviceConfirmResponseSchema = z.object({
	decision: z.enum(["allow_once", "deny"]),
	resolved: z.literal(true),
});
export type DeviceConfirmResponse = z.infer<typeof deviceConfirmResponseSchema>;

/** One accessory in a `POST /api/device-tools/home-accessories` body. */
export const homeAccessoryReportSchema = z.object({
	accessory_id: z.string().min(1).max(256),
	name: z.string().max(200).optional(),
	/** HomeKit service types, e.g. `HMServiceTypeLockMechanism`. */
	services: z.array(z.string()).max(32),
});
export type HomeAccessoryReport = z.infer<typeof homeAccessoryReportSchema>;
