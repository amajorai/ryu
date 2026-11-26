// Form models for machine identities: a new AppRole, an AppRole secret id,
// and a machine token. Each turns the typed fields into the exact body Core
// takes, or the first problem, so nothing is sent from a form that would be
// refused or silently mean something else.

import { translate } from "@ryu/i18n/core";
import type {
	VaultAppRoleInput,
	VaultMachine,
	VaultMachineTokenInput,
	VaultSecretIdInput,
} from "@/src/lib/api/vault-machines.ts";
import { DYNAMIC_ROLE_NAME } from "./vault-dynamic-form.ts";
import { listField } from "./vault-token-role-form.ts";
import { parseTtl } from "./vault-ttl.ts";

/** Core clamps an identity's token TTL to 1m..24h (`vault/machine.rs`) and a
 *  minted token's to 10s..24h (`vault/tokens/admit_create.rs`). A value outside is
 *  refused here rather than silently clamped there. */
export const MIN_TOKEN_TTL_SECS = 60;
export const MIN_ISSUED_TTL_SECS = 10;
export const MAX_TOKEN_TTL_SECS = 86_400;
const DURATION_PROBLEM = "Durations look like 90s, 15m, 1h or 7d.";

type Parsed<T> = { input: T } | { problem: string };

/** A blank field is `undefined`; anything else must be a whole number ≥ 1. */
function count(text: string): number | null | undefined {
	const trimmed = text.trim();
	if (trimmed === "") {
		return;
	}
	const value = Number(trimmed);
	return Number.isSafeInteger(value) && value >= 1 ? value : null;
}

export interface AppRoleForm {
	name: string;
	policies: string;
	ttl: string;
}

export function appRoleInput(form: AppRoleForm): Parsed<VaultAppRoleInput> {
	const name = form.name.trim();
	if (!DYNAMIC_ROLE_NAME.test(name)) {
		return {
			problem: translate(
				"Name: lowercase letters, digits, - and _, starting with a letter or digit."
			),
		};
	}
	const ttl = parseTtl(form.ttl);
	if (ttl === null) {
		return { problem: translate(DURATION_PROBLEM) };
	}
	if (
		ttl !== undefined &&
		(ttl < MIN_TOKEN_TTL_SECS || ttl > MAX_TOKEN_TTL_SECS)
	) {
		return { problem: translate("Token lifetime must be from 1m to 24h.") };
	}
	return {
		input: {
			name,
			policies: listField(form.policies),
			...(ttl === undefined ? {} : { tokenTtlSecs: ttl }),
		},
	};
}

export interface SecretIdForm {
	cidrs: string;
	ttl: string;
	uses: string;
}

export function secretIdInput(form: SecretIdForm): Parsed<VaultSecretIdInput> {
	const ttl = parseTtl(form.ttl);
	if (ttl === null) {
		return { problem: translate(DURATION_PROBLEM) };
	}
	const uses = count(form.uses);
	if (uses === null) {
		return { problem: translate("Uses must be a whole number of 1 or more.") };
	}
	const cidrList = listField(form.cidrs);
	return {
		input: {
			...(ttl === undefined ? {} : { ttlSecs: ttl }),
			...(uses === undefined ? {} : { uses }),
			...(cidrList.length ? { cidrList } : {}),
		},
	};
}

export interface MachineTokenForm {
	role: string;
	ttl: string;
	uses: string;
}

export function machineTokenInput(
	form: MachineTokenForm
): Parsed<VaultMachineTokenInput> {
	const ttl = parseTtl(form.ttl);
	if (ttl === null) {
		return { problem: translate(DURATION_PROBLEM) };
	}
	if (
		ttl !== undefined &&
		(ttl < MIN_ISSUED_TTL_SECS || ttl > MAX_TOKEN_TTL_SECS)
	) {
		return { problem: translate("A token is valid for 10s to 24h.") };
	}
	const uses = count(form.uses);
	if (uses === null) {
		return { problem: translate("Uses must be a whole number of 1 or more.") };
	}
	const role = form.role.trim();
	return {
		input: {
			...(role ? { role } : {}),
			...(ttl === undefined ? {} : { ttlSecs: ttl }),
			...(uses === undefined ? {} : { numUses: uses }),
		},
	};
}

const KIND_LABELS: Record<string, string> = {
	approle: "AppRole",
	jwt: "JWT",
	cert: "TLS certificate",
	"aws-iam": "AWS IAM",
	kubernetes: "Kubernetes",
};

/** How an identity logs in, for its row. */
export function machineKindLabel(machine: VaultMachine): string {
	const label = KIND_LABELS[machine.auth.kind];
	return label ? translate(label) : machine.auth.kind;
}

/** Only AppRole identities log in with secret ids. */
export function usesSecretIds(machine: VaultMachine): boolean {
	return machine.auth.kind === "approle";
}
