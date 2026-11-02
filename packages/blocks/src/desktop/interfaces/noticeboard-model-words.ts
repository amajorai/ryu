import { translate as tr } from "@ryu/i18n/lite";
import {
	type InterfaceSnapshot,
	threadStatus,
} from "@ryuhq/protocol/interfaces";
import { relativeAge, threadStatusLabel } from "./interface-renderer.ts";
import type { NoticeboardNote } from "./noticeboard-model.ts";

/** Who a note is from, in words. */
export function noteByline(note: NoticeboardNote): string {
	const [lead, ...rest] = note.agents;
	if (!lead) {
		return tr("No agent");
	}
	if (rest.length === 0) {
		return lead.name;
	}
	return `${lead.name} +${rest.length}`;
}

/** "5m ago", "now", or empty for an unreadable time, in the UI locale. */
export function spokenAge(iso: string, now: number = Date.now()): string {
	return relativeAge(iso, now);
}

/** The note's accessible name: what it is, where it stands, who, and when. */
export function noteAccessibleName(
	note: NoticeboardNote,
	now: number = Date.now()
): string {
	const parts = [
		note.thread.title || tr("Untitled conversation"),
		threadStatusLabel(note.status),
	];
	const names = note.agents.map((agent) => agent.name);
	parts.push(names.length > 0 ? names.join(", ") : tr("No agent"));
	const age = spokenAge(note.thread.updatedAt, now);
	if (age) {
		parts.push(tr("updated {age}", { age }));
	}
	if (note.thread.pinned) {
		parts.push(tr("Pinned"));
	}
	return parts.join(". ");
}

export interface NoticeboardSummary {
	attention: number;
	total: number;
	working: number;
	yourTurn: number;
}

export function noticeboardSummary(
	snapshot: InterfaceSnapshot
): NoticeboardSummary {
	const summary: NoticeboardSummary = {
		attention: 0,
		total: snapshot.threads.length,
		working: 0,
		yourTurn: 0,
	};
	for (const thread of snapshot.threads) {
		const status = threadStatus(thread);
		if (status === "attention") {
			summary.attention += 1;
		} else if (status === "working") {
			summary.working += 1;
		} else if (status === "your-turn") {
			summary.yourTurn += 1;
		}
	}
	return summary;
}

/** The header's one-line count, in the user's terms. */
export function summaryText(summary: NoticeboardSummary): string {
	const parts = [
		tr("{count, plural, one {# note} other {# notes}}", {
			count: summary.total,
		}),
	];
	if (summary.attention > 0) {
		parts.push(tr("{count} need attention", { count: summary.attention }));
	}
	if (summary.yourTurn > 0) {
		parts.push(tr("{count} your turn", { count: summary.yourTurn }));
	}
	if (summary.working > 0) {
		parts.push(tr("{count} working", { count: summary.working }));
	}
	return parts.join(" · ");
}
