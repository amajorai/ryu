// packages/core-client/src/vault/lockouts.ts
//
// Login lockout (`/api/vault/sys/lockouts*`): part of the Secret Vault
// client. `../vault.ts` re-exports these names. Machine identities lock after
// `threshold` failed logins within `windowSecs` and stay locked for
// `durationSecs`. Shapes follow `apps/core/src/vault/policy_ext/login_lockout.rs`
// (`LockoutConfig`, `LockedIdentity`); every route needs `admin` on
// `sys/lockouts`.

import { z } from "zod";
import { type ApiTarget, request } from "../client.ts";
import {
	vaultDate,
	vaultNumber,
	vaultReply,
	vaultText,
} from "./codecs-machine.ts";
import type { VaultTimestamp } from "./shared.ts";

export interface VaultLockoutConfig {
	durationSecs: number;
	enabled: boolean;
	threshold: number;
	windowSecs: number;
}

export interface VaultLockedIdentity {
	failures: number;
	identity: string;
	/** RFC 3339 after rendering, or a raw epoch-millisecond fallback. */
	lockedAt: VaultTimestamp;
	/** RFC 3339 after rendering, or a raw epoch-millisecond fallback. */
	lockedUntil: VaultTimestamp;
}

const configFields = z.object({
	enabled: z.boolean(),
	threshold: vaultNumber,
	windowSecs: vaultNumber,
	durationSecs: vaultNumber,
});

const listReply = vaultReply<{
	config: VaultLockoutConfig;
	locked: VaultLockedIdentity[];
}>(
	z.object({
		config: configFields,
		locked: z.array(
			z.object({
				identity: vaultText,
				failures: vaultNumber,
				lockedAt: vaultDate,
				lockedUntil: vaultDate,
			})
		),
	})
);
const configReply = vaultReply<{ config: VaultLockoutConfig }>(
	z.object({ config: configFields })
);
const unlockReply = vaultReply<{ wasLocked: boolean }>(
	z.object({ wasLocked: z.boolean() })
);

const LOCKOUTS = "/api/vault/sys/lockouts";

/** Locked identities and the lockout settings. */
export function listVaultLockouts(
	target: ApiTarget
): Promise<{ config: VaultLockoutConfig; locked: VaultLockedIdentity[] }> {
	return request(target, LOCKOUTS, {}, listReply);
}

/**
 * Core replaces the whole config (an omitted field resets to its default), so
 * this takes every field. Read the current config first to change one.
 */
export function setVaultLockoutConfig(
	target: ApiTarget,
	config: VaultLockoutConfig
): Promise<{ config: VaultLockoutConfig }> {
	return request(
		target,
		`${LOCKOUTS}/config`,
		{ method: "PUT", body: config },
		configReply
	);
}

/** Clear a machine identity's lock and failure count. */
export function unlockVaultIdentity(
	target: ApiTarget,
	identity: string
): Promise<{ wasLocked: boolean }> {
	return request(
		target,
		`${LOCKOUTS}/${encodeURIComponent(identity)}/unlock`,
		{ method: "POST" },
		unlockReply
	);
}
