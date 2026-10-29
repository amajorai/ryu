/* @jsxImportSource @opentui/react */
// Services tab - parity with apps/cli's Services tab (apps/cli/src/{ui.rs
// render_services_content, app.rs SIDECAR_ORDER + SidecarInfo/InstallState,
// main.rs SidebarTab::Services key handling + do_*_sidecar actions, api.rs
// /api/sidecar/* + /api/setup/* endpoints).
//
// What it shows: a FIXED, ordered list of the 16 known sidecars (providers,
// tools, agents). Each row reports its category, whether it is installed, and a
// live runtime status (running / stopped / downloading / install failed) merged
// from three Core probes:
//   - GET  /api/sidecar/status  -> { sidecars: [{ name, running }] }  (running)
//   - GET  /api/setup/list      -> { installed: string[] }            (installed)
//   - GET  /api/setup/status    -> { states: { name: { state } } }    (failed/installing)
//
// Actions (selected row), mirroring the Rust keymap:
//   s  start          POST /api/sidecar/{name}/start    (only when installed)
//   x  stop           POST /api/sidecar/{name}/stop
//   r  restart        POST /api/sidecar/{name}/restart  (only when installed)
//   A  start all      POST /api/sidecar/start-all
//   Z  stop all       POST /api/sidecar/stop-all
//   d  install        POST /api/setup/{name}/install    (only when not installed)
//   D  uninstall      POST /api/setup/{name}/uninstall  (only when installed)
//   j/k + arrows      move selection
// A, Z and D are bulk or destructive, so each opens an inline ConfirmPrompt
// (Cancel by default; y confirms, n/Esc cancels) and posts only once confirmed.
// The prompt takes the status bar's place while open, so it fits short panes.
// 'q' (quit) is owned by the shell. 'i' (dependency setup wizard) is a separate
// full-screen flow in apps/cli (Screen::SetupDependencies) and is not ported.
//
// None of these endpoints have typed core-client wrappers except the running
// probe (system.fetchSidecarStatus), so the rest go through the root HTTP
// primitives (request) with the active ApiTarget. Keyboard is OWNED here and
// gated on `active`; termcn (Badge, Spinner) handles presentation only.

import type { KeyEvent } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { appResponseValueSchema } from "@ryuhq/core-client/app-request-json";
import { type ApiTarget, request } from "@ryuhq/core-client/client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { useTheme } from "@/components/ui/theme-provider.tsx";
import { useCore } from "../core/CoreContext.tsx";
import { useInputFocused } from "../core/InputFocusContext.tsx";
import { HINT, type KeyHint } from "../core/keymap.ts";
import { humanizeError, nativeErrorMessage } from "../core/native-errors.ts";
import {
	loadServices,
	type ServicesSnapshot,
} from "../core/services-snapshot.ts";
import { ConfirmPrompt } from "../ui/ConfirmPrompt.tsx";
import { ErrorView } from "../ui/ErrorView.tsx";
import { Loading } from "../ui/Loading.tsx";
import {
	OVERLAY_STATUS_SCOPE,
	useStatusContribution,
} from "../ui/StatusContext.tsx";
import { useToast } from "../ui/toast.tsx";
import type { TabProps } from "./types.ts";

// The fixed sidecar order, verbatim from apps/cli/src/app.rs SIDECAR_ORDER.
const SIDECAR_ORDER = [
	"temporal",
	"spider",
	"screenpipe",
	"llmfit",
	"qmd",
	"shadow",
	"ghost",
	"llamacpp",
	"ollama",
	"vllm",
	"zeroclaw",
	"openclaw",
	"nanoclaw",
	"picoclaw",
	"nemoclaw",
	"ironclaw",
] as const;

type Category = "provider" | "tool" | "agent";

// Name -> category, matching the inline switch in ui.rs render_services_content
// (note: shadow/ghost render as "agent" there even though app.rs tags them Tool;
// we follow the UI's name-based mapping for visual parity).
const PROVIDERS = new Set(["llamacpp", "ollama", "vllm"]);
const TOOLS = new Set(["temporal", "spider", "screenpipe", "llmfit", "qmd"]);

function categoryOf(name: string): Category {
	if (PROVIDERS.has(name)) {
		return "provider";
	}
	if (TOOLS.has(name)) {
		return "tool";
	}
	return "agent";
}

const POLL_MS = 2500;
const NAME_WIDTH = 12;
const CATEGORY_WIDTH = 8;
const LIST_HEIGHT = 16;

