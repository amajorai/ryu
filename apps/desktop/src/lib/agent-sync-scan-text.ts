// Agent Sync scan titles and warnings in the reader's locale.
//
// Agent Sync's scan (`POST /api/agent-sync/scan`, apps/core/src/server/agent_sync.rs)
// forwards each setup item whole, so the item still carries Core's `title_i18n`
// message; the scan codec keeps it as an undeclared field. Its warnings are
// English sentences only. A warning with no values (such as the Cursor history
// notice, IMPORT_AGENT_SYNC_CURSOR_HISTORY_WARNING_MESSAGE in
// apps/core/src/i18n/messages/import.rs) is its own catalog key, so it is looked
// up as-is; one with values stays English. When a node sends
// `warningNotices` (the import scan's localized warnings), those win.

import type { AgentSyncScanItem } from "@/src/lib/api/agent-sync.ts";
import {
	cloudTaskNoticeText,
	type NoticeTranslate,
} from "@/src/lib/cloud-task-notice-text.ts";

/** Agent Sync's Cursor notice; Core sends exactly this sentence. */
export const CURSOR_HISTORY_NOTICE =
	"Cursor native conversation history is not a documented import format; use the portable bundle.";

// ICU syntax a filled-in English sentence can carry (`'name'`, `{`, `#`), so it
// is not a catalog key.
const ICU_SYNTAX = /[{}'#<]/u;

function undeclaredField(value: object, name: string): unknown {
	return (value as Record<string, unknown>)[name];
}

/** The setup item's title in the reader's locale. */
export function agentSyncItemTitle(
	item: AgentSyncScanItem,
	tl: NoticeTranslate
): string {
	return cloudTaskNoticeText(
		{ i18n: undeclaredField(item, "title_i18n") ?? null, message: item.title },
		tl
	);
}

function plainWarning(warning: string, tl: NoticeTranslate): string {
	if (warning === CURSOR_HISTORY_NOTICE) {
		return tl(
			"Cursor native conversation history is not a documented import format; use the portable bundle.",
			{}
		);
	}
	return ICU_SYNTAX.test(warning) ? warning : tl(warning, {});
}

/** The scan's warnings in the reader's locale, in Core's order. */
export function agentSyncWarnings(
	scan: { warnings: string[] },
	tl: NoticeTranslate
): string[] {
	const notices = undeclaredField(scan, "warningNotices");
	const localized =
		Array.isArray(notices) && notices.length === scan.warnings.length;
	return scan.warnings.map((warning, index) => {
		const notice: unknown = localized ? notices[index] : null;
		if (typeof notice === "object" && notice !== null) {
			const i18n = undeclaredField(notice, "i18n");
			if (i18n !== undefined && i18n !== null) {
				return cloudTaskNoticeText({ i18n, message: warning }, tl);
			}
		}
		return plainWarning(warning, tl);
	});
}
