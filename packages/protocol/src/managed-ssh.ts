import { z } from "zod";
import { wireObject } from "./wire-object.ts";

/** Browser-generated SSH access. The control plane never receives a private key. */
export interface ManagedSshPassphraseBackup {
	algorithm: "PBKDF2-SHA256/AES-256-GCM";
	ciphertext: string;
	iterations: 600000;
	iv: string;
	salt: string;
	version: 1;
}

export interface ManagedSshSharePolicy {
	managed: number;
	threshold: number;
	total: number;
}

export interface ManagedSshRecoveryShare {
	index: number;
	recoveryId: string;
	scope: string;
	value: string;
	version: 1;
}

export interface ManagedSshRecoveryBackup {
	algorithm: "SHAMIR-GF256/AES-256-GCM";
	ciphertext: string;
	iv: string;
	managedShares: ManagedSshRecoveryShare[];
	policy: ManagedSshSharePolicy;
	recoveryId: string;
	scope: string;
	version: 2;
}

export type ManagedSshBackup =
	| ManagedSshPassphraseBackup
	| ManagedSshRecoveryBackup;

export interface ManagedUserSshAccess {
	backup: ManagedSshBackup | null;
	backupAvailable?: boolean;
	fingerprint: string | null;
	publicKey: string | null;
	recoveryPolicy?: ManagedSshSharePolicy;
	state: "disabled" | "setup-required" | "pending" | "installed" | "revoked";
	userId: string;
	username: string | null;
}

export interface ManagedSshPolicy {
	canManage: boolean;
	enabled: boolean;
}

export interface ManagedSshAccess {
	backup: ManagedSshBackup | null;
	backupAvailable?: boolean;
	fingerprint: string | null;
	publicKey: string | null;
	recoveryPolicy?: ManagedSshSharePolicy;
	state: "setup-required" | "owner-managed" | "legacy" | "unavailable";
}

export interface ManagedSshSetup {
	backup: ManagedSshBackup | null;
	publicKey: string;
}

export const SSH_BACKUP_ITERATIONS = 600_000;

const base64Alphabet =
	"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const scopeSchema = z
	.string()
	.min(1)
	.max(300)
	.regex(/^[A-Za-z0-9:_./-]+$/u);
const recoveryIdSchema = z
	.string()
	.regex(
		/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
	);
const ivSchema = z.string().regex(/^[A-Za-z0-9+/]{16}$/u);
const ciphertextSchema = z
	.string()
	.min(100)
	.max(16_384)
	.regex(/^[A-Za-z0-9+/]+={0,2}$/u)
	.refine((value) => value.length % 4 === 0);

function countedWireObject<T extends z.ZodRawShape>(fields: T) {
	const count = Object.keys(fields).length;
	const admission = z.custom<object>((value) => {
		const wrapped = new Object(value);
		return (
			wrapped === value &&
			!Array.isArray(value) &&
			!z.function().safeParse(value).success &&
			Object.keys(wrapped).length === count
		);
	});
	return z.preprocess((value, context) => {
		const result = admission.safeParse(value);
		if (!result.success) {
			context.addIssue({
				code: "custom",
				message: "Invalid envelope field count",
			});
			return z.NEVER;
		}
		return result.data;
	}, wireObject(fields));
}

export const managedSshSharePolicySchema = countedWireObject({
	total: z.number().int().min(2).max(255),
	threshold: z.number().int().min(2),
	managed: z.number().int().min(0),
}).refine(
	(value) => value.threshold <= value.total && value.managed < value.threshold
);

export const managedSshRecoveryShareSchema = countedWireObject({
	version: z.literal(1),
	scope: scopeSchema,
	recoveryId: recoveryIdSchema,
	index: z.number().int().min(1).max(255),
	value: z.string().regex(/^[A-Za-z0-9+/]{44}$/u),
}).refine(
	(share) =>
		(base64Alphabet.indexOf(share.value.charAt(42)) & 3) * 64 +
			base64Alphabet.indexOf(share.value.charAt(43)) ===
		share.index
);

// Check the policy and share count before invoking any element schema.
const recoveryBackupAdmission = z
	.object({
		policy: managedSshSharePolicySchema,
		managedShares: z.custom<unknown[]>(Array.isArray),
	})
	.refine((backup) => backup.managedShares.length === backup.policy.managed);
const recoveryBackupSchema = z
	.unknown()
	.refine((value) => recoveryBackupAdmission.safeParse(value).success)
	.pipe(
		countedWireObject({
			version: z.literal(2),
			algorithm: z.literal("SHAMIR-GF256/AES-256-GCM"),
			scope: scopeSchema,
			recoveryId: recoveryIdSchema,
			policy: managedSshSharePolicySchema,
			iv: ivSchema,
			ciphertext: ciphertextSchema,
			managedShares: z.array(managedSshRecoveryShareSchema),
		}).refine((backup) => {
			const indices = new Set<number>();
			return (
				backup.managedShares.length === backup.policy.managed &&
				backup.managedShares.every((share) => {
					if (
						share.scope !== backup.scope ||
						share.recoveryId !== backup.recoveryId ||
						indices.has(share.index)
					) {
						return false;
					}
					indices.add(share.index);
					return true;
				})
			);
		})
	);
const passphraseBackupSchema = wireObject(
	{
		version: z.literal(1),
		algorithm: z.literal("PBKDF2-SHA256/AES-256-GCM"),
		iterations: z.literal(SSH_BACKUP_ITERATIONS),
		salt: z.string().regex(/^[A-Za-z0-9+/]{22}==$/u),
		iv: ivSchema,
		ciphertext: ciphertextSchema,
	},
	true
);
export const managedSshBackupSchema = z.union([
	recoveryBackupSchema,
	passphraseBackupSchema,
]);

export function isManagedSshScope(
	value: Parameters<typeof scopeSchema.safeParse>[0]
): value is string {
	return scopeSchema.safeParse(value).success;
}
export function isManagedSshSharePolicy(
	value: Parameters<typeof managedSshSharePolicySchema.safeParse>[0]
): value is ManagedSshSharePolicy {
	return managedSshSharePolicySchema.safeParse(value).success;
}
export function isManagedSshRecoveryShare(
	value: Parameters<typeof managedSshRecoveryShareSchema.safeParse>[0]
): value is ManagedSshRecoveryShare {
	return managedSshRecoveryShareSchema.safeParse(value).success;
}
/** Strict, bounded envelope; no arbitrary JSON or plaintext secret fields. */
export function isManagedSshBackup(
	value: Parameters<typeof managedSshBackupSchema.safeParse>[0]
): value is ManagedSshBackup {
	return managedSshBackupSchema.safeParse(value).success;
}
