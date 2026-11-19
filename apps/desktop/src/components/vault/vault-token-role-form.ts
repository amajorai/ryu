// Form model for token roles: named templates that cap the policies, TTLs,
// use counts and client addresses of machine tokens minted from them.

import { translate } from "@ryu/i18n/core";
import type {
	VaultTokenRole,
	VaultTokenRoleInput,
} from "@/src/lib/api/vault-token-roles.ts";
import { DYNAMIC_ROLE_NAME } from "./vault-dynamic-form.ts";
import { formatTtl, parseTtl } from "./vault-ttl.ts";

export interface TokenRoleForm {
	allowedPolicies: string;
	boundCidrs: string;
	disallowedPolicies: string;
	explicitMaxTtl: string;
	maxTtl: string;
	name: string;
	numUses: string;
	orphan: boolean;
	period: string;
	renewable: boolean;
	ttl: string;
}

export function tokenRoleForm(role: VaultTokenRole | null): TokenRoleForm {
	return {
		allowedPolicies: role?.allowedPolicies.join(", ") ?? "",
		boundCidrs: role?.boundCidrs?.join(", ") ?? "",
		disallowedPolicies: role?.disallowedPolicies.join(", ") ?? "",
		explicitMaxTtl: formatTtl(role?.explicitMaxTtlSecs),
		maxTtl: formatTtl(role?.maxTtlSecs),
		name: role?.name ?? "",
		numUses: role?.numUses ? String(role.numUses) : "",
		orphan: role?.orphan ?? false,
		period: formatTtl(role?.periodSecs),
		renewable: role?.renewable ?? true,
		ttl: formatTtl(role?.ttlSecs),
	};
}

/** Comma- or newline-separated names, trimmed and de-duplicated. */
export function listField(text: string): string[] {
	return [
		...new Set(
			text
				.split(/[,\n]/)
				.map((item) => item.trim())
				.filter(Boolean)
		),
	];
}

/** The role name and the full replacement body, or the first problem. */
export function tokenRoleInput(
	form: TokenRoleForm
): { input: VaultTokenRoleInput; name: string } | { problem: string } {
	const name = form.name.trim();
	if (!DYNAMIC_ROLE_NAME.test(name)) {
		return {
			problem: translate(
				"Name: lowercase letters, digits, - and _, starting with a letter or digit."
			),
		};
	}
	const ttls = {
		ttlSecs: parseTtl(form.ttl),
		maxTtlSecs: parseTtl(form.maxTtl),
		explicitMaxTtlSecs: parseTtl(form.explicitMaxTtl),
		periodSecs: parseTtl(form.period),
	};
	if (Object.values(ttls).includes(null)) {
		return { problem: translate("Durations look like 90s, 15m, 1h or 7d.") };
	}
	const uses = form.numUses.trim();
	const numUses = uses === "" ? undefined : Number(uses);
	if (numUses !== undefined && !(Number.isInteger(numUses) && numUses >= 0)) {
		return { problem: translate("Uses must be a whole number.") };
	}
	const allowedPolicies = listField(form.allowedPolicies);
	const disallowedPolicies = listField(form.disallowedPolicies);
	const overlap = allowedPolicies.find((item) =>
		disallowedPolicies.includes(item)
	);
	if (overlap) {
		return {
			problem: translate("{policy} is both allowed and disallowed.", {
				policy: overlap,
			}),
		};
	}
	const boundCidrs = listField(form.boundCidrs);
	return {
		name,
		input: {
			allowedPolicies,
			disallowedPolicies,
			orphan: form.orphan,
			renewable: form.renewable,
			...(boundCidrs.length ? { boundCidrs } : {}),
			...(numUses === undefined ? {} : { numUses }),
			...Object.fromEntries(
				Object.entries(ttls).filter(([, secs]) => secs !== undefined)
			),
		},
	};
}
