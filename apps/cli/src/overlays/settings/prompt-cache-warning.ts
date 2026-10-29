/**
 * The confirmation shown before saving a setting that Core folds into the
 * system prompt. Providers cache the prompt as one prefix, so a changed value
 * is a guaranteed cache miss on each affected thread's next turn.
 *
 * The CLI does not depend on `@ryu/blocks`, so this mirrors the copy of
 * `promptEditCacheWarning` in
 * `packages/blocks/src/desktop/agent-elements/prompt-cache.ts` for the one
 * reach the CLI writes today. `prompt-cache-warning.test.ts` pins both to the
 * same wording.
 */

export const PROMPT_CACHE_CONFIRM_TITLE =
	"Apply now? This resets the prompt cache";

/** Profile › About you reaches every owner thread's system prompt. */
export function aboutYouCacheWarning(): {
	description: string;
	title: string;
} {
	return {
		title: PROMPT_CACHE_CONFIRM_TITLE,
		description:
			"About you is part of the system prompt for every thread on this node. Each thread's next message re-sends its whole conversation at the full input price, once; replies after that are cached again. Switching models costs the same.",
	};
}
