/**
 * Profile › About you (`user-personalization`) is folded into the system prompt
 * of every owner thread on the node (`user_personalization_block` in Core's
 * sidecar adapters). Saving a change there is a one-time prompt-cache miss for
 * each of those threads, so the editors confirm first. These helpers name the
 * fields whose prompt line would change, using the labels Core writes.
 */

import { promptEditCacheWarning } from "@ryu/blocks/desktop/agent-elements/prompt-cache.ts";
import type { UserPersonalization } from "@/src/lib/api/preferences.ts";

/** UI field labels, in Core's prompt order. */
const PROMPT_FIELDS: ReadonlyArray<{
	key: keyof UserPersonalization;
	label: string;
}> = [
	{ key: "nickname", label: "Nickname" },
	{ key: "occupation", label: "Occupation" },
	{ key: "aboutYou", label: "More about you" },
	{ key: "aboutOrganization", label: "About your organization" },
];

/**
 * Labels of the fields whose prompt line differs. Core trims each value and
 * drops empty ones, so whitespace-only edits change nothing.
 */
export function changedPersonalizationFields(
	before: UserPersonalization,
	after: UserPersonalization
): string[] {
	return PROMPT_FIELDS.filter(
		({ key }) => promptValue(before[key]) !== promptValue(after[key])
	).map(({ label }) => label);
}

/** Core reads only string values (trimmed); anything else is no line. */
function promptValue(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

/**
 * The confirmation shown before saving About you, or null when the save does
 * not change what reaches the prompt.
 */
export function personalizationCacheWarning(
	before: UserPersonalization,
	after: UserPersonalization
): { description: string; title: string } | null {
	return promptEditCacheWarning(
		changedPersonalizationFields(before, after),
		"all-threads"
	);
}
