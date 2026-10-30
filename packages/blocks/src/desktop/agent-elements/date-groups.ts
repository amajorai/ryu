// packages/blocks/src/desktop/agent-elements/date-groups.ts
//
// Day grouping for the chat transcript: which turns belong to the same calendar
// day in the DISPLAY time zone, and what the centred separator above each run
// should read.
//
// GRANULARITY IS THE TURN, NOT THE MESSAGE. A separator can only sit between
// direct children of the scroller's Content, and a turn is one child (see
// message-list.tsx). The visible consequence, which is the right trade: a reply
// that lands after midnight stays with the question that prompted it, under the
// question's date.
//
// CONSECUTIVE RUNS ONLY — never sort, never reorder. A merged transcript
// (useMergedAgentThreads stacks older threads above the live one) can be
// non-monotonic; grouping runs in place then shows the same date twice, which
// is honest, instead of scrambling the order history actually happened in.
//
// The day KEY is the epoch-ms of that day's midnight in the display zone,
// stringified. That makes it stable, comparable and directly renderable, and it
// comes straight from `startOfTodayMs` so a transcript can never disagree with
// the sidebar's buckets about where a day starts.

import { formatDate, startOfTodayMs } from "@ryu/ui/lib/timezone.ts";
import type { NativeSdkValue } from "./utils/native-sdk-observation.ts";

/** The one field of a message this module reads, when it is there at all. */
export interface DatedMessage {
	createdAt?: Date | number | string;
}

/**
 * Structurally the turn shape `groupMessagesIntoTurns` produces in
 * message-list.tsx, narrowed to what grouping needs. Kept structural so this
 * module never has to import `UIMessage`.
 *
 * The members are typed `object`, not `DatedMessage`, for a concrete reason:
 * `UIMessage` does not declare `createdAt` at all — every surface that shows a
 * message time reads it through a cast — and TypeScript's weak-type check
 * rejects an all-optional target that shares no property with the source, so a
 * `DatedMessage[]` parameter would refuse the real transcript. `DatedMessage`
 * above stays as the documented shape of what `readCreatedAt` looks for.
 */
export interface DayGroupableTurn {
	assistantMsgs?: readonly object[];
	userMsg?: object;
}

/** One consecutive run of turns sharing a day. */
export interface DayGroup {
	/**
	 * Day-start epoch ms as a string, or `null` for a HEAD run of turns that
	 * carry no usable timestamp at all. A `null` group renders NO separator —
	 * "Invalid Date" must never reach the screen.
	 */
	dayKey: string | null;
	/** Index into the turns array where this run begins. */
	startIndex: number;
}

const MS_PER_DAY = 86_400_000;

/**
 * How far back a bare weekday name stays unambiguous. Six: seven days back
 * repeats today's own name, which reads as "today" at a glance.
 */
const WEEKDAY_WINDOW_DAYS = 6;

/**
 * Midnight `days` before `startOfToday`, in the display zone.
 *
 * It lands on MIDDAY first and only then snaps to that day's start, because
 * `startOfToday - days * MS_PER_DAY` is not a midnight at all across a DST
 * transition: the week of a spring-forward is 167 hours long, so subtracting
 * whole days lands an hour INTO the neighbouring day and the comparison picks
 * the wrong bucket. Midday has twelve hours of slack against a one-hour shift.
 */
function dayStartDaysBefore(startOfToday: number, days: number): number {
	return startOfTodayMs(startOfToday - days * MS_PER_DAY + MS_PER_DAY / 2);
}

/** `createdAt` as epoch ms, or `null` when it is absent or unparseable. */
function readCreatedAt(msg: NativeSdkValue): number | null {
	// SAFETY: This is only an optional native member observation. It does not
	// classify the receiver or its timestamp; the cell stays in the full SDK
	// opaque domain, with ordinary scalar boxing/nullish behavior unchanged.
	const value = (msg as { createdAt?: NativeSdkValue } | undefined)?.createdAt;
	if (value === undefined || value === null) {
		return null;
	}
	// SAFETY: The native Date constructor owns coercion and rejection here.
	// Its declared input slot annotates this immediate call only; the opaque
	// operand is not promised to be a decoded Date/string/number elsewhere.
	const ms =
		value instanceof Date
			? value.getTime()
			: new Date(value as ConstructorParameters<typeof Date>[0]).getTime();
	return Number.isNaN(ms) ? null : ms;
}

/**
 * The turn's own instant: the user message's stamp, else the first assistant
 * message that has one. `null` when the turn is undated.
 *
 * Undated is a real, common path, not a defect: subagent transcripts
 * (CoworkContextPanel), the storyboard/e2e fixtures and Council all build
 * messages with no `createdAt` at all, and imported ACP threads
 * (apps/core/src/native_history.rs) carry no per-message time either.
 */
function turnTimeMs(turn: DayGroupableTurn): number | null {
	const fromUser = readCreatedAt(turn.userMsg);
	if (fromUser !== null) {
		return fromUser;
	}
	for (const msg of turn.assistantMsgs ?? []) {
		const ms = readCreatedAt(msg);
		if (ms !== null) {
			return ms;
		}
	}
	return null;
}

