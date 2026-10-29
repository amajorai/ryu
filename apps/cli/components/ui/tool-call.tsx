// @ts-nocheck - termcn compatibility surface; host-owned lifecycle fixes are protected by scripts/vendor-termcn.ts
/* @jsxImportSource @opentui/react */

import { TextAttributes } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { Diff, toolDiffLines } from "@/components/ui/diff";

import { useTheme, useUnicode } from "@/components/ui/theme-provider";
import { useAnimation } from "@/hooks/use-animation";
import type {
	ChatToolArguments,
	ChatToolResult,
} from "@/src/core/chatTranscript.ts";
import { useInputFocused } from "@/src/core/InputFocusContext";
import { formatToolDuration } from "@/src/core/transcriptPresentation.ts";

export type ToolCallStatus =
	| "pending"
	| "running"
	| "success"
	| "error"
	/** Ryu host extension: the turn ended before the tool reported a result. */
	| "interrupted"
	/** Ryu host extension: the user rejected the tool's permission request. */
	| "denied";

export interface ToolCallProps {
	name: string;
	args?: ChatToolArguments;
	status: ToolCallStatus;
	result?: ChatToolResult;
	duration?: number;
	collapsible?: boolean;
	defaultCollapsed?: boolean;
	/** Ryu host extension: one-row argument summary shown after the name. */
	summary?: string;
	/** Ryu host extension: `+N -M` line counts shown without expanding. */
	diffStat?: { added: number; removed: number };
	/** Ryu host extension: gerund label (`Reading`) while pending/running. */
	pendingLabel?: string;
	/** Ryu host extension: a permission prompt is waiting on this call. */
	awaitingPermission?: boolean;
}

const UNICODE_SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const ASCII_SPINNER = ["-", "\\", "|", "/"];

