// Form model for dynamic-secret roles. The form holds provider credentials
// only until it is submitted; Core seals them and lists a redacted summary,
// so replacing a role means entering its credentials again.

import { translate } from "@ryu/i18n/core";
import type { VaultDynamicProvider } from "@/src/lib/api/vault-dynamic.ts";
import { parseTtl } from "./vault-ttl.ts";

export type DynamicProviderKind = "postgres" | "aws-sts" | "webhook" | "random";

export const DYNAMIC_PROVIDERS = [
	{ kind: "postgres", label: "PostgreSQL" },
	{ kind: "aws-sts", label: "AWS STS" },
	{ kind: "webhook", label: "Webhook" },
	{ kind: "random", label: "Random value" },
] as const satisfies readonly { kind: DynamicProviderKind; label: string }[];

export const RANDOM_CHARSETS = [
	"alphanumeric",
	"hex",
	"base64url",
	"symbols",
] as const;

export interface DynamicRoleForm {
	accessKeyId: string;
	charset: (typeof RANDOM_CHARSETS)[number];
	connectionUrl: string;
	creationStatements: string;
	defaultTtl: string;
	endpoint: string;
	field: string;
	kind: DynamicProviderKind;
	length: string;
	maxTtl: string;
	name: string;
	region: string;
	revocationStatements: string;
	roleArn: string;
	secretAccessKey: string;
	sessionPolicy: string;
	signingSecret: string;
	url: string;
	usernamePrefix: string;
}

export function emptyDynamicRoleForm(
	kind: DynamicProviderKind = "postgres"
): DynamicRoleForm {
	return {
		accessKeyId: "",
		charset: "alphanumeric",
		connectionUrl: "",
		creationStatements: "",
		defaultTtl: "1h",
		endpoint: "",
		field: "",
		kind,
		length: "32",
		maxTtl: "24h",
		name: "",
		region: "",
		revocationStatements: "",
		roleArn: "",
		secretAccessKey: "",
		sessionPolicy: "",
		signingSecret: "",
		url: "",
		usernamePrefix: "",
	};
}

/** Role names share Core's transit key grammar. */
export const DYNAMIC_ROLE_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function dynamicProviderLabel(kind: string): string {
	return DYNAMIC_PROVIDERS.find((item) => item.kind === kind)?.label ?? kind;
}

function optional(value: string): string | undefined {
	const trimmed = value.trim();
	return trimmed === "" ? undefined : trimmed;
}

/** One SQL statement per non-blank line. */
export function statementLines(text: string): string[] {
	return text
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);
}

function provider(
	form: DynamicRoleForm
): { provider: VaultDynamicProvider } | { problem: string } {
	switch (form.kind) {
		case "postgres": {
			const creationStatements = statementLines(form.creationStatements);
			if (!(form.connectionUrl.trim() && creationStatements.length)) {
				return {
					problem: translate(
						"Enter the connection URL and at least one creation statement."
					),
				};
			}
			const revocationStatements = statementLines(form.revocationStatements);
			return {
				provider: {
					kind: "postgres",
					connectionUrl: form.connectionUrl.trim(),
					creationStatements,
					...(revocationStatements.length ? { revocationStatements } : {}),
					usernamePrefix: optional(form.usernamePrefix),
				},
			};
		}
		case "aws-sts":
			if (
				!(
					form.region.trim() &&
					form.roleArn.trim() &&
					form.accessKeyId.trim() &&
					form.secretAccessKey.trim()
				)
			) {
				return {
					problem: translate(
						"Enter the region, role ARN, access key id and secret access key."
					),
				};
			}
			return {
				provider: {
					kind: "aws-sts",
					region: form.region.trim(),
					roleArn: form.roleArn.trim(),
					accessKeyId: form.accessKeyId.trim(),
					secretAccessKey: form.secretAccessKey.trim(),
					endpoint: optional(form.endpoint),
					sessionPolicy: optional(form.sessionPolicy),
				},
			};
		case "webhook":
			if (!form.url.trim()) {
				return { problem: translate("Enter the webhook URL.") };
			}
			if (form.signingSecret.trim().length < 16) {
				return {
					problem: translate(
						"The signing secret needs at least 16 characters."
					),
				};
			}
			return {
				provider: {
					kind: "webhook",
					url: form.url.trim(),
					signingSecret: form.signingSecret.trim(),
				},
			};
		default: {
			const length = Number(form.length.trim());
			if (!Number.isInteger(length) || length < 1) {
				return { problem: translate("Length must be a whole number.") };
			}
			return {
				provider: {
					kind: "random",
					length,
					charset: form.charset,
					field: optional(form.field),
				},
			};
		}
	}
}

export interface DynamicRoleSubmission {
	input: {
		defaultTtlSecs?: number;
		maxTtlSecs?: number;
		provider: VaultDynamicProvider;
	};
	name: string;
}

/** The role name and request body for a form, or the first problem with it. */
export function dynamicRoleInput(
	form: DynamicRoleForm
): DynamicRoleSubmission | { problem: string } {
	const name = form.name.trim();
	if (!DYNAMIC_ROLE_NAME.test(name)) {
		return {
			problem: translate(
				"Name: lowercase letters, digits, - and _, starting with a letter or digit."
			),
		};
	}
	const defaultTtlSecs = parseTtl(form.defaultTtl);
	const maxTtlSecs = parseTtl(form.maxTtl);
	if (defaultTtlSecs === null || maxTtlSecs === null) {
		return {
			problem: translate("Durations look like 90s, 15m, 1h or 7d."),
		};
	}
	if (
		defaultTtlSecs !== undefined &&
		maxTtlSecs !== undefined &&
		defaultTtlSecs > maxTtlSecs
	) {
		return {
			problem: translate("The default TTL cannot exceed the maximum TTL."),
		};
	}
	const built = provider(form);
	if ("problem" in built) {
		return built;
	}
	return {
		name,
		input: { defaultTtlSecs, maxTtlSecs, provider: built.provider },
	};
}
