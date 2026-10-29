import type { ApiTarget } from "./client.ts";
import { getPreference, setPreference } from "./preferences.ts";

/** Core preference that lets a restarted node resume threads it was running. */
export const AUTO_RESUME_INTERRUPTED_THREADS_PREF_KEY =
	"auto-resume-interrupted-threads";

/** Mirrors Core: unset or unrecognized values keep auto-resume on. */
export function parseAutoResumeInterruptedThreads(
	value: string | null
): boolean {
	const normalized = value?.trim().toLowerCase();
	return !(
		normalized === "false" ||
		normalized === "0" ||
		normalized === "off" ||
		normalized === "no"
	);
}

export async function getAutoResumeInterruptedThreads(
	target: ApiTarget
): Promise<boolean> {
	return parseAutoResumeInterruptedThreads(
		await getPreference(target, AUTO_RESUME_INTERRUPTED_THREADS_PREF_KEY)
	);
}

export function setAutoResumeInterruptedThreads(
	target: ApiTarget,
	enabled: boolean
): Promise<boolean> {
	return setPreference(
		target,
		AUTO_RESUME_INTERRUPTED_THREADS_PREF_KEY,
		String(enabled)
	);
}
