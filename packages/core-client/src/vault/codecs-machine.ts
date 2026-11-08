// packages/core-client/src/vault/codecs-machine.ts
//
// Response codecs for the machine routes (login, `/api/vault/agent/*`) and the
// broker of the Secret Vault client. `../vault.ts` re-exports the public names
// and documents the wire conventions.

import { z } from "zod";
import {
	type AppJsonValue,
	appJsonValueSchema,
	appResponseValueSchema,
} from "../app-request-json.ts";
import type {
	VaultBrokerDiscoveredHost,
	VaultBrokerDiscovery,
	VaultBrokerLogRow,
	VaultBrokerProposal,
	VaultBrokerService,
	VaultBrokerSession,
	VaultBrokerSessionGrant,
	VaultBrokerStatus,
} from "./broker.ts";
import type { VaultMachineTransitCodecs } from "./internal.ts";
import type {
	VaultPasswordManagerAccount,
	VaultPasswordManagerGrant,
	VaultPasswordManagerReadResult,
	VaultPasswordManagerTestResult,
} from "./password-manager.ts";

export const vaultExportObject = z.custom<
	Record<string, z.output<typeof appResponseValueSchema>>
>(
	(value) =>
		appResponseValueSchema.safeParse(value).success &&
		z.record(z.string(), appResponseValueSchema).safeParse(value).success
);

/** Header carrying a machine vault token on `/api/vault/agent/*`. */
export const VAULT_TOKEN_HEADER = "x-ryu-vault-token";

export const VAULT_TRANSIT_KEY_TYPES = [
	"aes256-gcm96",
	"chacha20-poly1305",
	"ed25519",
	"ecdsa-p256",
	"ecdsa-p384",
	"rsa-2048",
	"rsa-3072",
	"rsa-4096",
	"hmac",
] as const;

// These codecs own complete machine reply fields only after native JSON.parse.
// Validation retains the decoded record, including future keys and nested references.
export function vaultMachineCodec<S extends z.ZodType>(fields: S) {
	return z.custom<z.output<S>>(
		(value) =>
			appResponseValueSchema.safeParse(value).success &&
			fields.safeParse(value).success
	);
}

const vaultMachineText = z.string();

export const vaultMachineNumber = z.union([
	z.number(),
	z.literal(Number.POSITIVE_INFINITY),
	z.literal(Number.NEGATIVE_INFINITY),
]);

export const vaultMachineDate = z.union([vaultMachineText, vaultMachineNumber]);

const vaultMachineStringsFields = z.record(z.string(), vaultMachineText);

const vaultMachineStrings = z.custom<
	z.output<typeof vaultMachineStringsFields>
>(
	(value) =>
		vaultMachineStringsFields.safeParse(value).success &&
		Object.entries(Object.call(undefined, value)).every(
			([, entry]) => vaultMachineText.safeParse(entry).success
		)
);

const vaultMachineIssuedToken = vaultMachineCodec(
	z.object({
		token: vaultMachineText,
		accessor: vaultMachineText,
		identityId: vaultMachineText,
		policies: z.array(vaultMachineText),
		expiresAt: vaultMachineDate,
	})
);

const vaultMachinePrincipal = vaultMachineCodec(
	z.object({
		accessor: vaultMachineText,
		identityId: vaultMachineText,
		identityName: vaultMachineText,
		policies: z.array(vaultMachineText),
		expiresAt: vaultMachineDate,
	})
);

export const vaultMachineLease = vaultMachineCodec(
	z.object({
		id: vaultMachineText,
		role: vaultMachineText,
		provider: vaultMachineText,
		issuedTo: vaultMachineText.nullable(),
		createdAt: vaultMachineDate,
		expiresAt: vaultMachineDate,
		maxExpiresAt: vaultMachineDate,
		renewable: z.boolean(),
		revokedAt: vaultMachineDate.nullable(),
	})
);

export const vaultMachineLoginResponse = vaultMachineCodec(
	z.object({ token: vaultMachineIssuedToken })
);

export const vaultMachineSelfResponse = vaultMachineCodec(
	z.object({ token: vaultMachinePrincipal })
);

export const vaultMachineRevokedResponse = vaultMachineCodec(
	z.object({ revoked: z.boolean() })
);

export const vaultMachineExportResponse = vaultMachineCodec(
	z.object({
		content: vaultMachineText,
		contentType: vaultMachineText,
		count: vaultMachineNumber,
		environment: vaultMachineText,
		format: z.enum(["dotenv", "json", "yaml", "shell", "k8s-secret"]),
		path: vaultMachineText,
		sharedError: vaultMachineText.nullish(),
	})
);

