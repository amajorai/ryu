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
import { Badge } from "@/components/ui/badge.tsx";
import { Card } from "@/components/ui/card.tsx";
import { StatusMessage } from "@/components/ui/status-message.tsx";
import { useTheme } from "@/components/ui/theme-provider.tsx";
import { useCore } from "../../core/CoreContext.tsx";
import { useInputFocused } from "../../core/InputFocusContext.tsx";
import { Loading } from "../../ui/Loading.tsx";
import { useToast } from "../../ui/toast.tsx";
import type { SurfaceModule, SurfaceProps } from "../../workspace/router.ts";
import { useWorkspace } from "../../workspace/WorkspaceContext.tsx";

const POLL_INTERVAL_MS = 1500;
const MAX_OUTPUT_LINES = 10;

// Flatten Core's output map (key -> value) into display lines - one line per entry.
function outputToLines(output: Record<string, string>): string[] {
	return Object.entries(output).map(([key, value]) => `${key}: ${value}`);
}

interface RunInfo {
	outputLines: string[];
	runId: string;
	status: string;
}

function errText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
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

	const loadWorkflows = useCallback(() => {
		const reqId = ++reqRef.current;
		setLoading(true);
		fetchWorkflows(target)
			.then((next) => {
				if (reqRef.current !== reqId) {
					return;
				}
				setWorkflows(next);
				setIndex((i) => (next.length === 0 ? 0 : Math.min(i, next.length - 1)));
				setLoaded(true);
			})
			.catch(() => {
				// Core not running or no workflows - leave the list as-is.
				if (reqRef.current === reqId) {
					setLoaded(true);
				}
			})
			.finally(() => {
				if (reqRef.current === reqId) {
					setLoading(false);
				}
			});
	}, [target]);

	// Lazy first load on activation; reload on node switch (target identity changes).
	useEffect(() => {
		if (active) {
			loadWorkflows();
		}
	}, [active, loadWorkflows]);

	const selected = workflows[index];

	const clearRun = useCallback(() => {
		setConfirmPending(false);
		setRun(null);
		setRunError(null);
		setRunLoading(false);
	}, []);

	const triggerRun = useCallback(() => {
		const wf = selected;
		if (!wf) {
			return;
		}
		setRun(null);
		setRunError(null);
		setRunLoading(true);
		runWorkflow(target, wf.id, {})
			.then((next: WorkflowRun) => {
				setRun({
					runId: next.runId,
					status: next.status,
					outputLines: outputToLines(next.output),
				});
				setRunLoading(false);
			})
			.catch((err: unknown) => {
				setRunError(errText(err));
				setRunLoading(false);
				notify(`workflow run failed: ${errText(err)}`, "error");
			});
	}, [selected, target, notify]);

	// Poll the active run while it is still progressing. Keyed on the run id +
	// status (primitives) so a poll that leaves the status unchanged does not
	// resubscribe the interval.
	const activeRunId = run && run.status === "running" ? run.runId : null;
	useEffect(() => {
		if (!active || activeRunId === null) {
			return;
		}
		const timer = setInterval(() => {
			getWorkflowRun(target, activeRunId)
				.then((next) => {
					setRun({
						runId: next.runId,
						status: next.status,
						outputLines: outputToLines(next.output),
					});
				})
				.catch((err: unknown) => {
					setRunError(errText(err));
				});
		}, POLL_INTERVAL_MS);
		return () => clearInterval(timer);
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

function WorkflowsBody({
	workflows,
	index,
	selected,
	run,
	runLoading,
	runError,
	confirmPending,
}: {
	confirmPending: boolean;
	index: number;
	run: RunInfo | null;
	runError: string | null;
	runLoading: boolean;
	selected: Workflow | undefined;
	workflows: Workflow[];
}) {
	const theme = useTheme();

	if (workflows.length === 0) {
		return (
			<box marginTop={1}>
				<text fg={theme.colors.mutedForeground}>
					no workflows configured - press r to refresh
				</text>
			</box>
		);
	}

	return (
		<box flexDirection="row" flexGrow={1} gap={1} marginTop={1}>
			<box flexBasis={0} flexGrow={2}>
				<Card title="workflows">
					<WorkflowList index={index} workflows={workflows} />
				</Card>
			</box>
			<box flexBasis={0} flexGrow={3}>
				<Card title="run status">
					<RunStatusPane
						confirmPending={confirmPending}
						run={run}
						runError={runError}
						runLoading={runLoading}
						selected={selected}
					/>
				</Card>
			</box>
		</box>
	);
}

function WorkflowList({
	workflows,
	index,
}: {
	index: number;
	workflows: Workflow[];
}) {
	const theme = useTheme();
	return (
		<box flexDirection="column">
			{workflows.map((wf, i) => {
				const isSel = i === index;
				return (
					<box flexDirection="column" key={wf.id} marginBottom={1}>
						<box flexDirection="row" gap={1}>
							<text fg={isSel ? theme.colors.primary : theme.colors.muted}>
								{isSel ? "›" : " "}
							</text>
							<text fg={isSel ? theme.colors.accent : theme.colors.foreground}>
								{isSel ? <b>{wf.name}</b> : wf.name}
							</text>
						</box>
						{wf.description ? (
							<text
								fg={theme.colors.mutedForeground}
							>{`  ${wf.description}`}</text>
						) : null}
					</box>
				);
			})}
		</box>
	);
}

function RunStatusPane({
	selected,
	run,
	runLoading,
	runError,
	confirmPending,
}: {
	confirmPending: boolean;
	run: RunInfo | null;
	runError: string | null;
	runLoading: boolean;
	selected: Workflow | undefined;
}) {
	return (
		<box flexDirection="column">
			{selected ? <WorkflowMeta workflow={selected} /> : null}
			<box marginTop={1}>
				<RunState
					confirmPending={confirmPending}
					run={run}
					runError={runError}
					runLoading={runLoading}
				/>
			</box>
		</box>
	);
}

function WorkflowMeta({ workflow }: { workflow: Workflow }) {
	const theme = useTheme();
	return (
		<box flexDirection="column">
			<MetaRow label="id" value={workflow.id} valueColor={theme.colors.muted} />
			<box flexDirection="row" gap={1}>
				<text fg={theme.colors.mutedForeground}>name</text>
				<text fg={theme.colors.foreground}>
					<b>{workflow.name}</b>
				</text>
			</box>
			{workflow.description ? (
				<MetaRow
					label="desc"
					value={workflow.description}
					valueColor={theme.colors.muted}
				/>
			) : null}
		</box>
	);
}

function MetaRow({
	label,
	value,
	valueColor,
}: {
	label: string;
	value: string;
	valueColor: string;
}) {
	const theme = useTheme();
	return (
		<box flexDirection="row" gap={1}>
			<text fg={theme.colors.mutedForeground}>{label}</text>
			<text fg={valueColor}>{value}</text>
		</box>
	);
}

function RunState({
	confirmPending,
	runLoading,
	runError,
	run,
}: {
	confirmPending: boolean;
	run: RunInfo | null;
	runError: string | null;
	runLoading: boolean;
}) {
	const theme = useTheme();

	if (confirmPending) {
		return (
			<text fg={theme.colors.warning}>
				<b>Press enter to confirm run, esc to cancel</b>
			</text>
		);
	}
	if (runLoading) {
		return <StatusMessage variant="loading">starting run…</StatusMessage>;
	}
	if (runError) {
		return (
			<StatusMessage variant="error">{`error: ${runError}`}</StatusMessage>
		);
	}
	if (run) {
		return <RunResult run={run} />;
	}
	return (
		<text fg={theme.colors.mutedForeground}>
			select a workflow and press enter to run it
		</text>
	);
}

function RunResult({ run }: { run: RunInfo }) {
	const theme = useTheme();
	const outputLines = run.outputLines.slice(0, MAX_OUTPUT_LINES);
	return (
		<box flexDirection="column">
			<MetaRow label="run" value={run.runId} valueColor={theme.colors.muted} />
			<box flexDirection="row" gap={1}>
				<text fg={theme.colors.mutedForeground}>state</text>
				<RunStateBadge status={run.status} />
			</box>
			{outputLines.length > 0 ? (
				<box flexDirection="column" marginTop={1}>
					<text fg={theme.colors.mutedForeground}>output</text>
					{outputLines.map((line) => (
						<text fg={theme.colors.foreground} key={line}>
							{`  ${line}`}
						</text>
					))}
				</box>
			) : null}
		</box>
	);
}

function RunStateBadge({ status }: { status: string }) {
	if (status === "completed") {
		return <StatusMessage variant="success">completed</StatusMessage>;
	}
	if (status === "failed") {
		return <StatusMessage variant="error">failed</StatusMessage>;
	}
	if (status === "running") {
		return <StatusMessage variant="loading">running</StatusMessage>;
	}
	return (
		<Badge bordered={false} variant="secondary">
			{status}
		</Badge>
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
