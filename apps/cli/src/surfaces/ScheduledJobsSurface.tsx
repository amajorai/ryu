/* @jsxImportSource @opentui/react */
// The scheduled-jobs screen shared by the Calendar (/calendar) and Tasks (/tasks)
// surfaces. Both present the scheduled (heartbeat) jobs from GET /heartbeat/jobs
// and differ only in copy, ordering, row layout and whether Enter opens another
// path, so each surface passes a ScheduledJobsScreen and keeps its own row.
//
// The screen PREFERS a contributed declarative view: an enabled plugin contributing
// a `views` entry with id "surface:<id>" claims the surface, and the shell renders
// that spec (src/ui/ContributedView.tsx) instead of the built-in list. Read-only
// (the terminal never mutates jobs here). Keys are gated on being the focused
// pane's active tab: ↑↓/jk navigate, r refreshes, Enter opens `openPath`.

import { useKeyboard } from "@opentui/react";
import type { ApiTarget } from "@ryuhq/core-client/client";
import { fetchJobs, type ScheduledJob } from "@ryuhq/core-client/schedules";
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Card } from "@/components/ui/card.tsx";
import { useTheme } from "@/components/ui/theme-provider.tsx";
import { useSurfaceView } from "../core/ContributionsContext.tsx";
import { useCore } from "../core/CoreContext.tsx";
import { useInputFocused } from "../core/InputFocusContext.tsx";
import { humanizeError, nativeErrorMessage } from "../core/native-errors.ts";
import { ContributedViewPanel } from "../ui/ContributedView.tsx";
import { ErrorView } from "../ui/ErrorView.tsx";
import { Loading } from "../ui/Loading.tsx";
import { windowStart } from "../ui/useListWindow.ts";
import type { SurfaceProps } from "../workspace/router.ts";
import { useWorkspace } from "../workspace/WorkspaceContext.tsx";

type JobOrder = (a: ScheduledJob, b: ScheduledJob) => number;

export interface ScheduledJobRowProps {
	job: ScheduledJob;
	selected: boolean;
}

export interface ScheduledJobsScreen {
	/** Card title over the job list and its empty state. */
	cardTitle: string;
	/** The line inside the card when there are no jobs. */
	emptyText: string;
	/** Header hint, blank while a contributed view owns the screen. */
	hint: string;
	/** Label of the first-load spinner. */
	loadingLabel: string;
	/** Path Enter opens; Enter does nothing when absent. */
	openPath?: string;
	/** One job row. Typed as a plain function (not ComponentType) so it
	 * satisfies OpenTUI's JSX element constraint under React 19's ReactNode. */
	Row: (props: ScheduledJobRowProps) => ReactNode;
	/** Order applied to each loaded list; Core's order is kept when absent. */
	sort?: JobOrder;
	/** The surface id — and therefore the `views` id an app declares to claim
	 * this screen, as the reserved `surface:<id>` token (see viewClaimingSurface
	 * in src/core/contributions.ts). */
	surfaceId: string;
	/** Bold header title. */
	title: string;
	/** Rows shown in the window around the selection. */
	visibleRows: number;
}

/** The scheduled jobs on `target`, loaded by `runLoad`, with the selection index
 *  clamped to each new list. */
function useScheduledJobs(target: ApiTarget, sort: JobOrder | undefined) {
	const [jobs, setJobs] = useState<ScheduledJob[]>([]);
	const [index, setIndex] = useState(0);
	const [loading, setLoading] = useState(false);
	const [loaded, setLoaded] = useState(false);
	const [error, setError] = useState<string | null>(null);

	// Track the latest request so a stale resolve cannot clobber fresh data.
	const reqRef = useRef(0);

	const runLoad = useCallback(() => {
		const reqId = ++reqRef.current;
		setLoading(true);
		setError(null);
		fetchJobs(target)
			.then((next) => {
				if (reqRef.current !== reqId) {
					return;
				}
				const ordered = sort ? [...next].sort(sort) : next;
				setJobs(ordered);
				setIndex((i) =>
					ordered.length === 0 ? 0 : Math.min(i, ordered.length - 1)
				);
				setLoaded(true);
			})
			.catch((err) => {
				if (reqRef.current !== reqId) {
					return;
				}
				setError(nativeErrorMessage(err));
				setLoaded(true);
			})
			.finally(() => {
				if (reqRef.current === reqId) {
					setLoading(false);
				}
			});
	}, [target, sort]);

	return { error, index, jobs, loaded, loading, runLoad, setIndex };
}