export const vaultMachineValueResponse = vaultMachineCodec(
	z.object({ value: vaultMachineText })
);

export const vaultMachineDynamicResponse = vaultMachineCodec(
	z.object({
		credential: vaultMachineCodec(
			z.object({ data: vaultMachineStrings, lease: vaultMachineLease })
		),
	})
);

export const vaultMachineLeaseResponse = vaultMachineCodec(
	z.object({ lease: vaultMachineLease })
);

export const vaultMachinePkiResponse = vaultMachineCodec(
	z.object({
		certificate: vaultMachineCodec(
			z.object({
				certificate: vaultMachineText,
				issuingCa: vaultMachineText,
				notAfter: vaultMachineDate,
				privateKey: vaultMachineText.optional(),
				serial: vaultMachineText,
			})
		),
	})
);

export const vaultMachineSshResponse = vaultMachineCodec(
	z.object({
		certificate: vaultMachineCodec(
			z.object({
				certificate: vaultMachineText,
				keyId: vaultMachineText,
				principals: z.array(vaultMachineText),
				serial: vaultMachineNumber,
				validAfter: vaultMachineDate,
				validBefore: vaultMachineDate,
			})
		),
	})
);

export const vaultMachineTransitResponses: VaultMachineTransitCodecs = {
	datakey: vaultMachineCodec(
		z.object({ ciphertext: vaultMachineText, plaintext: vaultMachineText })
	),
	decrypt: vaultMachineCodec(z.object({ plaintext: vaultMachineText })),
	encrypt: vaultMachineCodec(z.object({ ciphertext: vaultMachineText })),
	hmac: vaultMachineCodec(z.object({ hmac: vaultMachineText })),
	rewrap: vaultMachineCodec(z.object({ ciphertext: vaultMachineText })),
	sign: vaultMachineCodec(z.object({ signature: vaultMachineText })),
	verify: vaultMachineCodec(z.object({ valid: z.boolean() })),
};

// Each codec validates the fields the CLI and Desktop read and retains the
// complete decoded object, like the machine codecs above.
export function vaultReply<T>(fields: z.ZodType): z.ZodType<T> {
	return z.custom<T>(
		(value) =>
			appResponseValueSchema.safeParse(value).success &&
			fields.safeParse(value).success
	);
}

export const vaultText = z.string();

export const vaultDate = vaultMachineDate;

export const vaultNumber = vaultMachineNumber;

const vaultFlag = z.object({}).catchall(z.union([z.boolean(), vaultText]));

const vaultBrokerStatusFields = z.object({
	listening: z.boolean(),
	port: vaultNumber.nullable(),
	caUrl: vaultText,
	portEnv: vaultText,
});

const vaultBrokerServiceFields = z.object({
	name: vaultText,
	environment: vaultText,
	host: vaultText,
	pathPrefix: vaultText,
	enabled: z.boolean(),
	auth: appJsonValueSchema,
	createdAt: vaultDate,
	updatedAt: vaultDate,
});

const vaultBrokerSessionFields = z.object({
	id: vaultText,
	environment: vaultText,
	services: z.array(vaultText),
	label: vaultText,
	mintedBy: vaultText,
	createdAt: vaultDate,
	expiresAt: vaultDate,
});

const vaultBrokerProposalFields = z.object({
	id: vaultText,
	environment: vaultText,
	status: z.enum(["pending", "approved", "rejected", "expired"]),
	message: vaultText,
	services: z.array(appJsonValueSchema),
	credentials: z.array(z.object({ ref: vaultText })),
	requestedBy: vaultText,
	createdAt: vaultDate,
	expiresAt: vaultDate,
});

const vaultBrokerGrantFields = z.object({
	token: vaultText,
	session: vaultBrokerSessionFields,
	proxy: z
		.object({
			url: vaultText,
			port: vaultNumber,
			caPath: vaultText,
			caBundlePath: vaultText,
			caUrl: vaultText,
			env: z.record(z.string(), vaultText),
		})
		.nullable(),
});

export const vaultBrokerStatusReply = vaultReply<{ broker: VaultBrokerStatus }>(
	z.object({ broker: vaultBrokerStatusFields })
);

export const vaultBrokerCatalogReply = vaultReply<{
	templates: AppJsonValue[];
}>(z.object({ templates: z.array(appJsonValueSchema) }));

