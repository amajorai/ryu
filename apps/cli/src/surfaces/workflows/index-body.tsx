/* @jsxImportSource @opentui/react */
// Workflows surface body: workflow list, run status pane, and run state views.
// Split out of index.tsx (the surface module + data/keyboard logic).

import { useRenderer } from "@opentui/react";
import type { Workflow } from "@ryuhq/core-client/workflows";
import { Badge } from "@/components/ui/badge.tsx";
import { Card } from "@/components/ui/card.tsx";
import { Divider } from "@/components/ui/divider.tsx";
import { StatusMessage } from "@/components/ui/status-message.tsx";
import { useTheme } from "@/components/ui/theme-provider.tsx";
import { tf } from "../../i18n/translate.ts";

const MAX_OUTPUT_LINES = 10;

export interface RunInfo {
	outputLines: string[];
	runId: string;
	status: string;
}

export function WorkflowsBody({
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
	const renderer = useRenderer();

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
			<box flexShrink={0} marginRight={1}>
				<Divider
					color={theme.colors.border}
					height={Math.max(1, renderer.height - 8)}
					orientation="vertical"
				/>
			</box>
			<box flexBasis={0} flexGrow={3} paddingLeft={1}>
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
							<text
								fg={isSel ? theme.colors.primary : theme.colors.mutedForeground}
							>
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
			<MetaRow
				label="id"
				value={workflow.id}
				valueColor={theme.colors.mutedForeground}
			/>
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
					valueColor={theme.colors.mutedForeground}
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
			<StatusMessage variant="error">
				{tf("error: {runError}", { runError })}
			</StatusMessage>
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
			<MetaRow
				label="run"
				value={run.runId}
				valueColor={theme.colors.mutedForeground}
			/>
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
