"use client";

// Shared comment-thread helpers: the comment shape, the discussion save path,
// the per-comment Plate editor and the locale-aware short comment timestamp.

import { BasicMarksKit } from "@ryu/ui/components/editor/plugins/basic-marks-kit.tsx";
import {
	discussionPlugin,
	type TDiscussion,
} from "@ryu/ui/components/editor/plugins/discussion-kit.tsx";
import {
	differenceInDays,
	differenceInHours,
	differenceInMinutes,
} from "date-fns";
import type { Value } from "platejs";
import {
	type CreatePlateEditorOptions,
	type PlateEditor,
	usePlateEditor,
} from "platejs/react";

export interface TComment {
	contentRich: Value;
	createdAt: Date;
	discussionId: string;
	id: string;
	isEdited: boolean;
	userId: string;
}

export function saveDiscussions(
	editor: PlateEditor,
	discussions: TDiscussion[]
): void {
	editor.setOption(discussionPlugin, "discussions", discussions);
	editor.getOption(discussionPlugin, "onDiscussionsChange")?.(discussions);
}

export const useCommentEditor = (
	options: Omit<CreatePlateEditorOptions, "plugins"> = {},
	deps: unknown[] = []
) =>
	usePlateEditor(
		{
			id: "comment",
			plugins: BasicMarksKit,
			value: [],
			...options,
		},
		deps
	);

function shortUnit(
	value: number,
	unit: "minute" | "hour" | "day",
	locale: string
): string {
	return new Intl.NumberFormat(locale, {
		style: "unit",
		unit,
		unitDisplay: "narrow",
	}).format(value);
}

/**
 * A compact comment timestamp in the reader's locale: a narrow relative unit
 * for the last two days ("5m", "3h", "1d" in English), then a short date.
 */
export const formatCommentDate = (date: Date, locale = "en"): string => {
	const now = new Date();
	const diffMinutes = differenceInMinutes(now, date);
	const diffHours = differenceInHours(now, date);
	const diffDays = differenceInDays(now, date);

	if (diffMinutes < 60) {
		return shortUnit(diffMinutes, "minute", locale);
	}
	if (diffHours < 24) {
		return shortUnit(diffHours, "hour", locale);
	}
	if (diffDays < 2) {
		return shortUnit(diffDays, "day", locale);
	}

	return new Intl.DateTimeFormat(locale, { dateStyle: "short" }).format(date);
};