export const vaultBrokerServicesReply = vaultReply<{
	services: VaultBrokerService[];
}>(z.object({ services: z.array(vaultBrokerServiceFields) }));

export const vaultBrokerServiceReply = vaultReply<{
	service: VaultBrokerService;
}>(z.object({ service: vaultBrokerServiceFields }));

export const vaultBrokerGrantReply = vaultReply<VaultBrokerSessionGrant>(
	vaultBrokerGrantFields
);

export const vaultBrokerSessionsReply = vaultReply<{
	sessions: VaultBrokerSession[];
}>(z.object({ sessions: z.array(vaultBrokerSessionFields) }));

export const vaultBrokerLogsReply = vaultReply<{ logs: VaultBrokerLogRow[] }>(
	z.object({
		logs: z.array(
			z.object({
				id: vaultNumber,
				at: vaultDate,
				method: vaultText,
				host: vaultText,
				path: vaultText,
				status: vaultNumber,
				outcome: vaultText,
			})
		),
	})
);

export const vaultBrokerHostsReply = vaultReply<{
	hosts: VaultBrokerDiscoveredHost[];
}>(
	z.object({
		hosts: z.array(
			z.object({ host: vaultText, port: vaultNumber, requests: vaultNumber })
		),
	})
);

export const vaultBrokerProposalsReply = vaultReply<{
	proposals: VaultBrokerProposal[];
}>(z.object({ proposals: z.array(vaultBrokerProposalFields) }));

export const vaultBrokerProposalReply = vaultReply<{
	proposal: VaultBrokerProposal;
}>(z.object({ proposal: vaultBrokerProposalFields }));

export const vaultBrokerDecisionReply = vaultReply<
	{ approved: true; proposal: string } | { rejected: true }
>(vaultFlag);

export const vaultBrokerDiscoveryReply = vaultReply<VaultBrokerDiscovery>(
	z.object({
		environment: vaultText,
		services: z.array(appJsonValueSchema),
		proxy: vaultBrokerStatusFields,
		proposalsEndpoint: vaultText,
	})
);

export const vaultDeletedReply = vaultReply<{ deleted: boolean }>(
	z.object({ deleted: z.boolean() })
);

const vaultPmProviderField = z.enum([
	"1password-connect",
	"1password-service-account",
	"bitwarden-sm",
]);

const vaultPmAccountFields = z.object({
	id: vaultText,
	name: vaultText,
	provider: vaultPmProviderField,
	state: z.enum(["connected", "reconnect_required"]),
	address: vaultText.nullable(),
	createdAt: vaultDate,
});

export const vaultPmGrantFields = z.object({
	id: vaultText,
	subject: vaultText,
	account: vaultText,
	ref: vaultText,
	mode: z.enum(["once", "1h", "24h", "30d"]),
	expiresAt: vaultDate,
});

const vaultPmApprovalFields = vaultBrokerProposalFields.extend({
	credentialUse: z.object({
		ref: vaultText,
		account: vaultText,
		provider: vaultPmProviderField,
		subject: vaultText,
	}),
});

export const vaultPmAccountsReply = vaultReply<{
	accounts: VaultPasswordManagerAccount[];
}>(z.object({ accounts: z.array(vaultPmAccountFields) }));

export const vaultPmAccountReply = vaultReply<{
	account: VaultPasswordManagerAccount;
}>(z.object({ account: vaultPmAccountFields }));

export const vaultPmTestReply = vaultReply<VaultPasswordManagerTestResult>(
	z.object({ ok: z.boolean(), account: vaultPmAccountFields.nullable() })
);

export const vaultPmReadReply = vaultReply<VaultPasswordManagerReadResult>(
	z.union([
		z.object({
			value: vaultText,
			ref: vaultText,
			account: vaultText,
			provider: vaultPmProviderField,
		}),
		z.object({ pending: z.literal(true), approval: vaultPmApprovalFields }),
	])
);

export const vaultPmGrantsReply = vaultReply<{
	grants: VaultPasswordManagerGrant[];
}>(z.object({ grants: z.array(vaultPmGrantFields) }));

export const vaultPmRevokeReply = vaultReply<{
	grant: VaultPasswordManagerGrant;
	revoked: true;
}>(z.object({ revoked: z.literal(true), grant: vaultPmGrantFields }));

export const vaultPmApprovalsReply = vaultReply<{
	approvals: VaultBrokerProposal[];
}>(z.object({ approvals: z.array(vaultPmApprovalFields) }));
