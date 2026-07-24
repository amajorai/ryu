// apps/desktop/src/pages/PreflightPage.tsx
//
// The preflight / boot-health page. Shown when Core failed to come up (degraded);
// auto-advances into the app the moment Core reports running. It checks the four
// components — Core · Gateway · Desktop · Island — plus Core's sidecars, and
// gives each a status dot, version, "update available" action, and (auto-start
// plus a manual) Start/Restart control. A footer copies a diagnostics bundle or
// reports the issue through the wired, privacy-gated crash/analytics sinks.
//
// It runs BEFORE the main app shell, so it owns its own polling (no
// SystemStatusProvider above it) and targets the active node directly, degrading
// every probe to "unknown" when Core is unreachable.

import { Button } from "@ryu/ui/components/button";
import { toast } from "@ryu/ui/components/sileo";
import { cn } from "@ryu/ui/lib/utils";
import { relaunch } from "@tauri-apps/plugin-process";
import { useCallback, useEffect, useRef, useState } from "react";
import {
	getRyuStatus,
	restartRyuCore,
	startRyuCore,
} from "@/lib/tauri-bridge.ts";
import {
	BouncyAccordion,
	type BouncyAccordionItem,
} from "@/src/components/ui/bouncy-accordion.tsx";
import { installUpdate } from "@/src/components/updater/AutoUpdater.tsx";
import { useEngines } from "@/src/hooks/useEngines.ts";
import { type ApiTarget, toTarget } from "@/src/lib/api/client.ts";
import {
	fetchHealth,
	fetchSystemStatus,
	restartGateway,
} from "@/src/lib/api/system.ts";
import { checkForUpdate, type UpdateCheck } from "@/src/lib/api/update.ts";
import { copyDiagnostics, reportIssue } from "@/src/lib/preflight.ts";
import { restartSidecar, startSidecar } from "@/src/lib/services-api.ts";
import { useAppStore } from "@/src/store/useAppStore.ts";
import { useNodeStore } from "@/src/store/useNodeStore.ts";

/** The Island Electron companion's loopback control server (see apps/island). */
const ISLAND_CONTROL_URL = "http://127.0.0.1:7989/control";
const POLL_INTERVAL_MS = 2500;

type Tone = "ok" | "warn" | "bad" | "pending";

const TONE_CLASS: Record<Tone, string> = {
	ok: "bg-success",
	warn: "bg-warning",
	bad: "bg-destructive",
	pending: "bg-muted-foreground/40",
};

function StatusDot({ tone }: { tone: Tone }) {
	return (
		<span
			className={cn(
				"size-2 shrink-0 rounded-full",
				TONE_CLASS[tone],
				tone === "pending" && "animate-pulse"
			)}
		/>
	);
}

/** The full health snapshot the page polls into. */
interface Health {
	coreState: "running" | "starting" | "stopped";
	coreUpdate: UpdateCheck | null;
	coreVersion: string | null;
	gatewayReachable: boolean | null;
	islandReachable: boolean | null;
	loading: boolean;
	/** name -> running, from /api/system/status. */
	sidecars: { name: string; running: boolean }[];
}

const INITIAL_HEALTH: Health = {
	coreState: "starting",
	coreVersion: null,
	coreUpdate: null,
	gatewayReachable: null,
	islandReachable: null,
	loading: true,
	sidecars: [],
};

function activeTarget(): ApiTarget {
	try {
		return toTarget(useNodeStore.getState().getActiveNode());
	} catch {
		return { url: "http://127.0.0.1:7980", token: null };
	}
}

/** Probe the Island loopback control server; best-effort (may CORS-fail). */
async function probeIsland(): Promise<boolean> {
	try {
		const resp = await fetch(ISLAND_CONTROL_URL, { method: "GET" });
		return resp.ok;
	} catch {
		return false;
	}
}

function usePreflightHealth() {
	const [health, setHealth] = useState<Health>(INITIAL_HEALTH);
	const setCoreStatus = useAppStore((s) => s.setCoreStatus);
	const autoStarted = useRef(false);

	const poll = useCallback(async () => {
		const target = activeTarget();
		const status = await getRyuStatus().catch(() => "stopped");
		const coreRunning = status === "running";

		// Auto-start Core once if it is down — the "auto-start if it fails" ask.
		if (!(coreRunning || autoStarted.current)) {
			autoStarted.current = true;
			startRyuCore().catch(() => undefined);
		}

		if (!coreRunning) {
			const island = await probeIsland();
			setHealth((h) => ({
				...h,
				coreState: "stopped",
				gatewayReachable: null,
				islandReachable: island,
				loading: false,
			}));
			return;
		}

		// Core is up — the app gate can advance; fan out the remaining probes.
		setCoreStatus("running");
		const [sys, health_, update, island] = await Promise.all([
			fetchSystemStatus(target).catch(() => null),
			fetchHealth(target).catch(() => null),
			checkForUpdate(target).catch(() => null),
			probeIsland(),
		]);
		setHealth({
			coreState: "running",
			coreVersion: health_?.version ?? null,
			coreUpdate: update,
			gatewayReachable: sys?.gatewayReachable ?? false,
			islandReachable: island,
			loading: false,
			sidecars: sys
				? Object.entries(sys.sidecars).map(([name, running]) => ({
						name,
						running,
					}))
				: [],
		});
	}, [setCoreStatus]);

	useEffect(() => {
		let cancelled = false;
		const tick = async () => {
			if (cancelled) {
				return;
			}
			await poll().catch(() => undefined);
		};
		tick();
		const id = setInterval(tick, POLL_INTERVAL_MS);
		return () => {
			cancelled = true;
			clearInterval(id);
		};
	}, [poll]);

	return { health, refresh: poll };
}

