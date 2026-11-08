// A failed import item's line ("<title>: <reason>") in the reader's locale.
//
// Core sends each outcome's title and reason as English text plus, when it
// built them from a template, the same text as Core messages (`title_i18n`,
// `detail_i18n`, from apps/core/src/i18n/messages/import_outcomes.rs). They
// render through the same helpers as the scan rows; a relayed error, a path
// title or an older node's outcome shows Core's English text.

import type { ImportOutcome, ScanItem } from "@/src/lib/api/import.ts";
import type { NoticeTranslate } from "@/src/lib/cloud-task-notice-text.ts";
import { scanItemDetail, scanItemTitle } from "@/src/lib/import-scan-text.ts";

/** The outcome's title and reason, joined in the reader's locale. */
export function importOutcomeLine(
	outcome: ImportOutcome,
	tl: NoticeTranslate
): string {
	const item: ScanItem = {
		alreadyExists: outcome.alreadyExists,
		detail: outcome.detail,
		detailI18n: outcome.detailI18n,
		id: outcome.id,
		kind: outcome.kind,
		title: outcome.title,
		titleI18n: outcome.titleI18n,
	};
	return tl("{title}: {detail}", {
		detail: scanItemDetail(item, tl) ?? "",
		title: scanItemTitle(item, tl),
	});
}
