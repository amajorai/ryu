// packages/core-client/src/vault/value-types.ts
//
// Value types: part of the Secret Vault client. `../vault.ts` re-exports
// these names and documents the wire conventions.

/** Every value type, in order of increasing sensitivity. */
export const VAULT_VALUE_TYPES = ["config", "secret", "sealed"] as const;

/**
 * How sensitive a value is (`metadata.valueType`). `config` is plain
 * configuration, `secret` (the default) is hidden until someone reveals it,
 * and `sealed` is use-only: it resolves at run time but is never revealed or
 * exported.
 */
export type VaultValueType = (typeof VAULT_VALUE_TYPES)[number];

const KNOWN_VALUE_TYPES: ReadonlySet<string> = new Set(VAULT_VALUE_TYPES);

/**
 * The type of a value as Core enforces it: a value written before types
 * existed (no `valueType`) is a `secret`, and a type this client does not
 * know reads as `sealed`, so an unknown type never makes a value less
 * protected.
 */
export function vaultValueType(
	metadata: { valueType?: string | null } | null | undefined
): VaultValueType {
	const stored = metadata?.valueType;
	if (stored === undefined || stored === null) {
		return "secret";
	}
	return KNOWN_VALUE_TYPES.has(stored) ? (stored as VaultValueType) : "sealed";
}
