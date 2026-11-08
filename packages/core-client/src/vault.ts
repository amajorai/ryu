// packages/core-client/src/vault.ts
//
// Typed client for Core's Secret Vault (`/api/vault/*`). Human routes ride the
// normal node bearer (plus the optional user JWT) through {@link request}.
// Machine routes (`/api/vault/auth/*` login and `/api/vault/agent/*`) are public
// mounts that authenticate in-handler, so they use {@link VaultAgentTarget} and
// send only `x-ryu-vault-token`: a CI runner never needs the node bearer.
//
// Wire conventions: JSON is camelCase. Core's response renderer formats epoch
// fields including `…At`, `notAfter`, `notBefore`, `validAfter`, `validBefore`,
// and approval `at` as RFC 3339 strings; out-of-range epochs remain numeric.
// The machine response codecs (`vault/codecs-machine.ts`) model that native
// domain; the legacy human response declarations are separate. Secret values
// only appear in explicit reveal/export/issue responses, never in listings,
// versions, or audit rows.
//
// The implementation lives in `./vault/`: one module per area, plus the
// response codecs (`vault/codecs-*.ts`). This file re-exports the public names.

export * from "./vault/agent-routes.ts";
export * from "./vault/audit.ts";
export * from "./vault/broker.ts";
export * from "./vault/cards.ts";
export * from "./vault/change-requests.ts";
export {
	VAULT_TOKEN_HEADER,
	VAULT_TRANSIT_KEY_TYPES,
} from "./vault/codecs-machine.ts";
export { VAULT_WRAP_TTL_HEADER } from "./vault/codecs-reply.ts";
export * from "./vault/dynamic.ts";
export * from "./vault/environments.ts";
export * from "./vault/items.ts";
export * from "./vault/machine-identities.ts";
export * from "./vault/password-manager.ts";
export * from "./vault/pki.ts";
export * from "./vault/policies.ts";
export * from "./vault/references.ts";
export * from "./vault/seal.ts";
export * from "./vault/shared.ts";
export * from "./vault/ssh.ts";
export * from "./vault/tokens.ts";
export * from "./vault/totp.ts";
export * from "./vault/transfer.ts";
export * from "./vault/transit.ts";
export * from "./vault/value-types.ts";
export * from "./vault/values.ts";
