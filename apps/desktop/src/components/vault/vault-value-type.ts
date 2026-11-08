// Value types for vault values (`config`, `secret`, `sealed`). Kept free of
// React so the rules are unit-tested directly. The wire field is
// `metadata.valueType`; a value written before types existed has none and is
// a `secret`.

import type { VaultSecretMetadataPatch } from "@/src/lib/api/vault.ts";

export const VAULT_VALUE_TYPES = ["config", "secret", "sealed"] as const;
export type VaultValueType = (typeof VAULT_VALUE_TYPES)[number];
export const DEFAULT_VALUE_TYPE: VaultValueType = "secret";

export const VALUE_TYPE_COPY = {
	config: {
		label: "Config",
		description: "Not sensitive. Shown in full to anyone who can read it.",
	},
	secret: {
		label: "Secret",
		description: "Hidden until someone who can read it reveals it.",
	},
	sealed: {
		label: "Sealed",
		description:
			"Use-only. Apps and tools can use it, but nobody can reveal or export it, and it can't be unsealed.",
	},
} satisfies Record<VaultValueType, { label: string; description: string }>;

/** The type a listing row carries, defaulting rows from older nodes to `secret`. */
export function valueTypeOf(metadata: object): VaultValueType {
	const raw: unknown = Reflect.get(metadata, "valueType");
	return VAULT_VALUE_TYPES.find((type) => type === raw) ?? DEFAULT_VALUE_TYPE;
}

/** The types a value of `current` may change to: a sealed value stays sealed. */
export function valueTypeChoices(
	current: VaultValueType | null
): readonly VaultValueType[] {
	return current === "sealed" ? ["sealed"] : VAULT_VALUE_TYPES;
}

/** Whether a value of this type can be revealed or exported. */
export function isRevealable(type: VaultValueType): boolean {
	return type !== "sealed";
}

/**
 * A metadata patch carrying `valueType`. The field is added only when it
 * changes, so a save never sends a type the caller did not pick.
 */
export function withValueType(
	patch: VaultSecretMetadataPatch,
	current: VaultValueType | null,
	next: VaultValueType
): VaultSecretMetadataPatch {
	if (current === next) {
		return patch;
	}
	const out: VaultSecretMetadataPatch & { valueType?: VaultValueType } = {
		...patch,
		valueType: next,
	};
	return out;
}
