// packages/core-client/src/vault/ssh-otp.ts
//
// SSH one-time passwords: part of the Secret Vault client. `../vault.ts`
// re-exports these names and documents the wire conventions.
//
// Roles authorize against `sys/ssh/otp/<role>` - `admin` writes and deletes a
// role, `use` issues an OTP. The public `verify` route is not wrapped here on
// purpose: it consumes the OTP, and only the target host's helper calls it.

import { type ApiTarget, request } from "../client.ts";
import { vaultHumanDeletedEngine } from "./codecs-human.ts";
import {
	vaultHumanSshOtpCredential,
	vaultHumanSshOtpRoleResponse,
	vaultHumanSshOtpRoles,
} from "./codecs-human-engines.ts";
import type { VaultTimestamp } from "./shared.ts";

/** An OTP role as Core stores it (`vault/ssh/otp.rs`). */
export interface VaultSshOtpRole {
	/** Other usernames a request may name (globs). */
	allowedUsers: string[];
	/** Target hosts: the requested IP must be inside one of these blocks. */
	cidrList: string[];
	/** The username when a request names none. */
	defaultUser: string;
	/** Blocks carved out of `cidrList`. */
	excludeCidrList: string[];
	name: string;
	port: number;
	/** Lifetime of an unused OTP, 60 to 3600 seconds. */
	ttlSecs: number;
}

/** A role to write. Core fills `port` (22), `ttlSecs` (600) and the empty
 *  lists when they are omitted, and replaces the whole role. */
export type VaultSshOtpRoleInput = Pick<
	VaultSshOtpRole,
	"cidrList" | "defaultUser"
> &
	Partial<
		Pick<
			VaultSshOtpRole,
			"allowedUsers" | "excludeCidrList" | "port" | "ttlSecs"
		>
	>;

export interface VaultSshOtpRequest {
	/** The target host's IP address. */
	ip: string;
	/** The login name (default: the role's `defaultUser`). */
	username?: string;
}

/** An issued one-time password. `key` is shown once. */
export interface VaultSshOtpCredential {
	/** RFC 3339 after rendering, or a raw epoch-millisecond fallback. */
	expiresAt: VaultTimestamp;
	ip: string;
	key: string;
	keyType: "otp";
	port: number;
	username: string;
}

function otpRolePath(name: string): string {
	return `/api/vault/ssh/otp-roles/${encodeURIComponent(name)}`;
}

/** The OTP roles the caller holds a grant on. */
export function listVaultSshOtpRoles(
	target: ApiTarget
): Promise<{ roles: VaultSshOtpRole[] }> {
	return request(target, "/api/vault/ssh/otp-roles", {}, vaultHumanSshOtpRoles);
}

/** Create or replace an OTP role. Needs `admin` on `sys/ssh/otp/<name>`. */
export function putVaultSshOtpRole(
	target: ApiTarget,
	name: string,
	role: VaultSshOtpRoleInput
): Promise<{ role: VaultSshOtpRole }> {
	return request(
		target,
		otpRolePath(name),
		{ method: "PUT", body: role },
		vaultHumanSshOtpRoleResponse
	);
}

/** Delete an OTP role and every unused OTP it issued. Needs `admin`. */
export function deleteVaultSshOtpRole(
	target: ApiTarget,
	name: string
): Promise<{ deleted: boolean }> {
	return request(
		target,
		otpRolePath(name),
		{ method: "DELETE" },
		vaultHumanDeletedEngine
	);
}

/** Issue a one-time password for one host. Needs `use` on
 *  `sys/ssh/otp/<role>`. */
export function createVaultSshOtp(
	target: ApiTarget,
	role: string,
	input: VaultSshOtpRequest
): Promise<{ credential: VaultSshOtpCredential }> {
	return request(
		target,
		`/api/vault/ssh/creds/${encodeURIComponent(role)}`,
		{ method: "POST", body: input },
		vaultHumanSshOtpCredential
	);
}
