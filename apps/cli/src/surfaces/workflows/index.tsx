import { nativeErrorMessage as errText } from "../../core/native-errors.ts";
/* @jsxImportSource @opentui/react */
// Workflows surface (/workflows) - the desktop Workflows page, terminal edition.
// The desktop WorkflowsPage is a React Flow canvas editor; there is no canvas in
// the terminal, so this surface presents the LIST + run-status view (the workflow
// list now lives in the sidebar on desktop; here it is the page body). Ported from
// the legacy src/tabs/workflows.tsx so the new shell does not depend on src/tabs.
//
// Behavior (reused fetch logic, unchanged):
//   - GET /workflows on activation (and 'r' to refresh); a silent failure leaves
//     the list as-is (Core may not be running).
//   - left pane: workflow list (name + description), j/k + arrows to move.
//   - right "run status" pane: selected workflow id/name/desc, then the run state
//     machine. Enter arms a confirm; a second Enter POSTs /workflows/:id/run. Esc
//     clears. A non-terminal run is polled via GET /workflows/runs/:run_id.
//
// Contract adaptation: load gates on `active` (visible tab of its pane), keyboard
// gates on `focused = active && focusedPaneId === paneId` (and stays quiet while a
// text input elsewhere owns raw input).

import type { KeyEvent } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import {
	fetchWorkflows,
	getWorkflowRun,
	runWorkflow,
	type Workflow,
	type WorkflowRun,
} from "@ryuhq/core-client/workflows";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTheme } from "@/components/ui/theme-provider.tsx";
import { useCore } from "../../core/CoreContext.tsx";
import { useInputFocused } from "../../core/InputFocusContext.tsx";
import { tf } from "../../i18n/translate.ts";
import { Loading } from "../../ui/Loading.tsx";
import { useToast } from "../../ui/toast.tsx";
import type { SurfaceModule, SurfaceProps } from "../../workspace/router.ts";
import { useWorkspace } from "../../workspace/WorkspaceContext.tsx";
import { type RunInfo, WorkflowsBody } from "./index-body.tsx";

const POLL_INTERVAL_MS = 1500;

// Flatten Core's output map (key -> value) into display lines - one line per entry.
function outputToLines(output: Record<string, string>): string[] {
	return Object.entries(output).map(([key, value]) => `${key}: ${value}`);
}

