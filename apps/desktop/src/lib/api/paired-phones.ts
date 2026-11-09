// apps/desktop/src/lib/api/paired-phones.ts
//
// Desktop host client for Core's paired-phone (device tools) management routes
// and the per-member app-route delegation revocation route:
//
//   GET    /api/device-tools/devices                       list (pending + active)
//   POST   /api/device-tools/devices/:id/approve-pair      approve a pending pairing
//   PATCH  /api/device-tools/devices/:id {label?, revoke?}  rename / revoke grants
//   DELETE /api/device-tools/devices/:id                   deny (pending) / forget
//   POST   /api/app-delegations/revoke {user_id}           revoke one member's
//                                                          app route delegations
//
// Approval is loopback- and owner-only on purpose (a phone holding the node
// token must never approve itself), so only the desktop talking to its own
// local Core can approve. The wire shapes are shared with the phone apps through
// `@ryuhq/core-client/device-tools`; this module goes through the desktop's
// `request` so the node token, attribution and verified-user JWT ride along.
//
// A node that predates these routes answers 404; callers feature-detect through
// {@link isRouteMissing} rather than surfacing an error.

import {
	type PairedDevice,
	pairedDeviceSchema,
} from "@ryuhq/core-client/device-tools.ts";
import { z } from "zod";
import { ApiError, type ApiTarget, request } from "./client.ts";

export type { PairedDevice } from "@ryuhq/core-client/device-tools.ts";

const DEVICES_PATH = "/api/device-tools/devices";
const REVOKE_DELEGATIONS_PATH = "/api/app-delegations/revoke";

const devicesResponseSchema = z.object({
	devices: z.array(pairedDeviceSchema),
	principal_id: z.string(),
});

/** The caller's paired phones as Core reports them. */
export type PairedPhonesSnapshot = z.infer<typeof devicesResponseSchema>;

const patchResponseSchema = z.object({
	always_allowed: z.array(z.string()),
	device_id: z.string(),
});

const approveResponseSchema = z.object({
	device_id: z.string(),
	state: z.literal("active"),
});

const forgetResponseSchema = z.object({ forgotten: z.literal(true) });

const revokeDelegationsResponseSchema = z.object({
	revoked_before: z.number(),
	user_id: z.string(),
});

/** Result of revoking one member's app route delegations. */
export type RevokedDelegations = z.infer<
	typeof revokeDelegationsResponseSchema
>;

/** Longest user id Core accepts on the revoke route (bytes). */
export const MAX_MEMBER_USER_ID_BYTES = 256;

const devicePath = (deviceId: string): string =>
	`${DEVICES_PATH}/${encodeURIComponent(deviceId)}`;

/** True when the node answered "no such route" (an older Core). */
export function isRouteMissing(error: unknown): boolean {
	return error instanceof ApiError && error.status === 404;
}

/** True when Core refused the caller (not the owner, not on loopback, ...). */
export function isForbidden(error: unknown): boolean {
	return (
		error instanceof ApiError && (error.status === 401 || error.status === 403)
	);
}

/** List the caller's paired phones, pending first then most recently seen. */
export async function listPairedPhones(
	target: ApiTarget,
	signal?: AbortSignal
): Promise<PairedPhonesSnapshot> {
	const snapshot = await request(
		target,
		DEVICES_PATH,
		{ method: "GET", signal },
		devicesResponseSchema
	);
	return { ...snapshot, devices: sortPairedPhones(snapshot.devices) };
}

/** Pending pairings first, then the most recently seen device. */
export function sortPairedPhones(
	devices: readonly PairedDevice[]
): PairedDevice[] {
	return [...devices].sort((left, right) => {
		if (left.state !== right.state) {
			return left.state === "pending" ? -1 : 1;
		}
		return right.last_seen_ms - left.last_seen_ms;
	});
}

/** Approve a pending pairing. Core allows this only from the node's own machine. */
export function approvePairedPhone(
	target: ApiTarget,
	deviceId: string
): Promise<z.infer<typeof approveResponseSchema>> {
	return request(
		target,
		`${devicePath(deviceId)}/approve-pair`,
		{ method: "POST" },
		approveResponseSchema
	);
}

/** Forget a device: denies a pending pairing, or unpairs an active phone. */
export function forgetPairedPhone(
	target: ApiTarget,
	deviceId: string
): Promise<z.infer<typeof forgetResponseSchema>> {
	return request(
		target,
		devicePath(deviceId),
		{ method: "DELETE" },
		forgetResponseSchema
	);
}

/** Rename a paired phone. Core trims and bounds the label. */
export function renamePairedPhone(
	target: ApiTarget,
	deviceId: string,
	label: string
): Promise<z.infer<typeof patchResponseSchema>> {
	return request(
		target,
		devicePath(deviceId),
		{ body: { label: label.trim() }, method: "PATCH" },
		patchResponseSchema
	);
}

/** Revoke "Always allow" grants for the given tools on one phone. */
export function revokePairedPhoneGrants(
	target: ApiTarget,
	deviceId: string,
	tools: readonly string[]
): Promise<z.infer<typeof patchResponseSchema>> {
	return request(
		target,
		devicePath(deviceId),
		{ body: { revoke: [...tools] }, method: "PATCH" },
		patchResponseSchema
	);
}

/** Validate a member user id the way Core does, or return why it is invalid. */
export function memberUserIdProblem(
	userId: string
): "empty" | "too_long" | null {
	const trimmed = userId.trim();
	if (!trimmed) {
		return "empty";
	}
	if (new TextEncoder().encode(trimmed).length > MAX_MEMBER_USER_ID_BYTES) {
		return "too_long";
	}
	return null;
}

/**
 * Revoke every outstanding app route delegation of one member. The member
 * themselves, an admin of the node's organization or the node owner may do it.
 */
export function revokeMemberAppDelegations(
	target: ApiTarget,
	userId: string
): Promise<RevokedDelegations> {
	return request(
		target,
		REVOKE_DELEGATIONS_PATH,
		{ body: { user_id: userId.trim() }, method: "POST" },
		revokeDelegationsResponseSchema
	);
}

/** The signed-in member's user id from a `user:<id>` principal, if any. */
export function userIdFromPrincipal(principalId: string): string | null {
	const prefix = "user:";
	return principalId.startsWith(prefix) && principalId.length > prefix.length
		? principalId.slice(prefix.length)
		: null;
}

/**
 * The `sub` claim of a JWT, read without verification, for cache scoping only.
 * Returns a non-secret, rotation-stable identity, or null when the token is
 * absent or not a decodable JWT.
 */
export function jwtSubject(token: string | null | undefined): string | null {
	const payload = token?.split(".")[1];
	if (!payload) {
		return null;
	}
	try {
		const base64 = payload.replaceAll("-", "+").replaceAll("_", "/");
		const claims: unknown = JSON.parse(atob(base64));
		if (claims && typeof claims === "object" && "sub" in claims) {
			return typeof claims.sub === "string" && claims.sub ? claims.sub : null;
		}
		return null;
	} catch {
		return null;
	}
}
