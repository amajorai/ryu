// Pure view helpers for the Vault page: folder tree, status copy, and form
// conversions. Kept free of React so they are unit-tested directly.

import type {
	VaultCapability,
	VaultExportFormat,
	VaultSecret,
	VaultSecretStatus,
	VaultState,
} from "@/src/lib/api/vault.ts";

export const ROOT_FOLDER = "/";

const SECONDS_PER_DAY = 86_400;
/** Core rejects rotation periods shorter than five minutes. */
export const MIN_ROTATION_SECS = 300;

export const STATUS_COPY = {
	expired: { label: "Expired", variant: "destructive" },
	rotation_due: { label: "Rotation due", variant: "outline" },
	deleted: { label: "Deleted", variant: "secondary" },
} satisfies Record<
	Exclude<VaultSecretStatus, "active">,
	{ label: string; variant: "destructive" | "outline" | "secondary" }
>;

export interface FolderNode {
	depth: number;
	label: string;
	path: string;
}

/** Normalize `a/b/` and `/a//b` to `/a/b`; empty input is the root. */
export function normalizeFolder(path: string): string {
	const segments = path.split("/").filter(Boolean);
	return segments.length ? `/${segments.join("/")}` : ROOT_FOLDER;
}

/**
 * A depth-first, alphabetical folder list including every ancestor, always
 * starting with the root. Depth 0 is the root.
 */
export function buildFolderTree(paths: Iterable<string>): FolderNode[] {
	const all = new Set<string>([ROOT_FOLDER]);
	for (const raw of paths) {
		const segments = normalizeFolder(raw).split("/").filter(Boolean);
		for (let index = 1; index <= segments.length; index += 1) {
			all.add(`/${segments.slice(0, index).join("/")}`);
		}
	}
	const sorted = [...all].sort((left, right) => {
		if (left === ROOT_FOLDER) {
			return -1;
		}
		if (right === ROOT_FOLDER) {
			return 1;
		}
		return left.localeCompare(right);
	});
	return sorted.map((path) => {
		const segments = path.split("/").filter(Boolean);
		return {
			path,
			depth: segments.length,
			label: segments.at(-1) ?? "All folders",
		};
	});
}

/** Whether a value at `path` belongs to `folder` or any of its sub-folders. */
export function inFolder(path: string, folder: string): boolean {
	const value = normalizeFolder(path);
	const parent = normalizeFolder(folder);
	if (parent === ROOT_FOLDER) {
		return true;
	}
	return value === parent || value.startsWith(`${parent}/`);
}

/** `2026-10-05T14:30` for an `<input type="datetime-local">`, in local time. */
export function toDateTimeLocal(iso: string | null): string {
	if (!iso) {
		return "";
	}
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) {
		return "";
	}
	const pad = (value: number) => String(value).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(
		date.getDate()
	)}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** RFC 3339 from a `datetime-local` value, or `null` when empty or invalid. */
export function fromDateTimeLocal(value: string): string | null {
	if (!value.trim()) {
		return null;
	}
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** Comma- or whitespace-separated tags, trimmed and de-duplicated. */
export function parseTags(text: string): string[] {
	const tags: string[] = [];
	for (const tag of text.split(/[\s,]+/)) {
		const trimmed = tag.trim();
		if (trimmed && !tags.includes(trimmed)) {
			tags.push(trimmed);
		}
	}
	return tags;
}

export function rotationDaysText(secs: number | null): string {
	if (!secs) {
		return "";
	}
	const days = secs / SECONDS_PER_DAY;
	return Number.isInteger(days) ? String(days) : days.toFixed(2);
}

/** Seconds from a day count; `null` when empty. Throws on invalid input. */
export function rotationSecsFromDays(text: string): number | null {
	if (!text.trim()) {
		return null;
	}
	const days = Number(text);
	if (!Number.isFinite(days) || days <= 0) {
		throw new Error("Rotation period must be a positive number of days.");
	}
	return Math.max(MIN_ROTATION_SECS, Math.round(days * SECONDS_PER_DAY));
}

/** The change-request subject Core records for this caller. */
export function callerSubject(state: VaultState | undefined): string {
	return state?.caller ? `user:${state.caller.userId}` : "operator";
}

/**
 * Whether the caller holds the baseline vault `admin` grant: the unbound local
 * operator, or a configuration manager on a managed node. Policies may grant
 * more; Core stays the authority and answers 403 otherwise.
 */
export function isVaultAdmin(state: VaultState | undefined): boolean {
	if (!state) {
		return false;
	}
	return state.node.scope === "local" || state.canManageShared;
}

export function secretKey(secret: VaultSecret): string {
	return [
		secret.source ?? "local",
		secret.scope,
		secret.scopeId,
		secret.environment,
		secret.path,
		secret.binding?.id ?? "",
		secret.name,
	].join(":");
}

const EXPORT_EXTENSIONS = {
	dotenv: "env",
	json: "json",
	yaml: "yaml",
	shell: "sh",
	"k8s-secret": "yaml",
} satisfies Record<VaultExportFormat, string>;

export function exportFileName(
	format: VaultExportFormat,
	environment: string
): string {
	return `vault-${environment}.${EXPORT_EXTENSIONS[format]}`;
}

/** Guess the import format from a file name or its content. */
export function guessImportFormat(
	fileName: string,
	content: string
): "dotenv" | "json" {
	if (fileName.toLowerCase().endsWith(".json")) {
		return "json";
	}
	return content.trimStart().startsWith("{") ? "json" : "dotenv";
}

const SHARED_MANAGER_CAPABILITIES: VaultCapability[] = [
	"list",
	"use",
	"read",
	"write",
	"delete",
	"approve",
];

/**
 * A control-plane row that carries no capabilities falls back to the
 * configuration-manager baseline, so a manager can still act on it. The
 * control plane still enforces its own RBAC on every call.
 */
export function withSharedFallback(
	secret: VaultSecret,
	canManageShared: boolean
): VaultSecret {
	if (
		secret.source !== "control-plane" ||
		secret.capabilities.length > 0 ||
		!canManageShared
	) {
		return secret;
	}
	return { ...secret, capabilities: SHARED_MANAGER_CAPABILITIES };
}
