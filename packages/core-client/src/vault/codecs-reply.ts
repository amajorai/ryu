// packages/core-client/src/vault/codecs-reply.ts
//
// Reply codecs for the password-manager, TOTP, item, card, and token surfaces
// of the Secret Vault client. `../vault.ts` re-exports the public names and
// documents the wire conventions.

import { z } from "zod";
import { type AppJsonValue, appJsonValueSchema } from "../app-request-json.ts";
import type { VaultCardApproval } from "./cards.ts";
import {
	vaultDate,
	vaultMachineCodec,
	vaultMachineDate,
	vaultMachineNumber,
	vaultNumber,
	vaultPmGrantFields,
	vaultReply,
	vaultText,
} from "./codecs-machine.ts";
import type { VaultCardPending } from "./internal.ts";
import type { VaultItem, VaultItemEvent, VaultItemSummary } from "./items.ts";
import type { VaultPasswordManagerGrant } from "./password-manager.ts";
import type {
	VaultCubbyholeEntry,
	VaultRevokeReport,
	VaultTokenInfo,
	VaultTokenRole,
	VaultWrapInfo,
} from "./tokens.ts";
import type {
	VaultPasswordPolicy,
	VaultTotpCode,
	VaultTotpCreated,
	VaultTotpKey,
} from "./totp.ts";
import { VAULT_VALUE_TYPES } from "./value-types.ts";

export const vaultPmDecisionReply = vaultReply<
	| { approved: true; grant: VaultPasswordManagerGrant; proposal: string }
	| { rejected: true }
>(
	z.union([
		z.object({
			approved: z.literal(true),
			proposal: vaultText,
			grant: vaultPmGrantFields,
		}),
		z.object({ rejected: z.literal(true) }),
	])
);

const vaultTotpKeyFields = z.object({
	name: vaultText,
	issuer: vaultText,
	account: vaultText,
	algorithm: z.enum(["SHA1", "SHA256", "SHA512"]),
	digits: vaultNumber,
	period: vaultNumber,
});

export const vaultTotpKeysReply = vaultReply<{ keys: VaultTotpKey[] }>(
	z.object({ keys: z.array(vaultTotpKeyFields) })
);

export const vaultTotpKeyReply = vaultReply<{ key: VaultTotpKey }>(
	z.object({ key: vaultTotpKeyFields })
);

export const vaultTotpCreatedReply = vaultReply<VaultTotpCreated>(
	z.object({ key: vaultTotpKeyFields, url: vaultText.optional() })
);

export const vaultTotpCodeReply = vaultReply<VaultTotpCode>(
	z.object({
		code: vaultText,
		period: vaultNumber,
		remainingSecs: vaultNumber,
	})
);

export const vaultValidReply = vaultReply<{ valid: boolean }>(
	z.object({ valid: z.boolean() })
);

const vaultPasswordPolicyFields = z.object({
	name: vaultText,
	length: vaultNumber,
	rules: z.array(z.object({ charset: vaultText })),
});

export const vaultPasswordPoliciesReply = vaultReply<{
	policies: VaultPasswordPolicy[];
}>(z.object({ policies: z.array(vaultPasswordPolicyFields) }));

export const vaultPasswordPolicyReply = vaultReply<{
	policy: VaultPasswordPolicy;
}>(z.object({ policy: vaultPasswordPolicyFields }));

export const vaultPasswordReply = vaultReply<{ password: string }>(
	z.object({ password: vaultText })
);

const vaultItemStatus = z.enum(["pending_collection", "ready"]);

const vaultItemFields = z.object({
	id: vaultText,
	environment: vaultText,
	path: vaultText,
	key: vaultText,
	kind: vaultText,
	version: vaultNumber,
	status: vaultItemStatus,
	fields: z.array(
		z.object({
			name: vaultText,
			type: vaultText,
			sensitive: z.boolean(),
			hasValue: z.boolean(),
		})
	),
});

export const vaultItemsReply = vaultReply<{ items: VaultItemSummary[] }>(
	z.object({
		items: z.array(
			z.object({
				id: vaultText,
				key: vaultText,
				kind: vaultText,
				version: vaultNumber,
				status: vaultItemStatus,
			})
		),
	})
);

export const vaultItemReply = vaultReply<{ item: VaultItem }>(
	z.object({ item: vaultItemFields })
);

export const vaultItemRevealReply = vaultReply<{
	field: string;
	value: string;
}>(z.object({ field: vaultText, value: vaultText }));

