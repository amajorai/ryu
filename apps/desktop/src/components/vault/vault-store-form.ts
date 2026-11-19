// Form models for vault-to-vault stores (OpenBao, HashiCorp Vault and
// Infisical) and the sources that read a remote path into a node folder.
// Credentials stay in the form only until it is submitted; Core never
// returns them.

import { translate } from "@ryu/i18n/core";
import type {
	VaultExternalSourceInput,
	VaultExternalStoreInput,
} from "@/src/lib/api/vault-external.ts";
import { parseTtl } from "./vault-ttl.ts";
import { normalizeFolder } from "./vault-view.ts";

export type KvStoreKind = "openbao" | "hashicorp-vault" | "infisical";
export type KvAuthMethod =
	| "token"
	| "approle"
	| "kubernetes"
	| "universal-auth";

export const KV_STORES = [
	{ kind: "openbao", label: "OpenBao" },
	{ kind: "hashicorp-vault", label: "HashiCorp Vault" },
	{ kind: "infisical", label: "Infisical" },
] as const satisfies readonly { kind: KvStoreKind; label: string }[];

export const KV_AUTH_METHODS: Record<KvStoreKind, readonly KvAuthMethod[]> = {
	openbao: ["token", "approle", "kubernetes"],
	"hashicorp-vault": ["token", "approle", "kubernetes"],
	infisical: ["token", "universal-auth"],
};

export const AUTH_LABELS: Record<KvAuthMethod, string> = {
	token: "Token",
	approle: "AppRole",
	kubernetes: "Kubernetes service account",
	"universal-auth": "Universal auth",
};

export function kvStoreLabel(kind: string): string | null {
	return KV_STORES.find((store) => store.kind === kind)?.label ?? null;
}

export interface KvStoreForm {
	address: string;
	authMethod: KvAuthMethod;
	authMount: string;
	clientId: string;
	clientSecret: string;
	infisicalEnvironment: string;
	kind: KvStoreKind;
	kvVersion: "1" | "2";
	mount: string;
	name: string;
	namespace: string;
	pathPrefix: string;
	projectId: string;
	role: string;
	roleId: string;
	secretId: string;
	secretPath: string;
	token: string;
}

export function emptyKvStoreForm(kind: KvStoreKind = "openbao"): KvStoreForm {
	return {
		address: "",
		authMethod: "token",
		authMount: "",
		clientId: "",
		clientSecret: "",
		infisicalEnvironment: "",
		kind,
		kvVersion: "2",
		mount: kind === "infisical" ? "" : "secret",
		name: "",
		namespace: "",
		pathPrefix: "",
		projectId: "",
		role: "",
		roleId: "",
		secretId: "",
		secretPath: "",
		token: "",
	};
}

const STORE_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function optional(value: string): string | undefined {
	const trimmed = value.trim();
	return trimmed === "" ? undefined : trimmed;
}

function credentials(
	form: KvStoreForm
):
	| { credentials: VaultExternalStoreInput["credentials"] }
	| { problem: string } {
	switch (form.authMethod) {
		case "token":
			return form.token.trim()
				? { credentials: { token: form.token.trim() } }
				: { problem: translate("Enter a token.") };
		case "approle":
			return form.roleId.trim() && form.secretId.trim()
				? {
						credentials: {
							roleId: form.roleId.trim(),
							secretId: form.secretId.trim(),
						},
					}
				: { problem: translate("Enter the role id and secret id.") };
		case "universal-auth":
			return form.clientId.trim() && form.clientSecret.trim()
				? {
						credentials: {
							clientId: form.clientId.trim(),
							clientSecret: form.clientSecret.trim(),
						},
					}
				: { problem: translate("Enter the client id and client secret.") };
		default:
			return form.role.trim()
				? { credentials: {} }
				: { problem: translate("Enter the Kubernetes auth role.") };
	}
}

/** The request body for a store form, or the first problem with it. */
export function kvStoreInput(
	form: KvStoreForm
): { input: VaultExternalStoreInput } | { problem: string } {
	const name = form.name.trim();
	if (!STORE_NAME.test(name)) {
		return {
			problem: translate(
				"Name: lowercase letters, digits, - and _, starting with a letter or digit."
			),
		};
	}
	if (!form.address.trim()) {
		return { problem: translate("Enter the store address.") };
	}
	if (!KV_AUTH_METHODS[form.kind].includes(form.authMethod)) {
		return {
			problem: translate("Choose a sign-in method this store supports."),
		};
	}
	const infisical = form.kind === "infisical";
	if (
		infisical &&
		!(form.projectId.trim() && form.infisicalEnvironment.trim())
	) {
		return {
			problem: translate("Enter the Infisical project id and environment."),
		};
	}
	if (!(infisical || form.mount.trim())) {
		return { problem: translate("Enter the KV mount.") };
	}
	const built = credentials(form);
	if ("problem" in built) {
		return built;
	}
	const common = {
		name,
		kind: form.kind,
		address: form.address.trim(),
		authMethod: form.authMethod,
		credentials: built.credentials,
		pathPrefix: optional(form.pathPrefix),
	};
	if (infisical) {
		return {
			input: {
				...common,
				projectId: form.projectId.trim(),
				infisicalEnvironment: form.infisicalEnvironment.trim(),
				secretPath: optional(form.secretPath),
			},
		};
	}
	return {
		input: {
			...common,
			mount: form.mount.trim(),
			kvVersion: form.kvVersion === "1" ? 1 : 2,
			namespace: optional(form.namespace),
			authMount: optional(form.authMount),
			role: form.authMethod === "kubernetes" ? form.role.trim() : undefined,
		},
	};
}

export interface SourceForm {
	interval: string;
	mode: "live" | "sync";
	path: string;
	remotePath: string;
	storeId: string;
}

/** The request body for a source form, or the first problem with it. */
export function sourceInput(
	form: SourceForm,
	environment: string
): { input: VaultExternalSourceInput } | { problem: string } {
	if (!form.storeId) {
		return { problem: translate("Connect a store first.") };
	}
	if (!form.path.trim()) {
		return { problem: translate("Enter the folder to fill.") };
	}
	const interval = parseTtl(form.interval);
	if (interval === null) {
		return { problem: translate("Durations look like 90s, 15m, 1h or 7d.") };
	}
	return {
		input: {
			storeId: form.storeId,
			environment,
			path: normalizeFolder(form.path),
			mode: form.mode,
			remotePath: optional(form.remotePath),
			...(form.mode === "sync" && interval !== undefined
				? { syncIntervalSecs: interval }
				: {}),
		},
	};
}
