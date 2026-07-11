/* @jsxImportSource @opentui/react */
// Workflows tab - parity with apps/cli's Workflows tab (apps/cli/src/{ui.rs
// render_workflows_content, main.rs refresh_workflows/do_trigger_workflow_run/
// poll_workflow_run, app.rs Workflow}). LIST view only - there is no React Flow
// canvas in the terminal.
//
// Behavior mirrored from the Rust TUI:
//   - GET /workflows on first activation (and 'r' to refresh); silent "core not
//     running" when the fetch fails and the list is still empty.
//   - left pane: workflow list (name + description), j/k + arrows to move.
//   - right "run status" pane: selected workflow id/name/desc, then the run
//     state machine.
//   - Enter arms a confirm ("Press enter to confirm run, esc to cancel"); a
//     second Enter triggers POST /workflows/:id/run. Esc clears the confirm and
//     any prior run.
//   - while a run is active and non-terminal (not completed/failed) the run is
//     polled via GET /workflows/runs/:run_id, same as the Rust tick poll.
//
// Wiring note: the Rust client (apps/cli/src/api.rs) reads stale field names
// (top-level `run_id`, `run.state`, string `run.output`) that no longer match
// Core. This tab uses @ryuhq/core-client/workflows, which maps the CURRENT Core
// shape ({ run: { run_id, status, output: map, ... } }), so the run actually
// surfaces its id/status/output. Same UX, correct data.

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
import { useCore } from "../core/CoreContext.tsx";
import { useInputFocused } from "../core/InputFocusContext.tsx";
import { Loading } from "../ui/Loading.tsx";
import { useToast } from "../ui/toast.tsx";
import type { TabProps } from "./types.ts";

const POLL_INTERVAL_MS = 1500;
const MAX_OUTPUT_LINES = 10;

// Flatten Core's output map (key -> value) into display lines. The Rust read a
// single string field; current Core returns a map, so we render one line per
// entry (parity intent: show the run's output).
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

export function WorkflowsTab({ active }: TabProps) {
	const { target } = useCore();
	const theme = useTheme();
	const { notify } = useToast();
	const inputFocused = useInputFocused();

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
				// Core not running or no workflows - leave the list as-is (parity with
				// the Rust refresh_workflows, which swallows the error).
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

	// Lazy first load on activation; reload on node switch.
	useEffect(() => {
		if (active) {
			loadWorkflows();
		}
		// loadWorkflows depends on `target`, whose identity changes on a node
		// switch, so this also reloads when the active node changes.
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

	// Poll the active run while it is still progressing, mirroring the Rust tick
	// poll. runWorkflow returns the terminal run synchronously in the common case,
	// so this only fires in the rare "running" window. Keyed on the run id + status
	// (primitives) rather than the run object so a poll that leaves the status
	// unchanged does not resubscribe the interval. `awaiting_input` is a durable
	// human-in-the-loop gate that cannot self-progress (resume is out of terminal
	// scope), so it is not polled.
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
		if (!active || inputFocused) {
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
