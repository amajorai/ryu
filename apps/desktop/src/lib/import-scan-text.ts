// Scan titles, details and warnings in the reader's locale.
//
// Core sends each as English text plus the same text as a Core message
// (`title_i18n`, `detail_i18n`, `warning_notices[].i18n`, built from
// apps/core/src/i18n/messages/import.rs). The message source is a catalog key,
// so `tl` renders it like any other literal; an older node's item, or a
// malformed message, shows its English text.

import type { ScanItem, ScanResult } from "@/src/lib/api/import.ts";
import {
	cloudTaskNoticeText,
	type NoticeTranslate,
} from "@/src/lib/cloud-task-notice-text.ts";

/** The item's title in the reader's locale. */
export function scanItemTitle(item: ScanItem, tl: NoticeTranslate): string {
	return cloudTaskNoticeText(
		{ i18n: item.titleI18n ?? null, message: item.title },
		tl
	);
}

/** The item's detail (a path, or sentences about an export project). */
export function scanItemDetail(
	item: ScanItem,
	tl: NoticeTranslate
): string | undefined {
	const sentences = item.detailI18n ?? [];
	if (item.detail === undefined || sentences.length === 0) {
		return item.detail;
	}
	const rendered: string[] = [];
	for (const sentence of sentences) {
		// An English fallback marks a malformed sentence: keep Core's whole text.
		const text = cloudTaskNoticeText({ i18n: sentence, message: "" }, tl);
		if (text === "") {
			return item.detail;
		}
		rendered.push(text);
	}
	return joinSentences(rendered);
}

// Japanese and Chinese sentences end in a full-width stop and run on with no
// space (Core's `sentence_separator`); other scripts take one space.
const FULL_WIDTH_END = /[。！？]$/u;

function joinSentences(sentences: string[]): string {
	let out = "";
	for (const sentence of sentences) {
		if (out !== "" && !FULL_WIDTH_END.test(out)) {
			out += " ";
		}
		out += sentence;
	}
	return out;
}

/** The scan's warnings in the reader's locale, in Core's order. */
export function scanWarnings(
	scan: Pick<ScanResult, "warningNotices" | "warnings">,
	tl: NoticeTranslate
): string[] {
	const notices = scan.warningNotices;
	if (!notices || notices.length !== scan.warnings.length) {
		return scan.warnings;
	}
	return notices.map((notice) => cloudTaskNoticeText(notice, tl));
}
