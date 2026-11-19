// The policy editor's form: a name and a JSON document of the policy's
// `description` and `rules`. Parsing only checks the shape; Core validates
// every rule (paths, capabilities, templates, constraints) when it saves.

import type {
	VaultPolicyDocument,
	VaultPolicyInput,
} from "@/src/lib/api/vault-policies.ts";

export const POLICY_NAME = /^[a-z0-9_-]{1,64}$/;

export const NEW_POLICY_DOCUMENT = {
	description: "",
	rules: [{ path: "dev/**", capabilities: ["list", "read"] }],
};

/** The editable JSON text for a policy (or a starter for a new one). */
export function policyDocumentText(policy: VaultPolicyDocument | null): string {
	const document = policy
		? { description: policy.description, rules: policy.rules }
		: NEW_POLICY_DOCUMENT;
	return `${JSON.stringify(document, null, 2)}\n`;
}

/** Rule fields Core reads (`PolicyRule`, with its input aliases). Core
 *  ignores any other key, so a misspelled constraint would be dropped
 *  silently; the editor refuses it instead. */
export const RULE_FIELDS = new Set([
	"path",
	"capabilities",
	"deny",
	"allowedParameters",
	"deniedParameters",
	"requiredParameters",
	"controlGroup",
	"valueRules",
	"minWrappingTtlSecs",
	"maxWrappingTtlSecs",
	"minWrappingTtl",
	"min_wrapping_ttl",
	"maxWrappingTtl",
	"max_wrapping_ttl",
]);

/** A form problem, as an English message the dialog translates. */
export type PolicyFormProblem =
	| { kind: "name" }
	| { kind: "exists" }
	| { kind: "json"; detail: string }
	| { kind: "shape" }
	| { kind: "description" }
	| { kind: "key"; key: string }
	| { kind: "field"; field: string };

export function parsePolicyForm(
	name: string,
	text: string,
	/** Names already in use, for a new policy (saving would replace one). */
	taken: readonly string[] = []
):
	| { ok: true; name: string; input: VaultPolicyInput }
	| { ok: false; problem: PolicyFormProblem } {
	const trimmed = name.trim();
	if (!POLICY_NAME.test(trimmed)) {
		return { ok: false, problem: { kind: "name" } };
	}
	if (taken.includes(trimmed)) {
		return { ok: false, problem: { kind: "exists" } };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		return {
			ok: false,
			problem: {
				kind: "json",
				detail: error instanceof Error ? error.message : String(error),
			},
		};
	}
	if (
		!parsed ||
		typeof parsed !== "object" ||
		Array.isArray(parsed) ||
		!Array.isArray((parsed as { rules?: unknown }).rules) ||
		(parsed as { rules: unknown[] }).rules.length === 0 ||
		(parsed as { rules: unknown[] }).rules.some(
			(rule) => !rule || typeof rule !== "object" || Array.isArray(rule)
		)
	) {
		return { ok: false, problem: { kind: "shape" } };
	}
	const document = parsed as {
		description?: unknown;
		rules: Record<string, unknown>[];
	};
	const extra = Object.keys(document).find(
		(key) => key !== "description" && key !== "rules"
	);
	if (extra !== undefined) {
		return { ok: false, problem: { kind: "key", key: extra } };
	}
	if (
		document.description !== undefined &&
		typeof document.description !== "string"
	) {
		return { ok: false, problem: { kind: "description" } };
	}
	const unknown = document.rules
		.flatMap((rule) => Object.keys(rule))
		.find((field) => !RULE_FIELDS.has(field));
	if (unknown !== undefined) {
		return { ok: false, problem: { kind: "field", field: unknown } };
	}
	return {
		ok: true,
		name: trimmed,
		input: {
			description:
				typeof document.description === "string" ? document.description : "",
			rules: document.rules,
		},
	};
}

/** The subjects a policy is bound to now (an expired binding grants nothing). */
export function boundSubjects(
	policy: string,
	bindings: { expiresAt?: unknown; policy: string; subject: string }[],
	now: number = Date.now()
): string[] {
	const live = (expiresAt: unknown) => {
		if (expiresAt === undefined || expiresAt === null) {
			return true;
		}
		const at =
			typeof expiresAt === "number" ? expiresAt : Date.parse(String(expiresAt));
		return Number.isNaN(at) || at > now;
	};
	return bindings
		.filter((binding) => binding.policy === policy && live(binding.expiresAt))
		.map((binding) => binding.subject)
		.sort();
}
