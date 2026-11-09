// apps/desktop/src/components/inbox/InboxCenter-hidden-label.ts
//
// The tray footer that counts rows past the preview. Whole ICU plurals, so
// Arabic and other locales choose their own form for 1, 2, 3–10 and 11+.

import type { LiteralMessage } from "@ryu/i18n/react";

/** "N more…" under the tray preview: in the full inbox, or in announcements. */
export function inboxHiddenLabel(
	hidden: number,
	showInbox: boolean,
	tl: LiteralMessage
): string {
	return showInbox
		? tl(
				"{hidden, plural, one {# more in the full inbox} other {# more in the full inbox}}",
				{ hidden }
			)
		: tl(
				"{hidden, plural, one {# more in announcements} other {# more in announcements}}",
				{ hidden }
			);
}
