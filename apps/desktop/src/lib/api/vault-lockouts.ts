// Login lockout of the Core vault (`/api/vault/sys/lockouts*`): machine
// identities locked after failed logins, the lockout settings, and unlock.
// Every route needs the vault `admin` capability on `sys/lockouts`. Core
// replaces the whole config on a write, so the setter takes every field.

import type {
	VaultLockedIdentity,
	VaultLockoutConfig,
} from "@ryuhq/core-client/vault.ts";
import { z } from "zod";
import { type ApiTarget, request } from "./client.ts";

export type { VaultLockedIdentity, VaultLockoutConfig };

const configSchema = z.object({
	enabled: z.boolean(),
	threshold: z.number(),
	windowSecs: z.number(),
	durationSecs: z.number(),
});

const timestamp = z.union([z.string(), z.number()]);

const listSchema = z.object({
	config: configSchema,
	locked: z.array(
		z.object({
			identity: z.string(),
			failures: z.number(),
			lockedAt: timestamp,
			lockedUntil: timestamp,
		})
	),
});

const LOCKOUTS = "/api/vault/sys/lockouts";

export function listVaultLockouts(
	target: ApiTarget
): Promise<{ config: VaultLockoutConfig; locked: VaultLockedIdentity[] }> {
	return request(target, LOCKOUTS, undefined, listSchema);
}

export async function setVaultLockoutConfig(
	target: ApiTarget,
	config: VaultLockoutConfig
): Promise<VaultLockoutConfig> {
	const reply = await request(
		target,
		`${LOCKOUTS}/config`,
		{ method: "PUT", body: config },
		z.object({ config: configSchema })
	);
	return reply.config;
}

export async function unlockVaultIdentity(
	target: ApiTarget,
	identity: string
): Promise<boolean> {
	const reply = await request(
		target,
		`${LOCKOUTS}/${encodeURIComponent(identity)}/unlock`,
		{ method: "POST" },
		z.object({ wasLocked: z.boolean() })
	);
	return reply.wasLocked;
}
