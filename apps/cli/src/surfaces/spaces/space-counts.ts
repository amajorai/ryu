// Counts in the Spaces panes, as whole ICU plurals so each locale picks its
// own form ("1 doc" / "2 docs") instead of a fixed English suffix.

import { tf } from "../../i18n/translate.ts";

/** "12 docs" beside a space's name. */
export function documentCountLabel(count: number): string {
	return tf("{count, plural, one {# doc} other {# docs}}", { count });
}

/** "3 messages" in a history row's meta. */
export function messageCountLabel(count: number): string {
	return tf("{count, plural, one {# message} other {# messages}}", { count });
}
