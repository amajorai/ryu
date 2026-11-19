// packages/core-client/src/vault/personal-overrides.ts
//
// Personal overrides: part of the Secret Vault client. `../vault.ts`
// re-exports these names and documents the wire conventions.
//
// A user's personal value for a name overrides the shared (project, team or
// organization) value by default. Switched off, shared values win and a
// personal value only fills a name nothing shared defines. The setting is the
// caller's own, per node, and applies to runtime resolution and to export.

import { z } from "zod";
import { type ApiTarget, request } from "../client.ts";

export interface VaultPersonalOverrides {
	/** `true` (the default): personal values win over shared values. */
	enabled: boolean;
	/** The user the setting belongs to (`local` for an unregistered node). */
	userId: string;
}

const vaultPersonalOverridesSchema: z.ZodType<VaultPersonalOverrides> =
	z.object({
		enabled: z.boolean(),
		userId: z.string(),
	});

const PERSONAL_OVERRIDES_PATH = "/api/vault/personal-overrides";

/** The caller's personal-overrides setting. */
export function getVaultPersonalOverrides(
	target: ApiTarget
): Promise<VaultPersonalOverrides> {
	return request(
		target,
		PERSONAL_OVERRIDES_PATH,
		{},
		vaultPersonalOverridesSchema
	);
}

/** Switch whether the caller's personal values override shared values. */
export function setVaultPersonalOverrides(
	target: ApiTarget,
	enabled: boolean
): Promise<VaultPersonalOverrides> {
	return request(
		target,
		PERSONAL_OVERRIDES_PATH,
		{ method: "PUT", body: { enabled } },
		vaultPersonalOverridesSchema
	);
}
