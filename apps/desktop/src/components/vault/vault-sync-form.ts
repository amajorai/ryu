// Form model for secret-sync targets (GitHub Actions, Vercel, AWS Secrets
// Manager, Google Cloud Secret Manager) and the status line of a sync. The
// form holds credentials only until it is submitted; Core never returns them.

import type { LiteralMessage } from "@ryu/i18n/react";
import type {
	VaultExternalDestination,
	VaultExternalStore,
	VaultExternalStoreInput,
} from "@/src/lib/api/vault-external.ts";

export type SyncTargetKind =
	| "github-actions"
	| "vercel"
	| "aws-secrets-manager"
	| "gcp-secret-manager";

export const SYNC_TARGETS = [
	{ kind: "github-actions", label: "GitHub Actions" },
	{ kind: "vercel", label: "Vercel" },
	{ kind: "aws-secrets-manager", label: "AWS Secrets Manager" },
	{ kind: "gcp-secret-manager", label: "Google Cloud Secret Manager" },
] as const satisfies readonly { kind: SyncTargetKind; label: string }[];

export const VERCEL_TARGETS = ["production", "preview", "development"] as const;

export interface SyncTargetForm {
	accessKeyId: string;
	address: string;
	gcpAuth: "service-account" | "token";
	githubEnvironment: string;
	kind: SyncTargetKind;
	name: string;
	pathPrefix: string;
	projectId: string;
	region: string;
	repository: string;
	secretAccessKey: string;
	serviceAccountKey: string;
	sessionToken: string;
	teamId: string;
	token: string;
	vercelTargets: string[];
}

export function emptySyncTargetForm(
	kind: SyncTargetKind = "github-actions"
): SyncTargetForm {
	return {
		accessKeyId: "",
		address: "",
		gcpAuth: "service-account",
		githubEnvironment: "",
		kind,
		name: "",
		pathPrefix: "",
		projectId: "",
		region: "",
		repository: "",
		secretAccessKey: "",
		serviceAccountKey: "",
		sessionToken: "",
		teamId: "",
		token: "",
		vercelTargets: [...VERCEL_TARGETS],
	};
}

const STORE_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function syncTargetLabel(kind: string): string {
	return SYNC_TARGETS.find((target) => target.kind === kind)?.label ?? kind;
}

function optional(value: string): string | undefined {
	const trimmed = value.trim();
	return trimmed === "" ? undefined : trimmed;
}

/** The request body for a form, or the first problem with it. */
export function syncTargetInput(
	form: SyncTargetForm
): { input: VaultExternalStoreInput } | { problem: string } {
	const name = form.name.trim();
	if (!STORE_NAME.test(name)) {
		return {
			problem:
				"Name: lowercase letters, digits, - and _, starting with a letter or digit.",
		};
	}
	const base = { name, address: optional(form.address) };
	switch (form.kind) {
		case "github-actions":
			if (!REPOSITORY.test(form.repository.trim())) {
				return { problem: "Repository must be owner/repo." };
			}
			if (!form.token.trim()) {
				return { problem: "Enter a GitHub token." };
			}
			return {
				input: {
					...base,
					kind: "github-actions",
					authMethod: "token",
					repository: form.repository.trim(),
					githubEnvironment: optional(form.githubEnvironment),
					credentials: { token: form.token.trim() },
				},
			};
		case "vercel":
			if (!(form.projectId.trim() && form.token.trim())) {
				return { problem: "Enter the Vercel project and a token." };
			}
			if (form.vercelTargets.length === 0) {
				return { problem: "Choose at least one Vercel environment." };
			}
			return {
				input: {
					...base,
					kind: "vercel",
					authMethod: "token",
					projectId: form.projectId.trim(),
					teamId: optional(form.teamId),
					vercelTargets: form.vercelTargets,
					credentials: { token: form.token.trim() },
				},
			};
		case "aws-secrets-manager":
			if (!form.region.trim()) {
				return { problem: "Enter the AWS region." };
			}
			if (!(form.accessKeyId.trim() && form.secretAccessKey.trim())) {
				return { problem: "Enter the access key id and secret access key." };
			}
			return {
				input: {
					...base,
					kind: "aws-secrets-manager",
					authMethod: "access-key",
					region: form.region.trim(),
					pathPrefix: optional(form.pathPrefix),
					credentials: {
						accessKeyId: form.accessKeyId.trim(),
						secretAccessKey: form.secretAccessKey.trim(),
						sessionToken: optional(form.sessionToken),
					},
				},
			};
		default: {
			if (!form.projectId.trim()) {
				return { problem: "Enter the Google Cloud project id." };
			}
			const credential =
				form.gcpAuth === "token" ? form.token : form.serviceAccountKey;
			if (!credential.trim()) {
				return {
					problem:
						form.gcpAuth === "token"
							? "Enter an access token."
							: "Paste the service-account key file.",
				};
			}
			return {
				input: {
					...base,
					kind: "gcp-secret-manager",
					authMethod: form.gcpAuth,
					projectId: form.projectId.trim(),
					credentials:
						form.gcpAuth === "token"
							? { token: credential.trim() }
							: { serviceAccountKey: credential.trim() },
				},
			};
		}
	}
}

/** Where a store writes, in one line. */
export function storeSummary(store: VaultExternalStore): string {
	switch (store.kind) {
		case "github-actions":
			return [store.repository, store.githubEnvironment]
				.filter(Boolean)
				.join(" · ");
		case "vercel":
			return [store.projectId, store.vercelTargets?.join(", ")]
				.filter(Boolean)
				.join(" · ");
		case "aws-secrets-manager":
			return [store.region, store.pathPrefix].filter(Boolean).join(" · ");
		case "gcp-secret-manager":
			return store.projectId;
		default:
			return store.address;
	}
}

/** What `remotePath` means for a store: a name prefix or a secret path. */
export function remotePathHint(kind: string): {
	label: string;
	placeholder: string;
} {
	if (kind === "aws-secrets-manager") {
		return { label: "Secret name", placeholder: "prod/web" };
	}
	if (SYNC_TARGETS.some((target) => target.kind === kind)) {
		return { label: "Name prefix (optional)", placeholder: "WEB_" };
	}
	return { label: "Remote path", placeholder: "apps/web" };
}

export function syncStatus(
	destination: VaultExternalDestination,
	tl: LiteralMessage
): {
	label: string;
	tone: "error" | "ok" | "pending";
} {
	if (destination.lastPushAt === null) {
		return { label: "Waiting for the first push", tone: "pending" };
	}
	if (destination.lastStatus === "error") {
		return {
			label: destination.lastError ?? "The last push failed",
			tone: "error",
		};
	}
	return {
		label: tl("{count, plural, one {# key pushed} other {# keys pushed}}", {
			count: destination.lastCount,
		}),
		tone: "ok",
	};
}