async function postAction(target: ApiTarget, path: string): Promise<boolean> {
	try {
		await request(target, path, { method: "POST" }, appResponseValueSchema);
		return true;
	} catch {
		return false;
	}
}

interface RowStatus {
	color: string;
	downloading: boolean;
	icon: string;
	text: string;
}

export function ServicesTab({ active }: TabProps) {
	const { target } = useCore();
	const theme = useTheme();
	const { notify } = useToast();
	const inputFocused = useInputFocused();

	const [snapshot, setSnapshot] = useState<ServicesSnapshot | null>(null);
	const [index, setIndex] = useState(0);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	// Names the user queued for install this session (parity with app.install_results):
	// drives the "downloading" row state until the install completes.
	const [queued, setQueued] = useState<Set<string>>(() => new Set());

	// Track the latest load so a stale resolve cannot clobber fresh data.
	const reqRef = useRef(0);
	const scopeRef = useRef({ active, target });
	scopeRef.current = { active, target };
	const inFlightRef = useRef<AbortController | null>(null);
	const loadScopeActiveRef = useRef(false);

	const runLoad = useCallback(
		(showSpinner: boolean, supersede = true) => {
			if (
				!(loadScopeActiveRef.current && scopeRef.current.active) ||
				scopeRef.current.target !== target
			) {
				return;
			}
			if (inFlightRef.current && !supersede) {
				return;
			}
			inFlightRef.current?.abort();
			const controller = new AbortController();
			inFlightRef.current = controller;
			const reqId = ++reqRef.current;
			if (showSpinner) {
				setLoading(true);
			}
			loadServices(target, controller.signal)
				.then((next) => {
					if (controller.signal.aborted || reqRef.current !== reqId) {
						return;
					}
					setSnapshot(next);
					setError(null);
					// Clear any queued-install flags that have since become installed.
					setQueued((prev) => {
						if (prev.size === 0) {
							return prev;
						}
						const remaining = new Set<string>();
						for (const name of prev) {
							if (!next.installed.has(name)) {
								remaining.add(name);
							}
						}
						return remaining.size === prev.size ? prev : remaining;
					});
				})
				.catch((err) => {
					if (controller.signal.aborted || reqRef.current !== reqId) {
						return;
					}
					setError(nativeErrorMessage(err));
				})
				.finally(() => {
					if (inFlightRef.current === controller) {
						inFlightRef.current = null;
					}
					if (reqRef.current === reqId) {
						setLoading(false);
					}
				});
		},
		[target]
	);

	// Activation owns the polling request. Timer ticks skip a busy read;
	// user actions supersede it so their refresh cannot publish pre-action data.
	useEffect(() => {
		if (!active) {
			return;
		}
		loadScopeActiveRef.current = true;
		runLoad(true);
		const handle = setInterval(() => runLoad(false, false), POLL_MS);
		return () => {
			loadScopeActiveRef.current = false;
			clearInterval(handle);
			reqRef.current++;
			inFlightRef.current?.abort();
			inFlightRef.current = null;
		};
	}, [active, runLoad]);

	const isInstalled = useCallback(
		(name: string) => snapshot?.installed.has(name) ?? false,
		[snapshot]
	);

	// Run an action against the selected row, then refresh. `guard` lets callers
	// skip no-op actions (start/restart on a not-installed sidecar) like the Rust
	// do_* helpers do.
	const act = useCallback(
		async (
			path: string,
			label: string,
			guard: (name: string) => boolean = () => true
		) => {
			const name = SIDECAR_ORDER[index];
			if (!(name && guard(name))) {
				return;
			}
			// {name}-bearing paths are per-sidecar; the all-actions ignore the row.
			const perRow = path.includes("{name}");
			const ok = await postAction(target, path.replace("{name}", name));
			const subject = perRow ? ` ${name}` : "";
			notify(
				ok ? `${label}${subject}` : `${label} failed${subject}`,
				ok ? "info" : "error"
			);
			runLoad(false);
		},
		[index, target, notify, runLoad]
	);

	const installSelected = useCallback(() => {
		const name = SIDECAR_ORDER[index];
		const downloading = !!name && queued.has(name);
		if (!name || isInstalled(name) || downloading) {
			return;
		}
		postAction(target, `/api/setup/${name}/install`)
			.then((ok) => {
				if (ok) {
					setQueued((prev) => new Set(prev).add(name));
					notify(`Queued install: ${name}`, "info");
				} else {
					notify(`Install failed: ${name}`, "error");
				}
				runLoad(false);
			})
			.catch((err) =>
				notify(`Install failed: ${name} - ${nativeErrorMessage(err)}`, "error")
			);
	}, [index, queued, isInstalled, target, notify, runLoad]);

	// A bulk or destructive action waiting on the inline ConfirmPrompt. While it is
	// set, the tab's own keys are ignored so y/n/r reach only the prompt.
	const [confirm, setConfirm] = useState<PendingConfirm | null>(null);

	// Letter actions, mirroring the Rust Services keymap. Kept separate from the
	// nav/modifier decode in handleKey so neither function grows too complex.
	const handleLetter = useCallback(
		(lower: string, shifted: boolean) => {
			const installedGuard = (n: string) => isInstalled(n);
			if (lower === "a" && shifted) {
				setConfirm({
					title: "Start all services?",
					consequence: "Starts every installed sidecar on this node.",
					confirmLabel: "Start all",
					run: () => act("/api/sidecar/start-all", "Started all"),
				});
				return;
			}
			if (lower === "z" && shifted) {
				setConfirm({
					title: "Stop all services?",
					consequence:
						"Stops every running sidecar; features that depend on them stop working.",
					confirmLabel: "Stop all",
					run: () => act("/api/sidecar/stop-all", "Stopped all"),
				});
				return;
			}
			if (lower === "d") {
				if (shifted) {
					const name = SIDECAR_ORDER[index];
					if (name && isInstalled(name)) {
						setConfirm({
							title: `Uninstall ${name}?`,
							consequence: `${name} will be stopped and removed from this node; press d to reinstall it.`,
							confirmLabel: "Uninstall",
							run: () =>
								act(
									"/api/setup/{name}/uninstall",
									"Uninstalled",
									installedGuard
								),
						});
					}
				} else {
					installSelected();
				}
				return;
			}
			if (lower === "s") {
				act("/api/sidecar/{name}/start", "Started", installedGuard);
			} else if (lower === "x") {
				act("/api/sidecar/{name}/stop", "Stopped");
			} else if (lower === "r") {
				act("/api/sidecar/{name}/restart", "Restarted", installedGuard);
			} else if (lower === "i") {
				notify("Dependency setup is not available in the TUI", "warning");
			}
		},
		[act, index, installSelected, isInstalled, notify]
	);

	const handleKey = useCallback(
		(key: KeyEvent) => {
			if (key.name === "up" || key.name === "k") {
				setIndex((i) => Math.max(0, i - 1));
				return;
			}
			if (key.name === "down" || key.name === "j") {
				setIndex((i) => Math.min(SIDECAR_ORDER.length - 1, i + 1));
				return;
			}
			const lower = key.name.toLowerCase();
			const shifted =
				key.shift || (key.name.length === 1 && key.name !== lower);
			handleLetter(lower, shifted);
		},
		[handleLetter]
	);

	useKeyboard((key) => {
		if (!active || inputFocused || confirm) {
			return;
		}
		handleKey(key);
	});

	useStatusContribution(active ? OVERLAY_STATUS_SCOPE : undefined, {
		// An open confirm prompt shows its own keys in place of the tab's.
		hints: snapshot && !snapshot.offline && !confirm ? SERVICES_HINTS : [],
		left: loading ? "refreshing…" : undefined,
	});

	if (loading && !snapshot) {
		return <Loading label="Loading services…" />;
	}
	if (error && !snapshot) {
		return (
			<ErrorView
				hint="Retrying automatically…"
				message={humanizeError(error, { url: target.url })}
			/>
		);
	}
	if (snapshot?.offline) {
		return (
			<box flexDirection="column" flexGrow={1} paddingLeft={1} paddingTop={1}>
				<text fg={theme.colors.foreground}>
					<b>Services</b>
				</text>
				<box flexGrow={1} justifyContent="center" paddingTop={1}>
					<text fg={theme.colors.mutedForeground}>
						core not running - start with{" "}
						<span fg={theme.colors.accent}>ryu-core</span>
					</text>
				</box>
			</box>
		);
	}

	const start = Math.max(
		0,
		Math.min(
			index - Math.floor(LIST_HEIGHT / 2),
			Math.max(0, SIDECAR_ORDER.length - LIST_HEIGHT)
		)
	);
	const visible = SIDECAR_ORDER.slice(start, start + LIST_HEIGHT);

	return (
		<box flexDirection="column" flexGrow={1}>
			<box flexDirection="column" flexGrow={1} paddingLeft={1} paddingTop={1}>
				<text fg={theme.colors.foreground}>
					<b>Services</b>
				</text>
				<box flexDirection="column" paddingTop={1}>
					{visible.map((name, i) => {
						const absolute = start + i;
						const isSel = absolute === index;
						const installed = snapshot?.installed.has(name) ?? false;
						const running = snapshot?.running.has(name) ?? false;
						const state = snapshot?.installStates[name];
						const downloading =
							!installed && (queued.has(name) || state === "installing");
						const installFailed = state === "failed";
						const status = rowStatus(theme, {
							installed,
							running,
							downloading,
							installFailed,
						});
						return (
							<box flexDirection="row" gap={1} key={name}>
								<text
									fg={
										isSel ? theme.colors.primary : theme.colors.mutedForeground
									}
								>
									{isSel ? "›" : " "}
								</text>
								<text
									fg={isSel ? theme.colors.primary : theme.colors.foreground}
								>
									{isSel ? (
										<b>{name.padEnd(NAME_WIDTH)}</b>
									) : (
										name.padEnd(NAME_WIDTH)
									)}
								</text>
								<Badge bordered={false} variant="secondary">
									{categoryOf(name).padEnd(CATEGORY_WIDTH)}
								</Badge>
								<text
									fg={
										installed
											? theme.colors.success
											: theme.colors.mutedForeground
									}
								>
									{installed ? "[✓]" : "   "}
								</text>
								<StatusCell status={status} />
							</box>
						);
					})}
				</box>
			</box>
			{confirm ? (
				<box flexShrink={0} paddingLeft={1}>
					<ConfirmPrompt
						active={active && !inputFocused}
						confirmLabel={confirm.confirmLabel}
						consequence={confirm.consequence}
						onCancel={() => setConfirm(null)}
						onConfirm={() => {
							setConfirm(null);
							confirm.run();
						}}
						title={confirm.title}
					/>
				</box>
			) : null}
		</box>
	);
}

