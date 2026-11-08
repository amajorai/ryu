// packages/core-client/src/vault/codecs-human-engines.ts
//
// Response codecs for the human engine and machine-identity routes, and the
// reference grammar constants. `../vault.ts` re-exports the public names.

import { z } from "zod";
import {
	appJsonValueSchema,
	appResponseValueSchema,
} from "../app-request-json.ts";
import { vaultMachineCodec, vaultMachineLease } from "./codecs-machine.ts";
import {
	vaultHumanNumber,
	vaultHumanText,
	vaultHumanTimestamp,
} from "./codecs-reply.ts";

export const vaultHumanSshPublicKey = vaultMachineCodec(
	z.object({ publicKey: vaultHumanText })
);

const vaultHumanSshRole = vaultMachineCodec(
	z.object({
		name: vaultHumanText,
		ca: vaultHumanText,
		certType: z.enum(["user", "host"]),
		allowedPrincipals: z.array(vaultHumanText),
		defaultTtlSecs: vaultHumanNumber,
		maxTtlSecs: vaultHumanNumber,
		extensions: z.array(vaultHumanText),
	})
);

export const vaultHumanSshRoles = vaultMachineCodec(
	z.object({ roles: z.array(vaultHumanSshRole) })
);

export const vaultHumanSshRoleResponse = vaultMachineCodec(
	z.object({ role: vaultHumanSshRole })
);

const vaultHumanDynamicRole = vaultMachineCodec(
	z.object({
		name: vaultHumanText,
		provider: vaultHumanText,
		defaultTtlSecs: vaultHumanNumber,
		maxTtlSecs: vaultHumanNumber,
		summary: appJsonValueSchema,
		createdAt: vaultHumanTimestamp,
		updatedAt: vaultHumanTimestamp,
	})
);

export const vaultHumanDynamicRoles = vaultMachineCodec(
	z.object({ roles: z.array(vaultHumanDynamicRole) })
);

export const vaultHumanDynamicRoleResponse = vaultMachineCodec(
	z.object({ role: vaultHumanDynamicRole })
);

export const vaultHumanRevokedCount = vaultMachineCodec(
	z.object({ revoked: vaultHumanNumber })
);

export const vaultHumanLeases = vaultMachineCodec(
	z.object({ leases: z.array(vaultMachineLease) })
);

const vaultHumanJwtClaimValues = z.array(vaultHumanText);

const vaultHumanJwtClaimsFields = z.record(
	vaultHumanText,
	vaultHumanJwtClaimValues
);

const vaultHumanJwtClaims = z.custom<
	z.output<typeof vaultHumanJwtClaimsFields>
>(
	(value) =>
		appResponseValueSchema.safeParse(value).success &&
		vaultHumanJwtClaimsFields.safeParse(value).success &&
		Object.entries(Object.call(undefined, value)).every(
			([, entry]) => vaultHumanJwtClaimValues.safeParse(entry).success
		)
);

// The internally tagged enum renames variants, not AppRole's struct fields.
export const vaultHumanMachineAuth = vaultMachineCodec(
	z.discriminatedUnion("kind", [
		z.object({ kind: z.literal("approle"), role_id: vaultHumanText }),
		z.object({
			kind: z.literal("jwt"),
			issuer: vaultHumanText,
			jwksUrl: vaultHumanText.nullable(),
			publicKeyPem: vaultHumanText.nullable(),
			audiences: z.array(vaultHumanText),
			boundClaims: vaultHumanJwtClaims,
		}),
	])
);

const vaultHumanMachine = vaultMachineCodec(
	z.object({
		id: vaultHumanText,
		name: vaultHumanText,
		auth: vaultHumanMachineAuth,
		policies: z.array(vaultHumanText),
		tokenTtlSecs: vaultHumanNumber,
		disabled: z.boolean(),
		createdAt: vaultHumanTimestamp,
		createdBy: vaultHumanText.nullable(),
	})
);

export const vaultHumanMachines = vaultMachineCodec(
	z.object({ machines: z.array(vaultHumanMachine) })
);

export const vaultHumanMachineResponse = vaultMachineCodec(
	z.object({ machine: vaultHumanMachine })
);

const vaultHumanSecretId = vaultMachineCodec(
	z.object({
		accessor: vaultHumanText,
		createdAt: vaultHumanTimestamp,
		expiresAt: vaultHumanTimestamp.nullable(),
		usesRemaining: vaultHumanNumber.nullable(),
	})
);

export const vaultHumanSecretIds = vaultMachineCodec(
	z.object({ secretIds: z.array(vaultHumanSecretId) })
);

export const vaultHumanIssuedSecretId = vaultMachineCodec(
	z.object({ secretId: vaultHumanText, info: vaultHumanSecretId })
);

export const ENV_SLUG = /^[a-z0-9][a-z0-9-]{0,31}$/;

export const SECRET_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

export const FOLDER_SEGMENT = /^[A-Za-z0-9_-]{1,64}$/;

export const MAX_FOLDER_DEPTH = 8;