export const vaultItemEventsReply = vaultReply<{
	events: VaultItemEvent[];
	next: number;
}>(
	z.object({
		events: z.array(z.object({ seq: vaultNumber, name: vaultText })),
		next: vaultNumber,
	})
);

export const CARD_OPTIONAL_FIELDS = [
	"cvc",
	"postalCode",
	"country",
	"addressLine1",
	"addressLine2",
	"city",
	"region",
] as const;

const vaultCardApprovalFields = z.object({
	id: vaultText,
	key: vaultText,
	channel: z.enum(["broker", "fill", "reveal"]),
	merchantHost: z.string(),
	status: z.enum([
		"pending",
		"approved",
		"rejected",
		"expired",
		"consumed",
		"revoked",
	]),
	uses: vaultNumber,
});

export const vaultCardApprovalReply = vaultReply<{
	approval: VaultCardApproval;
}>(z.object({ approval: vaultCardApprovalFields }));

export const vaultCardApprovalsReply = vaultReply<{
	approvals: VaultCardApproval[];
}>(z.object({ approvals: z.array(vaultCardApprovalFields) }));

const vaultCardPendingFields = z.object({
	status: z.literal("approval_required"),
	approval: vaultCardApprovalFields,
	approvePath: vaultText,
});

export const vaultCardFillReply = vaultReply<
	| VaultCardPending
	| {
			approvalId: string;
			card: { brand?: string; last4?: string };
			fields: Record<string, string>;
			origin: string;
	  }
>(
	z.union([
		vaultCardPendingFields,
		z.object({
			origin: vaultText,
			fields: z.record(z.string(), z.string()),
			approvalId: vaultText,
		}),
	])
);

export const vaultCardRevealReply = vaultReply<
	VaultCardPending | { field: string; value: string }
>(
	z.union([
		vaultCardPendingFields,
		z.object({ field: vaultText, value: vaultText }),
	])
);

/** Header asking Core to wrap a response (`300`, `300s`, `5m`, or `1h`). */
export const VAULT_WRAP_TTL_HEADER = "x-ryu-wrap-ttl";

const vaultTokenInfoFields = z.object({
	accessor: vaultText,
	identityId: vaultText,
	policies: z.array(vaultText),
	expiresAt: vaultDate,
	renewable: z.boolean(),
	ttlSecs: vaultNumber,
});

export const vaultTokensReply = vaultReply<{ tokens: VaultTokenInfo[] }>(
	z.object({ tokens: z.array(vaultTokenInfoFields) })
);

export const vaultTokenInfoReply = vaultReply<{ token: VaultTokenInfo }>(
	z.object({ token: vaultTokenInfoFields })
);

export const vaultTokenSelfReply = vaultReply<{
	effectivePolicies: string[];
	token: VaultTokenInfo;
}>(
	z.object({
		token: vaultTokenInfoFields,
		effectivePolicies: z.array(vaultText),
	})
);

export const vaultRevokeReportReply = vaultReply<{
	revoked: VaultRevokeReport;
}>(
	z.object({
		revoked: z.object({
			tokens: vaultNumber,
			leasesRevoked: vaultNumber,
			leasesFailed: vaultNumber,
		}),
	})
);

const vaultTokenRoleFields = z.object({
	name: vaultText,
	allowedPolicies: z.array(vaultText),
	disallowedPolicies: z.array(vaultText),
	orphan: z.boolean(),
});

export const vaultTokenRolesReply = vaultReply<{ roles: VaultTokenRole[] }>(
	z.object({ roles: z.array(vaultTokenRoleFields) })
);

export const vaultTokenRoleReply = vaultReply<{ role: VaultTokenRole }>(
	z.object({ role: vaultTokenRoleFields })
);

export const vaultWrapInfoReply = vaultReply<{ wrapInfo: VaultWrapInfo }>(
	z.object({
		wrapInfo: z.object({
			accessor: vaultText,
			ttlSecs: vaultNumber,
			creationPath: vaultText,
			expiresAt: vaultDate,
		}),
	})
);

export const vaultUnwrappedReply = vaultReply<Record<string, AppJsonValue>>(
	z.record(z.string(), appJsonValueSchema)
);

export const vaultCubbyholeKeysReply = vaultReply<{
	keys: VaultCubbyholeEntry[];
}>(z.object({ keys: z.array(z.object({ key: vaultText })) }));