// Published to the shell's status bar (Services renders inside the Settings
// overlay, which owns the keyboard while open). Lower priority survives narrow bars.
const SERVICES_HINTS: KeyHint[] = [
	{ ...HINT.move, priority: 0 },
	{ keys: "d", label: "install", priority: 1 },
	{ keys: "s", label: "start", priority: 1 },
	{ keys: "x", label: "stop", priority: 1 },
	{ keys: "r", label: "restart", priority: 2 },
	{ keys: "A", label: "all start", priority: 3 },
	{ keys: "Z", label: "all stop", priority: 3 },
	{ keys: "D", label: "uninstall", priority: 2 },
];

function StatusCell({ status }: { status: RowStatus }) {
	if (status.downloading) {
		return <Spinner color={status.color} label={status.text} type="dots" />;
	}
	return (
		<box flexDirection="row" gap={1}>
			<text fg={status.color}>{status.icon}</text>
			<text fg={status.color}>{status.text}</text>
		</box>
	);
}

// A bulk or destructive action held until the user answers the ConfirmPrompt.
interface PendingConfirm {
	confirmLabel: string;
	consequence: string;
	run: () => void;
	title: string;
}

interface ThemeLike {
	colors: {
		error: string;
		mutedForeground: string;
		primary: string;
		success: string;
		warning: string;
	};
}

interface RowFlags {
	downloading: boolean;
	installed: boolean;
	installFailed: boolean;
	running: boolean;
}

// Status icon/text/color, matching the precedence in ui.rs render_services_content.
function rowStatus(theme: ThemeLike, flags: RowFlags): RowStatus {
	if (flags.installFailed) {
		return {
			icon: "✗",
			text: "install failed",
			color: theme.colors.error,
			downloading: false,
		};
	}
	if (flags.downloading) {
		return {
			icon: "",
			text: "downloading",
			color: theme.colors.primary,
			downloading: true,
		};
	}
	if (!flags.installed) {
		return {
			icon: " ",
			text: "—",
			color: theme.colors.mutedForeground,
			downloading: false,
		};
	}
	if (flags.running) {
		return {
			icon: "●",
			text: "running",
			color: theme.colors.success,
			downloading: false,
		};
	}
	return {
		icon: "○",
		text: "stopped",
		color: theme.colors.warning,
		downloading: false,
	};
}
