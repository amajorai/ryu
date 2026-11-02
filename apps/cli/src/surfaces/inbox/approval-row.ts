// One pending approval row in the CLI's locale.
//
// Core stores an approval's `title`, `question` and `summary` in English and
// carries the Core messages behind them in `i18n`
// (apps/core/src/approvals/text.rs). `localizeApproval` from
// @ryuhq/core-client renders those through the CLI catalog, keeping the stored
// English for a row from an older Core or with a malformed message.

import {
	type ApprovalTranslate,
	localizeApproval,
} from "@ryuhq/core-client/approval-text";
import type { FeatureRecord } from "../../core/featureList.ts";

/** Replace a row's title, question and summary with their localized text. */
export function localizeApprovalRecord(
	record: FeatureRecord,
	translate: ApprovalTranslate
): FeatureRecord {
	const { i18n, question, summary, title } = record;
	if (typeof title !== "string" || i18n === undefined) {
		return record;
	}
	const text = localizeApproval(
		{
			i18n,
			question: typeof question === "string" ? question : null,
			summary: typeof summary === "string" ? summary : "",
			title,
		},
		translate
	);
	return {
		...record,
		question: text.question,
		summary: text.summary,
		title: text.title,
	};
}