export const vaultCubbyholeValueReply = vaultReply<{ value: AppJsonValue }>(
	z.object({ value: appJsonValueSchema })
);

export const vaultWrittenReply = vaultReply<{ written: boolean }>(
	z.object({ written: z.boolean() })
);

// Full human response owners: vault_api.rs renderers plus their native serde models.
// Validate every declared publisher field and retain the complete decoded object.
export const vaultHumanText = z.string();

export const vaultHumanNumber = vaultMachineNumber;

export const vaultHumanTimestamp = vaultMachineDate;

export const vaultHumanScope = z.enum(["user", "node", "team", "org"]);

export const vaultHumanCapabilities = z.array(
	z.enum(["list", "use", "read", "write", "delete", "admin", "approve"])
);

export const vaultHumanBinding = vaultMachineCodec(
	z.object({ kind: z.literal("mcp"), id: vaultHumanText })
);

export const vaultHumanCoords = vaultMachineCodec(
	z.object({
		scope: vaultHumanScope,
		scopeId: vaultHumanText,
		environment: vaultHumanText,
		path: vaultHumanText,
		name: vaultHumanText,
		binding: vaultHumanBinding.optional(),
	})
);

const vaultHumanGenerator = vaultMachineCodec(
	z.object({
		kind: z.literal("random"),
		charset: z.enum(["alphanumeric", "hex", "base64url", "symbols"]),
		length: vaultHumanNumber,
	})
);

const vaultHumanMetadata = vaultMachineCodec(
	z.object({
		description: vaultHumanText,
		tags: z.array(vaultHumanText),
		expiresAt: vaultHumanTimestamp.nullable(),
		rotationPeriodSecs: vaultHumanNumber.nullable(),
		generator: vaultHumanGenerator.nullable(),
		expandReferences: z.boolean(),
		maxVersions: vaultHumanNumber,
		// A type this client does not know still validates; `vaultValueType`
		// reads it as sealed.
		valueType: z.enum(VAULT_VALUE_TYPES).optional().catch("sealed"),
	})
);

export const vaultHumanSecret = vaultMachineCodec(
	z.object({
		scope: vaultHumanScope,
		scopeId: vaultHumanText,
		environment: vaultHumanText,
		path: vaultHumanText,
		name: vaultHumanText,
		binding: vaultHumanBinding.optional(),
		version: vaultHumanNumber,
		status: z.enum(["active", "expired", "rotation_due", "deleted"]),
		metadata: vaultHumanMetadata,
		capabilities: vaultHumanCapabilities,
		createdAt: vaultHumanTimestamp.nullable(),
		createdBy: vaultHumanText.nullable(),
		updatedAt: vaultHumanTimestamp.nullable(),
		updatedBy: vaultHumanText.nullable(),
		rotatedAt: vaultHumanTimestamp.nullable(),
		deletedAt: vaultHumanTimestamp.nullable().optional(),
		source: vaultHumanText.optional(),
	})
);

export const vaultHumanSeal = vaultMachineCodec(
	z.object({
		mode: z.enum(["auto", "shamir"]),
		sealed: z.boolean(),
		shares: vaultHumanNumber,
		threshold: vaultHumanNumber,
		progress: vaultHumanNumber,
		keyVersions: z.array(vaultHumanNumber),
		activeKeyVersion: vaultHumanNumber,
	})
);

const vaultHumanNode = vaultMachineCodec(
	z.object({
		id: vaultHumanText,
		scope: z.enum(["local", "org", "team", "personal"]),
		orgId: vaultHumanText.nullable(),
		teamId: vaultHumanText.nullable(),
		ownerUserId: vaultHumanText.nullable(),
	})
);

const vaultHumanCaller = vaultMachineCodec(
	z.object({
		userId: vaultHumanText,
		orgId: vaultHumanText.nullable(),
		role: z.enum(["owner", "admin", "member", "viewer"]),
		teamIds: z.array(vaultHumanText),
	})
);

export const vaultHumanList = vaultMachineCodec(
	z.object({
		secrets: z.array(vaultHumanSecret),
		node: vaultHumanNode,
		caller: vaultHumanCaller.nullable(),
		canManageShared: z.boolean(),
		sharedRemote: z.boolean(),
		sharedError: vaultHumanText.nullable(),
		activeEnvironment: vaultHumanText,
		seal: vaultHumanSeal,
	})
);

export const vaultHumanApproval = vaultMachineCodec(
	z.object({ by: vaultHumanText, at: vaultHumanTimestamp.nullable() })
);