/** Build a scheduled-jobs surface Component from its screen description. */
export function scheduledJobsSurface(
	screen: ScheduledJobsScreen
): (props: SurfaceProps) => ReactNode {
	const { Row } = screen;
	return function ScheduledJobsSurface({ active, paneId }: SurfaceProps) {
		const { target } = useCore();
		const theme = useTheme();
		const { focusedPaneId, openTab } = useWorkspace();
		const focused = active && focusedPaneId === paneId;
		const inputFocused = useInputFocused();
		const contributed = useSurfaceView(screen.surfaceId);
		const { error, index, jobs, loaded, loading, runLoad, setIndex } =
			useScheduledJobs(target, screen.sort);

		// Lazy load on activation, and reload on node switch (url/token). Skipped
		// while a contributed view owns the screen — the built-in list is not
		// rendered then, so fetching its data would be pure waste.
		useEffect(() => {
			if (active && !contributed) {
				runLoad();
			}
		}, [active, contributed, runLoad]);

		useKeyboard((key) => {
			if (!focused || contributed || inputFocused) {
				return;
			}
			if (key.name === "up" || key.name === "k") {
				setIndex((i) => Math.max(0, i - 1));
			} else if (key.name === "down" || key.name === "j") {
				setIndex((i) => Math.min(Math.max(0, jobs.length - 1), i + 1));
			} else if (key.name === "r") {
				runLoad();
			} else if (key.name === "return" && screen.openPath) {
				openTab(screen.openPath);
			}
		});

		const page = (body: ReactNode) => (
			<box flexDirection="column" flexGrow={1} paddingTop={1}>
				<box flexDirection="row" gap={2} paddingBottom={1} paddingLeft={1}>
					<text fg={theme.colors.foreground}>
						<b>{screen.title}</b>
					</text>
					<text fg={theme.colors.mutedForeground}>
						{contributed ? "" : screen.hint}
					</text>
				</box>
				{body}
			</box>
		);

		// An app claimed this surface: render its declarative view in place of the
		// built-in list, keeping the page frame so the shell still looks like itself.
		if (contributed) {
			return page(
				<box flexDirection="column" paddingLeft={1}>
					<ContributedViewPanel focused={focused} view={contributed} />
				</box>
			);
		}

		if (loading && !loaded) {
			return page(<Loading label={screen.loadingLabel} />);
		}

		if (error) {
			return page(
				<ErrorView
					message={humanizeError(error, { url: target.url })}
					onRetry
				/>
			);
		}

		if (jobs.length === 0) {
			return page(
				<box paddingLeft={1}>
					<Card title={screen.cardTitle}>
						<text fg={theme.colors.mutedForeground}>{screen.emptyText}</text>
					</Card>
				</box>
			);
		}

		const selected = Math.min(index, jobs.length - 1);
		// Window the rows so the selection stays visible without a focus-capturing
		// scrollbox (which would fight the keyboard handler for arrow keys).
		const start = windowStart(selected, jobs.length, screen.visibleRows);
		const visible = jobs.slice(start, start + screen.visibleRows);

		return page(
			<box paddingLeft={1}>
				<Card title={screen.cardTitle}>
					{visible.map((job, i) => (
						<Row job={job} key={job.id} selected={start + i === selected} />
					))}
					{jobs.length > visible.length ? (
						<text fg={theme.colors.mutedForeground}>
							{`${selected + 1}/${jobs.length}`}
						</text>
					) : null}
				</Card>
			</box>
		);
	};
}
