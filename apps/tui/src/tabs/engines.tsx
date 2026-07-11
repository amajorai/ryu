/* @jsxImportSource @opentui/react */
// Engines tab - parity with apps/cli's Engines tab
// (apps/cli/src/{app.rs,api.rs,ui.rs,main.rs}):
//   - data: GET /api/engines (list) merged with GET /api/engine/active (active
//     marker + running flag + installed-available names)
//   - header: " Engines  active: ● <name>" with a green ● when the active engine
//     is running, a yellow ○ when it is selected but not running; falls back to a
//     nav hint when no engine is active
//   - per-row status icon (● active+running / ○ active / blank installed / - not
//     installed), name, installed label, [active] marker, truncated description
//   - keys: ↑/k ↓/j navigate, Enter activate (POST /api/engine/active with the
//     engine NAME, then refresh), r refresh
//   - states: loading, empty, and error. apps/cli renders a distinct
//     "core not running" string when the fetch fails with no data; here a fetch
//     failure folds into the shared ErrorView (consistent with ListTab), so that
//     specific string is intentionally not reproduced.
//
// No engine name is hardcoded - every value comes from Core. Keyboard is owned
// here and gated on `active` (and suppressed while a text input elsewhere owns the
// keyboard). termcn Card/Badge/StatusMessage handle presentation.