function WorkflowsSurface({ active, paneId }: SurfaceProps) {
	const { target } = useCore();
	const theme = useTheme();
	const { notify } = useToast();
	const { focusedPaneId } = useWorkspace();
	const inputFocused = useInputFocused();

	// Focused = this surface is the active tab AND its pane owns the keyboard.
	const focused = active && focusedPaneId === paneId;

	const [workflows, setWorkflows] = useState<Workflow[]>([]);
	const [index, setIndex] = useState(0);
	const [loading, setLoading] = useState(false);
	const [loaded, setLoaded] = useState(false);
	const [confirmPending, setConfirmPending] = useState(false);
	const [run, setRun] = useState<RunInfo | null>(null);
	const [runLoading, setRunLoading] = useState(false);
	const [runError, setRunError] = useState<string | null>(null);

	// Guard against a stale list resolve clobbering fresh data after a node switch.
	const reqRef = useRef(0);
	const lifetimeRef = useRef(false);
	const targetRef = useRef(target);
	targetRef.current = target;
	const listRef = useRef<AbortController | null>(null);
	const pollRef = useRef<AbortController | null>(null);
	const runEpoch = useRef(0);
	const runTarget = useRef(target);
	const listTarget = useRef<typeof target | null>(null);

	const loadWorkflows = useCallback(() => {
		if (!lifetimeRef.current || targetRef.current !== target) {
			return;
		}
		listRef.current?.abort();
		const controller = new AbortController();
		listRef.current = controller;
		const reqId = ++reqRef.current;
		setLoading(true);
		fetchWorkflows(target, controller.signal)
			.then((next) => {
				if (controller.signal.aborted || reqRef.current !== reqId) {
					return;
				}
				listTarget.current = target;
				setWorkflows(next);
				setIndex((i) => (next.length === 0 ? 0 : Math.min(i, next.length - 1)));
				setLoaded(true);
			})
			.catch(() => {
				// Core not running or no workflows - leave the list as-is.
				if (!controller.signal.aborted && reqRef.current === reqId) {
					setLoaded(true);
				}
			})
			.finally(() => {
				if (listRef.current === controller) {
					listRef.current = null;
				}
				if (!controller.signal.aborted && reqRef.current === reqId) {
					setLoading(false);
				}
			});
	}, [target]);

	// Lazy first load on activation; reload on node switch (target identity changes).
	useEffect(() => {
		if (!active) {
			return;
		}
		if (listTarget.current !== target) {
			setWorkflows([]);
			setLoaded(false);
			setIndex(0);
		}
		lifetimeRef.current = true;
		loadWorkflows();
		return () => {
			lifetimeRef.current = false;
			reqRef.current++;
			runEpoch.current++;
			listRef.current?.abort();
			pollRef.current?.abort();
		};
	}, [active, loadWorkflows, target]);

	const selected = listTarget.current === target ? workflows[index] : undefined;

	const clearRun = useCallback(() => {
		runEpoch.current++;
		pollRef.current?.abort();
		setConfirmPending(false);
		setRun(null);
		setRunError(null);
		setRunLoading(false);
	}, []);

	useEffect(() => {
		clearRun();
	}, [target, clearRun]);

	const triggerRun = useCallback(() => {
		const wf = selected;
		if (!wf) {
			return;
		}
		const epoch = ++runEpoch.current;
		runTarget.current = target;
		pollRef.current?.abort();
		setRun(null);
		setRunError(null);
		setRunLoading(true);
		runWorkflow(target, wf.id, {})
			.then((next: WorkflowRun) => {
				if (
					!lifetimeRef.current ||
					targetRef.current !== target ||
					epoch !== runEpoch.current
				) {
					return;
				}
				setRun({
					runId: next.runId,
					status: next.status,
					outputLines: outputToLines(next.output),
				});
				setRunLoading(false);
			})
			.catch((err) => {
				if (
					!lifetimeRef.current ||
					targetRef.current !== target ||
					epoch !== runEpoch.current
				) {
					return;
				}
				setRunError(errText(err));
				setRunLoading(false);
				notify(tf("workflow run failed: {0}", { 0: errText(err) }), "error");
			});
	}, [selected, target, notify]);

	// Poll the active run while it is still progressing. Keyed on the run id +
	// status (primitives) so a poll that leaves the status unchanged does not
	// resubscribe the interval.
	const activeRunId =
		run && runTarget.current === target && run.status === "running"
			? run.runId
			: null;
	useEffect(() => {
		if (!active || activeRunId === null) {
			return;
		}
		const epoch = runEpoch.current;
		let disposed = false;
		let inFlight: AbortController | null = null;
		const timer = setInterval(() => {
			if (disposed || inFlight || epoch !== runEpoch.current) {
				return;
			}
			const controller = new AbortController();
			inFlight = controller;
			pollRef.current = controller;
			getWorkflowRun(target, activeRunId, controller.signal)
				.then((next) => {
					if (
						disposed ||
						controller.signal.aborted ||
						epoch !== runEpoch.current
					) {
						return;
					}
					setRun({
						runId: next.runId,
						status: next.status,
						outputLines: outputToLines(next.output),
					});
				})
				.catch((err) => {
					if (
						!(disposed || controller.signal.aborted) &&
						epoch === runEpoch.current
					) {
						setRunError(errText(err));
					}
				})
				.finally(() => {
					if (inFlight === controller) {
						inFlight = null;
					}
					if (pollRef.current === controller) {
						pollRef.current = null;
					}
				});
		}, POLL_INTERVAL_MS);
		return () => {
			disposed = true;
			clearInterval(timer);
			inFlight?.abort();
		};
	}, [active, activeRunId, target]);

	const handleKey = (key: KeyEvent) => {
		if (key.name === "up" || key.name === "k") {
			setIndex((i) => {
				if (i > 0) {
					setConfirmPending(false);
					return i - 1;
				}
				return i;
			});
		} else if (key.name === "down" || key.name === "j") {
			setIndex((i) => {
				if (i < workflows.length - 1) {
					setConfirmPending(false);
					return i + 1;
				}
				return i;
			});
		} else if (key.name === "return") {
			if (confirmPending) {
				setConfirmPending(false);
				triggerRun();
			} else if (workflows.length > 0) {
				setConfirmPending(true);
			}
		} else if (key.name === "escape") {
			clearRun();
		} else if (key.name === "r") {
			loadWorkflows();
		}
	};

	useKeyboard((key) => {
		if (!focused || inputFocused) {
			return;
		}
		handleKey(key);
	});

	if (loading && !loaded) {
		return <Loading label="Loading workflows…" />;
	}

	return (
		<box flexDirection="column" flexGrow={1} paddingLeft={1} paddingTop={1}>
			<box flexDirection="row" gap={1}>
				<text fg={theme.colors.foreground}>
					<b>Workflows</b>
				</text>
				<text fg={theme.colors.mutedForeground}>
					↑↓ nav · enter run · r refresh · esc clear
				</text>
			</box>
			<WorkflowsBody
				confirmPending={confirmPending}
				index={index}
				run={run}
				runError={runError}
				runLoading={runLoading}
				selected={selected}
				workflows={workflows}
			/>
		</box>
	);
}

/** The Workflows surface module. Registered by src/workspace/router.ts (path
 * /workflows). */
export const workflowsSurface: SurfaceModule = {
	id: "workflows",
	title: "Workflows",
	match: (path) => path === "/workflows" || path.startsWith("/workflows/"),
	Component: WorkflowsSurface,
};
