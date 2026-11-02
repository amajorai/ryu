// The toast text for a routing notice (why a preferred plan was skipped for a
// cloud task), in the reader's locale.
//
// Core sends each notice's sentence twice: `message`, the English rendering, and
// `i18n`, the same sentence as a Core message `{ message: <English ICU source>,
// args: { name: value } }` (apps/core/src/server/subscription_cloud/notices.rs).
// The source is a catalog key, so `tl` renders it like any other literal. A
// notice from an older Core, or with a malformed `i18n`, shows its English text.

import type { CloudTaskNotice } from "@/src/lib/api/cloud-task-backends.ts";

/** Render an English ICU source with values in the active locale. */
export type NoticeTranslate = (
	source: string,
	values: Record<string, string | number>
) => string;

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

function argValue(value: unknown): string | number | null {
	if (typeof value === "string") {
		return value;
	}
	if (typeof value === "number" && Number.isFinite(value)) {
		return value;
	}
	if (
		isRecord(value) &&
		typeof value.number === "number" &&
		Number.isFinite(value.number)
	) {
		return value.number;
	}
	return null;
}

export function cloudTaskNoticeText(
	notice: Pick<CloudTaskNotice, "i18n" | "message">,
	tl: NoticeTranslate
): string {
	const phrase = notice.i18n;
	if (
		!isRecord(phrase) ||
		typeof phrase.message !== "string" ||
		phrase.message === ""
	) {
		return notice.message;
	}
	const values: Record<string, string | number> = {};
	const args = phrase.args ?? {};
	if (!isRecord(args)) {
		return notice.message;
	}
	for (const [name, raw] of Object.entries(args)) {
		const value = argValue(raw);
		if (value === null) {
			return notice.message;
		}
		values[name] = value;
	}
	return tl(phrase.message, values);
}