import { useKeyboard } from "@opentui/react";
import {
	type ActiveEngine,
	type Engine,
	fetchActiveEngine,
	fetchEngines,
	setActiveEngine,
} from "@ryuhq/core-client/engines";
import { useCallback, useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge.tsx";
import { Card } from "@/components/ui/card.tsx";
import { useTheme } from "@/components/ui/theme-provider.tsx";
import { useCore } from "../core/CoreContext.tsx";
import { useInputFocused } from "../core/InputFocusContext.tsx";
import { ErrorView } from "../ui/ErrorView.tsx";
import { Loading } from "../ui/Loading.tsx";
import { useToast } from "../ui/toast.tsx";
import type { TabProps } from "./types.ts";

const NAME_WIDTH = 18;
const DESC_MAX = 30;
const DESC_HEAD = 29;

// Is this engine the currently active one? Core's active marker can be the
// engine's id or its display name (parity with refresh_engines in main.rs).
function isActiveEngine(engine: Engine, active: ActiveEngine): boolean {
	const name = active.active;
	if (!name) {
		return false;
	}
	return engine.name === name || engine.id === name;
}

function truncateDescription(desc: string): string {
	return desc.length > DESC_MAX ? `${desc.slice(0, DESC_HEAD)}…` : desc;
}

function errText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

const emptyActive: ActiveEngine = {
	active: null,
	running: false,
	available: [],
};

export function EnginesTab({ active }: TabProps) {
	const { target } = useCore();
	const theme = useTheme();
	const { notify } = useToast();
	const inputFocused = useInputFocused();

	const [engines, setEngines] = useState<Engine[]>([]);
	const [activeEngine, setActive] = useState<ActiveEngine>(emptyActive);
	const [index, setIndex] = useState(0);
	const [loading, setLoading] = useState(false);
	const [loaded, setLoaded] = useState(false);
	const [error, setError] = useState<string | null>(null);

	// Guard against a stale in-flight load clobbering fresher data after a node
	// switch or rapid refreshes.
	const reqRef = useRef(0);

	const runLoad = useCallback(() => {
		const reqId = ++reqRef.current;
		setLoading(true);
		setError(null);
		Promise.all([fetchEngines(target), fetchActiveEngine(target)])
			.then(([list, act]) => {
				if (reqRef.current !== reqId) {
					return;
				}
				setEngines(list);
				setActive(act);
				setIndex((i) => (list.length === 0 ? 0 : Math.min(i, list.length - 1)));
				setLoaded(true);
			})
			.catch((err: unknown) => {
				if (reqRef.current !== reqId) {
					return;
				}
				setError(errText(err));
				setLoaded(true);
			})
			.finally(() => {
				if (reqRef.current === reqId) {
					setLoading(false);
				}
			});
	}, [target]);

	// Lazy first load on activation. `runLoad` is stable (it closes over the
	// memoized target, which changes identity only on a node switch), so it can sit
	// in deps and re-load on a node switch without a fresh-object infinite loop. 'r'
	// and post-activate refreshes call runLoad() directly.
	useEffect(() => {
		if (active) {
			runLoad();
		}
	}, [active, runLoad]);

	const activateSelected = useCallback(() => {
		const engine = engines[index];
		if (!engine) {
			return;
		}
		// Core persists the choice; parity with apps/cli we post the engine NAME.
		setActiveEngine(target, engine.name)
			.then((swap) => {
				notify(
					swap.unchanged
						? `${engine.name} already active`
						: `Activated ${engine.name}`,
					"success"
				);
				if (!swap.gatewayRefreshed) {
					notify("Gateway refresh failed - routing may be stale", "warning");
				}
				// Refresh so the active marker updates immediately.
				runLoad();
			})
			.catch((err: unknown) =>
				notify(`activate failed: ${errText(err)}`, "error")
			);
	}, [engines, index, target, notify, runLoad]);

	useKeyboard((key) => {
		if (!active || inputFocused) {
			return;
		}
		if (key.name === "up" || key.name === "k") {
			setIndex((i) => Math.max(0, i - 1));
		} else if (key.name === "down" || key.name === "j") {
			setIndex((i) => Math.min(Math.max(0, engines.length - 1), i + 1));
		} else if (key.name === "return") {
			activateSelected();
		} else if (key.name === "r") {
			runLoad();
		}
	});

	if (loading && !loaded) {
		return <Loading label="Loading engines…" />;
	}
	if (error) {
		return <ErrorView message={error} />;
	}

	const activeName = activeEngine.active ?? "";
	const running = activeEngine.running;

	return (
		<box flexDirection="column" flexGrow={1} paddingLeft={1} paddingTop={1}>
			<EnginesHeader activeName={activeName} running={running} />
			{engines.length === 0 ? (
				<box paddingTop={1}>
					<text fg={theme.colors.mutedForeground}>
						No engines found - press r to refresh
					</text>
				</box>
			) : (
				<box paddingTop={1}>
					<Card subtitle="↑↓ nav · enter activate · r refresh" title="engines">
						{engines.map((engine, i) => (
							<EngineRow
								active={activeEngine}
								engine={engine}
								key={engine.id}
								selected={i === index}
							/>
						))}
					</Card>
				</box>
			)}
		</box>
	);
}

function EnginesHeader({
	activeName,
	running,
}: {
	activeName: string;
	running: boolean;
}) {
	const theme = useTheme();
	if (activeName.length === 0) {
		return (
			<box flexDirection="row" gap={1}>
				<text fg={theme.colors.foreground}>
					<b>Engines</b>
				</text>
				<text fg={theme.colors.mutedForeground}>
					↑↓ nav · enter activate · r refresh
				</text>
			</box>
		);
	}
	const dot = running ? "●" : "○";
	const dotColor = running ? theme.colors.success : theme.colors.warning;
	return (
		<box flexDirection="row" gap={1}>
			<text fg={theme.colors.foreground}>
				<b>Engines</b>
			</text>
			<text fg={theme.colors.mutedForeground}>active:</text>
			<text fg={dotColor}>{dot}</text>
			<text fg={theme.colors.accent}>
				<b>{activeName}</b>
			</text>
			<text fg={theme.colors.mutedForeground}>
				↑↓ nav · enter activate · r refresh
			</text>
		</box>
	);
}

function EngineRow({
	engine,
	active,
	selected,
}: {
	engine: Engine;
	active: ActiveEngine;
	selected: boolean;
}) {
	const theme = useTheme();
	const isActive = isActiveEngine(engine, active);
	const installed = engine.installed ?? false;
	const running = active.running;

	let statusIcon = " ";
	let statusColor = theme.colors.mutedForeground;
	if (isActive && running) {
		statusIcon = "●";
		statusColor = theme.colors.success;
	} else if (isActive) {
		statusIcon = "○";
		statusColor = theme.colors.warning;
	} else if (!installed) {
		statusIcon = "-";
	}

	return (
		<box flexDirection="row" gap={1}>
			<text fg={selected ? theme.colors.primary : theme.colors.muted}>
				{selected ? "›" : " "}
			</text>
			<text fg={statusColor}>{statusIcon}</text>
			<text fg={selected ? theme.colors.primary : theme.colors.foreground}>
				{selected ? (
					<b>{engine.name.padEnd(NAME_WIDTH)}</b>
				) : (
					engine.name.padEnd(NAME_WIDTH)
				)}
			</text>
			<text
				fg={installed ? theme.colors.success : theme.colors.mutedForeground}
			>
				{installed ? "installed" : "not installed"}
			</text>
			{isActive ? (
				<Badge bordered={false} variant="secondary">
					active
				</Badge>
			) : null}
			{engine.description ? (
				<text fg={theme.colors.mutedForeground}>
					{truncateDescription(engine.description)}
				</text>
			) : null}
		</box>
	);
}
