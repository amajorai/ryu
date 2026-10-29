/* @jsxImportSource @opentui/react */
// Home surface (path /home) - the landing/overview screen, mirroring the desktop
// HomePage's dashboard intent but kept light for the terminal: a live system-status
// card (one GET /api/system/status) and a keyboard-navigable list of quick actions
// that open the primary surfaces. When Core does not answer, the status card becomes
// the guided ConnectionCard (s start Core · ^N switch node · r retry, plus the
// shared poller's auto-retry countdown), and Home reloads itself once Core is up.
// Beyond that it is a pure navigator: j/k selection + Enter to open.

import { useKeyboard } from "@opentui/react";
import { fetchSystemStatus } from "@ryuhq/core-client/system";
import { useCallback, useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge.tsx";
import { Card } from "@/components/ui/card.tsx";
import { useTheme } from "@/components/ui/theme-provider.tsx";
import { useCore } from "../../core/CoreContext.tsx";
import { useCoreHealth } from "../../core/CoreHealthContext.tsx";
import { useShellKeyboardCaptured } from "../../core/InputFocusContext.tsx";
import { tf } from "../../i18n/translate.ts";
import { useOverlay } from "../../overlays/OverlayHost.tsx";
import { CoreConnectionCard } from "../../ui/ConnectionCard.tsx";
import type { SurfaceModule, SurfaceProps } from "../../workspace/router.ts";
import { useWorkspace } from "../../workspace/WorkspaceContext.tsx";

interface StatusLine {
	key: string;
	label: string;
	ok: boolean;
}

interface QuickAction {
	hint: string;
	id: string;
	label: string;
	path: string;
}

const QUICK_ACTIONS: QuickAction[] = [
	{ id: "chat", label: "New chat", hint: "Talk to an agent", path: "/chat" },
	{
		id: "library",
		label: "Library",
		hint: "Browse recipes & saved work",
		path: "/library",
	},
	{ id: "tasks", label: "Tasks", hint: "Scheduled jobs", path: "/tasks" },
	{
		id: "calendar",
		label: "Calendar",
		hint: "Upcoming schedules",
		path: "/calendar",
	},
	{
		id: "timeline",
		label: "Timeline",
		hint: "Activity history",
		path: "/timeline",
	},
	{
		id: "monitors",
		label: "Monitors",
		hint: "Watchers & alerts",
		path: "/monitors",
	},
];

function HomeSurface({ active, paneId }: SurfaceProps) {
	const { target } = useCore();
	const health = useCoreHealth();
	const theme = useTheme();
	const { focusedPaneId, openTab } = useWorkspace();
	const shellKeyboardCaptured = useShellKeyboardCaptured();
	const { openId: overlayOpenId } = useOverlay();
	const focused = active && focusedPaneId === paneId;

	const [status, setStatus] = useState<StatusLine[] | null>(null);
	const [engine, setEngine] = useState<string | null>(null);
	const [reachable, setReachable] = useState<boolean | null>(null);
	const [index, setIndex] = useState(0);

	// Track the latest request so a stale resolve cannot clobber fresh data.
	const reqRef = useRef(0);
	const recheckHealth = health?.recheck;
	const healthState = health?.url === target.url ? health.state : "unknown";
	// The guided card replaces the status card only while Core itself is not
	// answering; a status failure on a healthy Core keeps the plain error.
	const coreDown = reachable === false && healthState !== "up";

	const runLoad = useCallback(() => {
		const reqId = ++reqRef.current;
		fetchSystemStatus(target)
			.then((snap) => {
				if (reqRef.current !== reqId) {
					return;
				}
				const sidecars = Object.entries(snap.sidecars).map(
					([name, running]): StatusLine => ({
						key: name,
						label: name,
						ok: running,
					})
				);
				setStatus([
					{ key: "engine", label: "Engine", ok: snap.engineRunning },
					{ key: "gateway", label: "Gateway", ok: snap.gatewayReachable },
					...sidecars,
				]);
				setEngine(snap.activeEngine);
				setReachable(true);
			})
			.catch(() => {
				if (reqRef.current !== reqId) {
					return;
				}
				setStatus(null);
				setEngine(null);
				setReachable(false);
				// Let the shared poller confirm (and keep retrying) the outage.
				recheckHealth?.();
			});
	}, [target, recheckHealth]);

	// Lazy load on activation, and reload on node switch (url/token).
	useEffect(() => {
		if (active) {
			runLoad();
		}
	}, [active, runLoad]);

	// Core came back (auto-retry or s start Core): refresh the status card.
	const reloadOnRecovery = reachable === false && healthState === "up";
	useEffect(() => {
		if (active && reloadOnRecovery) {
			runLoad();
		}
	}, [active, reloadOnRecovery, runLoad]);

	useKeyboard((key) => {
		if (!focused || shellKeyboardCaptured || overlayOpenId) {
			return;
		}
		if (key.name === "up" || key.name === "k") {
			setIndex((i) => Math.max(0, i - 1));
		} else if (key.name === "down" || key.name === "j") {
			setIndex((i) => Math.min(QUICK_ACTIONS.length - 1, i + 1));
		} else if (key.name === "r") {
			runLoad();
		} else if (key.name === "s" && coreDown && health?.canStart) {
			health.startCore();
		} else if (key.name === "return") {
			const chosen = QUICK_ACTIONS[index];
			if (chosen) {
				openTab(chosen.path);
			}
		}
	});

	return (
		<box
			flexDirection="column"
			flexGrow={1}
			overflow="hidden"
			paddingLeft={1}
			paddingTop={1}
		>
			<box flexDirection="column" flexShrink={0} paddingBottom={1}>
				<text fg={theme.colors.primary}>
					<b>Ryu</b>
				</text>
				<text fg={theme.colors.mutedForeground}>
					Your local overview - ↑↓ move · Enter open · r refresh
				</text>
			</box>
			<StatusCard
				coreDown={coreDown}
				engine={engine}
				reachable={reachable}
				status={status}
			/>
			<ActionList index={index} />
		</box>
	);
}

function StatusCard({
	coreDown,
	status,
	engine,
	reachable,
}: {
	coreDown: boolean;
	engine: string | null;
	reachable: boolean | null;
	status: StatusLine[] | null;
}) {
	const theme = useTheme();
	if (coreDown) {
		return (
			// The right gutter matches Chat's card so the border never touches
			// the terminal edge.
			<box flexShrink={0} paddingBottom={1} paddingRight={1}>
				<CoreConnectionCard keysActive />
			</box>
		);
	}
	if (reachable === false) {
		return (
			<box paddingBottom={1}>
				<Card title="System">
					<text fg={theme.colors.error}>
						Couldn't load system status · r refresh
					</text>
				</Card>
			</box>
		);
	}
	if (status === null) {
		return (
			<box paddingBottom={1}>
				<Card title="System">
					<text fg={theme.colors.mutedForeground}>Checking status…</text>
				</Card>
			</box>
		);
	}
	return (
		<box paddingBottom={1}>
			<Card
				subtitle={engine ? tf("engine: {engine}", { engine }) : undefined}
				title="System"
			>
				<box flexDirection="row" gap={1}>
					{status.map((line) => (
						<Badge
							bordered={false}
							key={line.key}
							variant={line.ok ? "success" : "secondary"}
						>
							{`${line.ok ? "●" : "○"} ${line.label}`}
						</Badge>
					))}
				</box>
			</Card>
		</box>
	);
}

function ActionList({ index }: { index: number }) {
	const theme = useTheme();
	return (
		<Card title="Quick actions">
			{QUICK_ACTIONS.map((action, i) => {
				const isSel = i === index;
				return (
					<box flexDirection="row" flexShrink={0} gap={1} key={action.id}>
						<text
							fg={isSel ? theme.colors.primary : theme.colors.mutedForeground}
						>
							{isSel ? "›" : " "}
						</text>
						<text fg={isSel ? theme.colors.primary : theme.colors.foreground}>
							{isSel ? <b>{action.label}</b> : action.label}
						</text>
						<text fg={theme.colors.mutedForeground}>{action.hint}</text>
					</box>
				);
			})}
		</Card>
	);
}

/** The Home surface module (path /home). Registered by the Integrate step. */
export const homeSurface: SurfaceModule = {
	id: "home",
	title: "Home",
	match: (path) => path === "/home" || path.startsWith("/home/"),
	Component: HomeSurface,
};