export const ToolCall = ({
	name,
	args,
	status,
	result,
	duration,
	collapsible = true,
	defaultCollapsed = true,
	summary,
	diffStat,
	pendingLabel,
	awaitingPermission = false,
}: ToolCallProps) => {
	const theme = useTheme();
	const unicode = useUnicode();
	const diffLines = toolDiffLines(name, args);
	const textResult = z.string().safeParse(result);
	const [collapsed, setCollapsed] = useState(defaultCollapsed);
	const [elapsed, setElapsed] = useState(0);
	const startRef = useRef(Date.now());
	const frame = useAnimation(status === "running" ? 12 : 0);

	const spinnerFrames = unicode ? UNICODE_SPINNER : ASCII_SPINNER;
	const spinnerIcon = spinnerFrames[frame % spinnerFrames.length] ?? "-";

	useEffect(() => {
		if (status === "running") {
			startRef.current = Date.now();
			setElapsed(0);
		}
	}, [status]);

	useEffect(() => {
		if (status !== "running" || duration !== undefined) {
			return;
		}
		const updateElapsed = () => setElapsed(Date.now() - startRef.current);
		updateElapsed();
		const id = setInterval(updateElapsed, 100);
		return () => clearInterval(id);
	}, [status, duration]);

	const statusIcon = () => {
		if (awaitingPermission) {
			return (
				<text fg={theme.colors.warning ?? "yellow"} flexShrink={0}>
					{unicode ? "△" : "[?]"}
				</text>
			);
		}
		switch (status) {
			case "pending": {
				return (
					<text fg={theme.colors.mutedForeground} flexShrink={0}>
						{unicode ? "○" : "[ ]"}
					</text>
				);
			}
			case "running": {
				return (
					<text fg={theme.colors.primary} flexShrink={0}>
						{spinnerIcon}
					</text>
				);
			}
			case "success": {
				return (
					<text fg={theme.colors.success ?? "green"} flexShrink={0}>
						{unicode ? "✓" : "[x]"}
					</text>
				);
			}
			case "error": {
				return (
					<text fg={theme.colors.error ?? "red"} flexShrink={0}>
						{unicode ? "✗" : "[!]"}
					</text>
				);
			}
			case "interrupted": {
				return (
					<text fg={theme.colors.warning ?? "yellow"} flexShrink={0}>
						{unicode ? "⊘" : "[/]"}
					</text>
				);
			}
			case "denied": {
				return (
					<text fg={theme.colors.mutedForeground} flexShrink={0}>
						{unicode ? "✗" : "[-]"}
					</text>
				);
			}
			default: {
				break;
			}
		}
	};

	// Live and settled durations share the reasoning row's `· 1.2s` suffix, so
	// a long call never reads as `(45230ms)` beside the busy row's seconds.
	let durationText: string | null = null;
	if (duration !== undefined) {
		durationText = `· ${formatToolDuration(duration)}`;
	} else if (status === "running") {
		durationText = `· ${formatToolDuration(elapsed)}`;
	}
	const inFlight = status === "pending" || status === "running";
	const label = inFlight && pendingLabel ? pendingLabel : name;
	const caret = unicode ? (collapsed ? "▶" : "▼") : collapsed ? ">" : "v";

	let nameColor: string;
	if (awaitingPermission) {
		nameColor = theme.colors.warning ?? "yellow";
	} else if (status === "error") {
		nameColor = theme.colors.error ?? "red";
	} else if (status === "success") {
		nameColor = theme.colors.success ?? "green";
	} else if (status === "running") {
		nameColor = theme.colors.primary;
	} else {
		nameColor = theme.colors.mutedForeground;
	}
	// Interrupted and denied rows are static: no spinner, no live timer, and a
	// short muted suffix says why the call never finished.
	let outcomeLabel: string | null = null;
	if (awaitingPermission) {
		outcomeLabel = "awaiting permission";
	} else if (status === "interrupted") {
		outcomeLabel = "interrupted";
	} else if (status === "denied") {
		outcomeLabel = "denied";
	}
	let nameNode = label;
	if (status === "denied") {
		nameNode = (
			<span attributes={TextAttributes.BOLD | TextAttributes.STRIKETHROUGH}>
				{label}
			</span>
		);
	} else if (status !== "pending") {
		nameNode = <b>{label}</b>;
	}

	return (
		<box flexDirection="column">
			{collapsible ? (
				<ToolCallKeys toggle={() => setCollapsed((value) => !value)} />
			) : null}
			<box flexDirection="row" gap={1}>
				{statusIcon()}
				<text fg={nameColor} flexShrink={0} wrapMode="none">
					{nameNode}
				</text>
				{summary ? (
					<text
						fg={theme.colors.mutedForeground}
						flexShrink={1}
						truncate
						wrapMode="none"
					>
						{summary}
					</text>
				) : null}
				{diffStat ? (
					<text flexShrink={0} wrapMode="none">
						<span fg={theme.colors.success ?? "green"}>
							{`+${diffStat.added}`}
						</span>{" "}
						<span fg={theme.colors.error ?? "red"}>
							{`-${diffStat.removed}`}
						</span>
					</text>
				) : null}
				{outcomeLabel ? (
					<text
						fg={theme.colors.mutedForeground}
						flexShrink={0}
						wrapMode="none"
					>
						{outcomeLabel}
					</text>
				) : null}
				{durationText && (
					<text
						fg={theme.colors.mutedForeground}
						flexShrink={0}
						wrapMode="none"
					>
						{durationText}
					</text>
				)}
				{collapsible && (
					<text fg={theme.colors.mutedForeground} flexShrink={0}>
						{caret}
					</text>
				)}
			</box>

			{!collapsed && (
				<box flexDirection="column" paddingLeft={2}>
					{diffLines ? <Diff lines={diffLines} /> : null}
					{args && Object.keys(args).length > 0 && (
						<box flexDirection="column">
							<text fg="#666">Args:</text>
							{...Object.entries(args).map(([k, v]) => (
								<box key={k} gap={1}>
									<text fg={theme.colors.accent}>{`${k}:`}</text>
									<text fg="#666">{JSON.stringify(v)}</text>
								</box>
							))}
						</box>
					)}
					{result !== undefined && (
						<box flexDirection="column">
							<text fg="#666">Result:</text>
							<text fg="#666">
								{textResult.success
									? textResult.data
									: JSON.stringify(result, null, 2)}
							</text>
						</box>
					)}
				</box>
			)}
		</box>
	);
};

function ToolCallKeys({ toggle }: { toggle: () => void }) {
	const focused = useInputFocused();
	return focused ? null : <ActiveToolCallKeys toggle={toggle} />;
}

function ActiveToolCallKeys({ toggle }: { toggle: () => void }) {
	useKeyboard((key) => {
		if (key.name === "return" || key.name === " ") toggle();
	});
	return null;
}