/** A labelled action button that shows a spinner label while its promise runs. */
function ActionButton({
	label,
	busyLabel,
	onRun,
	variant = "outline",
}: {
	label: string;
	busyLabel: string;
	onRun: () => Promise<void>;
	variant?: "default" | "outline";
}) {
	const [busy, setBusy] = useState(false);
	return (
		<Button
			disabled={busy}
			onClick={async () => {
				setBusy(true);
				try {
					await onRun();
				} finally {
					setBusy(false);
				}
			}}
			size="sm"
			variant={variant}
		>
			{busy ? busyLabel : label}
		</Button>
	);
}

export function PreflightPage({
	embedded = false,
}: {
	embedded?: boolean;
} = {}) {
	const { health, refresh } = usePreflightHealth();
	const { engines } = useEngines();
	const [open, setOpen] = useState<string | null>("core");

	const target = activeTarget();

	const coreTone: Tone =
		health.coreState === "running"
			? "ok"
			: health.coreState === "starting"
				? "pending"
				: "bad";
	const gatewayTone: Tone =
		health.gatewayReachable == null
			? "pending"
			: health.gatewayReachable
				? "ok"
				: "bad";
	const islandTone: Tone =
		health.islandReachable == null
			? "pending"
			: health.islandReachable
				? "ok"
				: "warn";
	// Hide engines that aren't installed, or that this node can't run (e.g. MLX on
	// non-Apple-Silicon), from the sidecar list. They're registered in the catalog
	// but never installed, so surfacing them as health rows just nags.
	const hiddenEngineNames = new Set(
		engines
			.filter((e) => !e.supported || e.installState === "not_installed")
			.map((e) => e.name)
	);
	const visibleSidecars = health.sidecars.filter(
		(s) => !hiddenEngineNames.has(s.name)
	);
	const failedSidecars = visibleSidecars.filter((s) => !s.running);

	const componentTitle = (
		name: string,
		tone: Tone,
		detail: string,
		badge?: string
	) => (
		<span className="flex min-w-0 items-center gap-2">
			<StatusDot tone={tone} />
			<span className="font-medium text-foreground">{name}</span>
			<span className="truncate text-muted-foreground text-xs">{detail}</span>
			{badge ? (
				<span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] text-primary">
					{badge}
				</span>
			) : null}
		</span>
	);

	const coreUpdateAvailable = health.coreUpdate?.update_available ?? false;

	const items: BouncyAccordionItem[] = [
		{
			id: "core",
			title: componentTitle(
				"Core",
				coreTone,
				health.coreState === "running"
					? `running · v${health.coreVersion ?? "?"}`
					: health.coreState === "starting"
						? "starting…"
						: "not running",
				coreUpdateAvailable ? "Update" : undefined
			),
			description: (
				<div className="flex flex-col gap-3">
					<p>
						The orchestration engine. Everything routes through it; if it is
						down, chat, agents, and automations can't run.
					</p>
					<div className="flex flex-wrap gap-2">
						{health.coreState === "running" ? null : (
							<ActionButton
								busyLabel="Starting…"
								label="Start Core"
								onRun={async () => {
									await startRyuCore();
									toast.info("Starting Core…");
								}}
								variant="default"
							/>
						)}
						<ActionButton
							busyLabel="Restarting…"
							label="Restart Core"
							onRun={async () => {
								await restartRyuCore();
								toast.info("Restarting Core…");
							}}
						/>
						{coreUpdateAvailable && health.coreUpdate ? (
							<ActionButton
								busyLabel="Updating…"
								label="Update Core"
								onRun={() => installUpdate(health.coreUpdate as UpdateCheck)}
								variant="default"
							/>
						) : null}
					</div>
					{health.coreState === "running" && visibleSidecars.length > 0 ? (
						<div className="flex flex-col gap-2 border-border/60 border-t pt-3">
							<span className="text-foreground text-xs">
								Sidecars ({visibleSidecars.length - failedSidecars.length}/
								{visibleSidecars.length} running)
							</span>
							{visibleSidecars.map((sc) => (
								<div
									className="flex items-center justify-between gap-2"
									key={sc.name}
								>
									<span className="flex items-center gap-2 text-sm">
										<StatusDot tone={sc.running ? "ok" : "warn"} />
										{sc.name}
									</span>
									{sc.running ? (
										<ActionButton
											busyLabel="…"
											label="Restart"
											onRun={async () => {
												await restartSidecar(target.url, target.token, sc.name);
												toast.info(`Restarting ${sc.name}…`);
												await refresh();
											}}
										/>
									) : (
										<ActionButton
											busyLabel="…"
											label="Start"
											onRun={async () => {
												await startSidecar(target.url, target.token, sc.name);
												toast.info(`Starting ${sc.name}…`);
												await refresh();
											}}
										/>
									)}
								</div>
							))}
						</div>
					) : null}
				</div>
			),
		},
		{
			id: "gateway",
			title: componentTitle(
				"Gateway",
				gatewayTone,
				health.coreState === "running"
					? health.gatewayReachable
						? "reachable"
						: "unreachable"
					: "needs Core"
			),
			description: (
				<div className="flex flex-col gap-3">
					<p>
						The governance layer — routing, firewall, budgets, audit. Core
						manages it; restart respawns the process.
					</p>
					<div className="flex flex-wrap gap-2">
						<ActionButton
							busyLabel="Restarting…"
							label="Restart Gateway"
							onRun={async () => {
								const ok = await restartGateway(target);
								toast[ok ? "info" : "warning"](
									ok
										? "Restarting Gateway…"
										: "Gateway is externally managed — can't restart from here"
								);
								await refresh();
							}}
						/>
					</div>
				</div>
			),
		},
		{
			id: "desktop",
			title: componentTitle("Desktop", "ok", "this app"),
			description: (
				<div className="flex flex-col gap-3">
					<p>The app you're looking at. Relaunch to recover a wedged window.</p>
					<div className="flex flex-wrap gap-2">
						<ActionButton
							busyLabel="Relaunching…"
							label="Relaunch Desktop"
							onRun={() => relaunch()}
						/>
					</div>
				</div>
			),
		},
		{
			id: "island",
			title: componentTitle(
				"Island",
				islandTone,
				health.islandReachable == null
					? "checking…"
					: health.islandReachable
						? "running"
						: "not running"
			),
			description: (
				<div className="flex flex-col gap-3">
					<p>
						The dynamic-island companion (a separate process). If it isn't
						running, launch it from the tray; Show brings it forward.
					</p>
					<div className="flex flex-wrap gap-2">
						<ActionButton
							busyLabel="…"
							label="Show Island"
							onRun={async () => {
								try {
									await fetch(ISLAND_CONTROL_URL, {
										method: "POST",
										headers: { "Content-Type": "application/json" },
										body: JSON.stringify({ action: "show" }),
									});
									toast.info("Showing Island…");
								} catch {
									toast.warning("Island isn't running");
								}
								await refresh();
							}}
						/>
					</div>
				</div>
			),
		},
	];

	return (
		<div
			// Full-window (non-embedded) boot screen renders outside Layout, so it
			// has no TitleBar drag region — mark the background draggable so the
			// window can still be moved. Embedded (inside Settings) must not drag.
			className={cn(
				embedded
					? "flex w-full flex-col gap-5"
					: "flex h-full w-full items-center justify-center overflow-y-auto bg-background p-6"
			)}
			data-tauri-drag-region={embedded ? undefined : true}
		>
			<div
				className={cn("flex w-full flex-col gap-5", !embedded && "max-w-md")}
			>
				{embedded ? null : (
					<header className="flex flex-col gap-1 text-center">
						<h1 className="font-semibold text-foreground text-xl">
							{health.coreState === "running"
								? "Almost there"
								: "Getting Ryu ready"}
						</h1>
						<p className="text-muted-foreground text-sm">
							{health.coreState === "running"
								? "Core is up. Check any component below, then continue."
								: "Core isn't running yet. It should start automatically — or start it below."}
						</p>
					</header>
				)}

				<BouncyAccordion items={items} onValueChange={setOpen} value={open} />

				<div className="flex items-center justify-between gap-2">
					<div className="flex gap-2">
						<ActionButton
							busyLabel="Copying…"
							label="Copy diagnostics"
							onRun={async () => {
								await copyDiagnostics(target);
								toast.success("Diagnostics copied to clipboard");
							}}
						/>
						<ActionButton
							busyLabel="Reporting…"
							label="Report issue"
							onRun={async () => {
								await reportIssue(target);
								toast.success("Issue reported");
							}}
						/>
					</div>
					{embedded ? (
						<Button onClick={() => refresh()} size="sm" variant="outline">
							Refresh
						</Button>
					) : health.coreState === "running" ? (
						<Button onClick={() => refresh()} size="sm" variant="default">
							Continue
						</Button>
					) : null}
				</div>
			</div>
		</div>
	);
}