/** The turn's display-zone day key, or `null` when it carries no usable stamp. */
export function dayKeyOf(turn: DayGroupableTurn): string | null {
	const ms = turnTimeMs(turn);
	return ms === null ? null : String(startOfTodayMs(ms));
}

/**
 * Consecutive runs of turns sharing a day, in transcript order.
 *
 * An undated turn INHERITS the day of the run it lands in rather than breaking
 * it — a missing stamp is a gap in the data, not evidence of a new day. Undated
 * turns BEFORE any dated one form a head group with `dayKey: null`, which
 * renders no separator; a transcript where nothing is dated is exactly that one
 * group, so the whole undated world (subagents, storyboard, e2e fixtures) gets
 * zero separators without a special case.
 */
export function groupTurnsByDay(
	turns: readonly DayGroupableTurn[]
): DayGroup[] {
	const groups: DayGroup[] = [];
	for (const [index, turn] of turns.entries()) {
		const dayKey = dayKeyOf(turn);
		if (dayKey === null) {
			if (groups.length === 0) {
				groups.push({ dayKey: null, startIndex: 0 });
			}
			continue;
		}
		if (groups.at(-1)?.dayKey !== dayKey) {
			groups.push({ dayKey, startIndex: index });
		}
	}
	return groups;
}

/**
 * The separator/chip text for a day key: `Today`, `Yesterday`, a weekday name
 * inside the last week, then an explicit date.
 *
 * The bucket vocabulary mirrors `dateBucketKey` in the sidebar
 * (apps/desktop/src/components/layout/AppSidebar.tsx) so the two surfaces can
 * never disagree about where "yesterday" ends. Every boundary is a real
 * display-zone midnight (`dayStartDaysBefore`) rather than an N×24h
 * subtraction, so the two DST weeks a year do not slip a label — the
 * spring-forward case is what would otherwise print last Friday as plain
 * "Friday" on a Friday.
 *
 * This function owns no timer. A mounted `MessageList` passes a
 * `startOfToday` that follows the shared display-day store
 * (`@ryu/ui/lib/display-day.ts`): one bounded timer plus focus/visibility
 * wakes for every mounted consumer, so "Today" becomes "Yesterday" at the
 * display-zone midnight without a per-transcript interval.
 */
export function dayLabel(dayKey: string, startOfToday: number): string {
	const dayStart = Number(dayKey);
	if (!Number.isFinite(dayStart)) {
		return "";
	}
	if (dayStart >= startOfToday) {
		return "Today";
	}
	if (dayStart >= dayStartDaysBefore(startOfToday, 1)) {
		return "Yesterday";
	}
	if (dayStart >= dayStartDaysBefore(startOfToday, WEEKDAY_WINDOW_DAYS)) {
		return formatDate(dayStart, { weekday: "long" });
	}
	return formatDate(dayStart, {
		day: "numeric",
		month: "long",
		year: "numeric",
	});
}

/**
 * `turnIndex -> dayKey` for the turns that OPEN a group, so the transcript can
 * ask "does a separator go above this index?" in O(1) inside its map. Groups
 * with a `null` key are omitted: they render nothing.
 */
export function separatorKeyByTurnIndex(
	groups: readonly DayGroup[]
): Map<number, string> {
	const byIndex = new Map<number, string>();
	for (const group of groups) {
		if (group.dayKey !== null) {
			byIndex.set(group.startIndex, group.dayKey);
		}
	}
	return byIndex;
}

/**
 * Identity of the rendered day dividers: each one's day plus the key of the
 * turn row that carries it. The floating date pill rebuilds its observer when
 * this changes. Day keys alone are not enough: paging in older turns of the
 * SAME day moves that day's divider onto a newly mounted row while the run of
 * days stays identical, which would leave the observer on a detached node.
 */
export function dayDividersKey(
	groups: readonly DayGroup[],
	turnKeyAt: (turnIndex: number) => string
): string {
	const parts: string[] = [];
	for (const group of groups) {
		if (group.dayKey !== null) {
			parts.push(`${group.dayKey}@${turnKeyAt(group.startIndex)}`);
		}
	}
	return parts.join("|");
}

/**
 * The day key of the group CONTAINING `turnIndex` — what the floating header
 * needs, since the scroller's current anchor names a turn, not a group.
 *
 * Only turns with a user message are scroll anchors, so a group that starts
 * with an assistant-only turn is entered while `currentAnchorId` still names an
 * anchor in the PREVIOUS group. Resolving by containment rather than by the
 * anchor's own turn is what keeps the chip honest there.
 */
export function dayKeyAtTurnIndex(
	groups: readonly DayGroup[],
	turnIndex: number
): string | null {
	let found: string | null = null;
	for (const group of groups) {
		if (group.startIndex > turnIndex) {
			break;
		}
		found = group.dayKey;
	}
	return found;
}
