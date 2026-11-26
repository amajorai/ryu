import type { ApiTarget } from "./client.ts";
import { getPreference, setPreference } from "./preferences.ts";

/** Core preference key for "Credit Ryu in git commits". */
export const GIT_CREDIT_RYU_PREF_KEY = "git-credit-ryu";

/**
 * The trailer Core adds, shown as a preview under the switch. Core owns the
 * value (`RYU_COAUTHOR_TRAILER` in `crates/core/workspace/src/git/credit.rs`);
 * the test beside this file fails when the two drift apart.
 */
export const RYU_COAUTHOR_TRAILER = "Co-authored-by: Ryu <amajorhq@gmail.com>";

/**
 * Credit is on unless the node saved an explicit "false": a missing or
 * unrecognized value keeps the default, the same rule Core applies.
 */
export function parseGitCreditRyu(value: string | null): boolean {
	return value?.trim().toLowerCase() !== "false";
}

export async function getGitCreditRyu(target: ApiTarget): Promise<boolean> {
	return parseGitCreditRyu(
		await getPreference(target, GIT_CREDIT_RYU_PREF_KEY)
	);
}

export function setGitCreditRyu(
	target: ApiTarget,
	enabled: boolean
): Promise<boolean> {
	return setPreference(target, GIT_CREDIT_RYU_PREF_KEY, String(enabled));
}
