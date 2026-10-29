import type { CloudChatRequestFields } from "@ryuhq/core-client/chat.ts";
import { create } from "zustand";
import type { ApiTarget } from "./api/client.ts";

export type CloudTaskExecutor =
	| "ryu"
	| "claude-code"
	| "codex"
	| "opencode"
	| "cursor";
export interface CloudTaskRuntime {
	backend: "auto" | "box";
	executor: CloudTaskExecutor;
}
export type CloudTaskSelection =
	| { mode: "local"; locked: boolean }
	| {
			mode: "cloud";
			environmentId: string | null;
			runtime: CloudTaskRuntime | null;
			locked: boolean;
	  }
	| { mode: "loading" }
	| { mode: "error"; message: string };

export const CLOUD_EXECUTOR_LABELS: Record<CloudTaskExecutor, string> = {
	ryu: "Ryu",
	"claude-code": "Claude Code",
	codex: "Codex",
	opencode: "OpenCode",
	cursor: "Cursor",
};

const isCloudTaskExecutor = (value: unknown): value is CloudTaskExecutor =>
	typeof value === "string" && Object.hasOwn(CLOUD_EXECUTOR_LABELS, value);

/**
 * Rollout gate for the Fresh cloud box backend (`cloud_tasks.box_backend`).
 * Omitted means closed: the flag is default off with failMode closed.
 */
export interface CloudTaskGateOptions {
	boxBackendEnabled?: boolean;
}

export const BOX_BACKEND_DISABLED_REASON =
	"Fresh cloud box is a preview that is not enabled for this account.";

/**
 * Non-null when the selection is a cloud environment whose agent is a managed CLI (not Ryu).
 * Managed executors only run on the Fresh cloud box, so this is null while that preview is off.
 */
export function managedCloudExecutor(
	selection: CloudTaskSelection,
	options: CloudTaskGateOptions = {}
): Exclude<CloudTaskExecutor, "ryu"> | null {
	if (
		selection.mode !== "cloud" ||
		!selection.runtime ||
		options.boxBackendEnabled !== true
	) {
		return null;
	}
	const { executor } = selection.runtime;
	return executor === "ryu" ? null : executor;
}

/** Decodes the optional binding runtime fields; older Core omits them (null). */
export function runtimeFromBinding(
	backend: unknown,
	executor: unknown
): CloudTaskRuntime | null {
	if (!isCloudTaskExecutor(executor)) {
		return null;
	}
	return { backend: backend === "box" ? "box" : "auto", executor };
}

export const LOCAL_CLOUD_SELECTION: CloudTaskSelection = {
	mode: "local",
	locked: false,
};
export const LOADING_CLOUD_SELECTION: CloudTaskSelection = { mode: "loading" };

export async function cloudTaskScope(
	target: ApiTarget,
	conversationId: string
): Promise<string> {
	const bytes = new TextEncoder().encode(
		JSON.stringify([
			target.url,
			target.token ?? "",
			target.userJwt ?? "",
			conversationId,
		])
	);
	const hash = await crypto.subtle.digest("SHA-256", bytes);
	return Array.from(new Uint8Array(hash), (byte) =>
		byte.toString(16).padStart(2, "0")
	).join("");
}

interface CloudSelectionState {
	selections: Record<string, CloudTaskSelection>;
	setSelection: (scope: string, selection: CloudTaskSelection) => void;
}

// Ephemeral per-chat IDs only. Vault credentials and setup content never enter this store.
export const useCloudTaskSelections = create<CloudSelectionState>((set) => ({
	selections: {},
	setSelection: (scope, selection) =>
		set((state) => {
			const previous = state.selections[scope];
			if (previous && "locked" in previous && previous.locked) {
				return state;
			}
			return { selections: { ...state.selections, [scope]: selection } };
		}),
}));

export function cloudTaskBlockReason(
	selection: CloudTaskSelection,
	agentId?: string | null,
	options: CloudTaskGateOptions = {}
): string | null {
	if (selection.mode === "loading") {
		return "Loading this chat's cloud environment binding.";
	}
	if (selection.mode === "error") {
		return selection.message;
	}
	if (selection.mode === "local") {
		return null;
	}
	if (!selection.environmentId) {
		return "Choose a published cloud environment before sending.";
	}
	if (
		selection.runtime?.backend === "box" &&
		options.boxBackendEnabled !== true
	) {
		return BOX_BACKEND_DISABLED_REASON;
	}
	if (
		agentId &&
		agentId !== "ryu" &&
		!managedCloudExecutor(selection, options)
	) {
		return "Cloud tasks currently support the Ryu native agent. Select Ryu to continue.";
	}
	return null;
}

export function cloudTaskRequestFields(
	selection: CloudTaskSelection,
	agentId?: string | null,
	options: CloudTaskGateOptions = {}
): CloudChatRequestFields {
	const reason = cloudTaskBlockReason(selection, agentId, options);
	if (reason) {
		throw new Error(reason);
	}
	return selection.mode === "cloud" && selection.environmentId
		? { cloudEnvironmentId: selection.environmentId }
		: {};
}
