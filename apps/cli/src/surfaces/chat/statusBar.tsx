/* @jsxImportSource @opentui/react */

import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge.tsx";
import { StatusMessage } from "@/components/ui/status-message.tsx";
import { useTheme } from "@/components/ui/theme-provider.tsx";
import { toolActivityLabel } from "../../core/transcriptPresentation.ts";
import type { Overlay } from "./types.ts";

// WorkspaceBar - the desktop project-folder + model row that sits above the
// composer. The TUI has no folder picker yet, so it surfaces the routing target
// and model as read-only chips. Console and OS can change routing with /group
// or Ctrl+A; Bot always shows its pinned Ryu target.
export function WorkspaceBar({
	agent,
	team,
	meter,
	model,
	showModel,
}: {
	agent: string | null;
	/** Session usage, e.g. "12.3K (8%) · $0.42"; empty hides the chip. */
	meter: string;
	model: string | null;
	showModel: boolean;
	team: string | null;
}) {
	const theme = useTheme();
	const routeLabel = routeChip(agent, team);
	return (
		// One row at any pane width: labels and the short usage meter keep
		// their size; long route and model names truncate instead of wrapping.
		<box flexDirection="row" flexShrink={0} gap={2} paddingLeft={1}>
			<box flexDirection="row" flexShrink={1} gap={1} overflow="hidden">
				<text fg={theme.colors.mutedForeground} flexShrink={0}>
					route
				</text>
				<text
					fg={theme.colors.foreground}
					flexShrink={1}
					truncate
					wrapMode="none"
				>
					{routeLabel}
				</text>
			</box>
			{showModel ? (
				<box flexDirection="row" flexShrink={1} gap={1} overflow="hidden">
					<text fg={theme.colors.mutedForeground} flexShrink={0}>
						model
					</text>
					<text
						fg={theme.colors.foreground}
						flexShrink={1}
						truncate
						wrapMode="none"
					>
						{model ?? "default"}
					</text>
				</box>
			) : null}
			{meter ? (
				<box flexDirection="row" flexShrink={0} gap={1}>
					<text fg={theme.colors.mutedForeground}>usage</text>
					<text fg={theme.colors.mutedForeground} wrapMode="none">
						{meter}
					</text>
				</box>
			) : null}
		</box>
	);
}

/** Whole seconds since `startedAt`, ticking once a second while it is set. */
function useElapsedSeconds(startedAt: number | null): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (startedAt === null) {
			return;
		}
		setNow(Date.now());
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, [startedAt]);
	return startedAt === null
		? 0
		: Math.max(0, Math.floor((now - startedAt) / 1000));
}

/**
 * What the busy row says the turn is doing. A permission or question overlay
 * means the turn is blocked on the user, not still running its tool.
 */
export function busyActivityLabel(
	overlayKind: Overlay["kind"],
	activeTool: string | null
): string {
	if (overlayKind === "permission") {
		return "Waiting for permission…";
	}
	if (overlayKind === "question") {
		return "Waiting for your answer…";
	}
	return activeTool ? toolActivityLabel(activeTool) : "Thinking…";
}

// The busy row sits above the composer at a fixed one-row height. Route and
// model live in WorkspaceBar; only the double-check toggle is shown here.
// The elapsed ticker re-renders this row alone, never the transcript. The
// `Esc interrupt` hint shows only while the composer owns Esc (no overlay,
// queue focus, or unfocused pane).
export function StatusLine({
	activity,
	doubleCheckOn,
	interruptible,
	startedAt,
}: {
	activity: string;
	doubleCheckOn: boolean;
	interruptible: boolean;
	startedAt: number | null;
}) {
	const theme = useTheme();
	const elapsed = useElapsedSeconds(startedAt);
	const busy = startedAt !== null;
	if (!(busy || doubleCheckOn)) {
		return null;
	}
	return (
		<box flexDirection="row" flexShrink={0} gap={1} height={1} paddingLeft={1}>
			{busy ? (
				<>
					<StatusMessage variant="loading">{`${activity} ${elapsed}s`}</StatusMessage>
					{interruptible ? (
						<text fg={theme.colors.mutedForeground}>· Esc interrupt</text>
					) : null}
				</>
			) : null}
			{doubleCheckOn ? (
				<Badge bordered={false} variant="secondary">
					double-check
				</Badge>
			) : null}
		</box>
	);
}

function routeChip(agent: string | null, team: string | null): string {
	if (team) {
		return `team:${team}`;
	}
	if (agent) {
		return `agent:${agent}`;
	}
	return "auto";
}
