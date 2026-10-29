import type { InterfaceEvent } from "@ryuhq/protocol/interfaces";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import { fetchJobs, type ScheduledJob } from "@/src/lib/api/schedules.ts";
import { buildCalendarEvents } from "@/src/lib/calendar/events.ts";
import { useCoreRefresh } from "@/src/lib/core-refresh.ts";
import { toInterfaceEvents } from "./snapshot.ts";

/** Six weeks either side of today: a month view plus its spill-over weeks. */
const WINDOW_DAYS = 42;
const DAY_MS = 86_400_000;
/** Projected runs move on as time passes; refresh them on this cadence. */
const REFRESH_MS = 60_000;

/** Jobs read from one node, tagged with the node authority that served them. */
interface NodeJobs {
	authority: string;
	jobs: ScheduledJob[];
}

/**
 * Run history over the past window and projected runs from now on. Projection
 * starts at `now`, so no "upcoming" run is ever placed on a past date.
 */
export function interfaceEventsAround(
	jobs: ScheduledJob[],
	now: number
): InterfaceEvent[] {
	const nowDate = new Date(now);
	const history = buildCalendarEvents(
		jobs,
		new Date(now - WINDOW_DAYS * DAY_MS),
		nowDate
	).filter((event) => event.kind === "past");
	const upcoming = buildCalendarEvents(
		jobs,
		nowDate,
		new Date(now + WINDOW_DAYS * DAY_MS)
	).filter((event) => event.kind === "upcoming");
	return toInterfaceEvents([...history, ...upcoming], now);
}

export interface InterfaceEventsState {
	/** Past and projected runs, or undefined until loaded / when disabled. */
	events: InterfaceEvent[] | undefined;
	/** The jobs behind them (for linking a run to its cron routine). */
	jobs: ScheduledJob[] | undefined;
}

/**
 * Scheduled runs (past and projected) around now, for the interfaces that show
 * them. Fetches only while `enabled`, so the other interfaces never ask Core
 * for schedules. Both fields are undefined until the first load, or when
 * disabled. Jobs are scoped to the node that served them: after a node or
 * credential switch the previous node's schedule is never shown, even while
 * the new request is in flight.
 */
export function useInterfaceEvents(enabled: boolean): InterfaceEventsState {
	const node = useActiveNode();
	const { token, url, userJwt } = node;
	const authority = JSON.stringify([url, token ?? null, userJwt ?? null]);
	const [state, setState] = useState<NodeJobs | null>(null);
	const [tick, setTick] = useState(0);

	useEffect(() => {
		if (!enabled) {
			setState(null);
			return;
		}
		let cancelled = false;
		fetchJobs({ token: token ?? null, url, userJwt: userJwt ?? null })
			.then((list) => {
				if (!cancelled) {
					setState({ authority, jobs: list });
				}
			})
			.catch(() => {
				// Schedules are optional context; a failed load leaves the calendar
				// showing conversations only.
				if (!cancelled) {
					setState({ authority, jobs: [] });
				}
			});
		return () => {
			cancelled = true;
		};
	}, [authority, enabled, token, url, userJwt, tick]);

	const refresh = useCallback(() => setTick((value) => value + 1), []);
	useCoreRefresh(refresh);
	useEffect(() => {
		if (!enabled) {
			return;
		}
		const timer = setInterval(refresh, REFRESH_MS);
		return () => clearInterval(timer);
	}, [enabled, refresh]);

	// Same-node timer refreshes keep the last list on screen; another node's
	// list is dropped as soon as the authority changes.
	const jobs = state && state.authority === authority ? state.jobs : null;
	return useMemo(
		() =>
			jobs
				? { events: interfaceEventsAround(jobs, Date.now()), jobs }
				: { events: undefined, jobs: undefined },
		[jobs]
	);
}
