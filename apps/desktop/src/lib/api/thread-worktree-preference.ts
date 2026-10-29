import type { ApiTarget } from "./client.ts";
import { getPreference, setPreference } from "./preferences.ts";

export const THREAD_WORKTREE_ISOLATION_DEFAULT_PREF_KEY =
	"threads-worktree-isolate-by-default";

/** Missing or unrecognized preference values keep the fresh-node default: off. */
export function parseThreadWorktreeIsolationDefault(
	value: string | null
): boolean {
	return value?.trim().toLowerCase() === "true";
}

export async function getThreadWorktreeIsolationDefault(
	target: ApiTarget
): Promise<boolean> {
	return parseThreadWorktreeIsolationDefault(
		await getPreference(target, THREAD_WORKTREE_ISOLATION_DEFAULT_PREF_KEY)
	);
}

export function setThreadWorktreeIsolationDefault(
	target: ApiTarget,
	enabled: boolean
): Promise<boolean> {
	return setPreference(
		target,
		THREAD_WORKTREE_ISOLATION_DEFAULT_PREF_KEY,
		String(enabled)
	);
}
