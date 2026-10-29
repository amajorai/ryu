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

import { ArrowDown01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Logo as GhostOrb } from "@ryu/ui/components/logo.tsx";
import { PageHeader } from "@ryu/ui/components/page-header.tsx";
import { toast } from "@ryu/ui/components/sileo.tsx";
import { StaggerReveal } from "@ryu/ui/components/stagger-reveal.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import { relaunch } from "@tauri-apps/plugin-process";
import {
	type ReactNode,
	useCallback,
	useEffect,
	useId,
	useMemo,
	useRef,
	useState,
} from "react";
import {
	getRyuStatus,
	restartRyuCore,
	startRyuCore,
} from "@/lib/tauri-bridge.ts";
import {
	SettingsGroup,
	SettingsSection,
} from "@/src/components/settings/shared/settings-items.tsx";
import {
	PreflightActionButton as ActionButton,
	PreflightDiagnosticsActions,
} from "@/src/components/shell/PreflightActions.tsx";
import {
	BouncyAccordion,
	type BouncyAccordionItem,
} from "@/src/components/ui/bouncy-accordion.tsx";
import {
	applyReleaseUpdate,
	scheduleReleaseUpdate,
} from "@/src/components/updater/AutoUpdater.tsx";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import { useEngines } from "@/src/hooks/useEngines.ts";
import { useSafeMode } from "@/src/hooks/useSafeMode.ts";
import { type ApiTarget, toTarget } from "@/src/lib/api/client.ts";
import {
	fetchHealth,
	fetchSystemStatus,
	restartGateway,
} from "@/src/lib/api/system.ts";
import { checkForUpdate, type UpdateCheck } from "@/src/lib/api/update.ts";
import { ISLAND_ENABLED } from "@/src/lib/island-availability.ts";
import { restartSidecar, startSidecar } from "@/src/lib/services-api.ts";
import { useAppStore } from "@/src/store/useAppStore.ts";
import { isLocalNode } from "@/src/store/useNodeStore.ts";

/** The Island Electron companion's loopback control server (see apps/island). */
const ISLAND_CONTROL_URL = "http://127.0.0.1:7989/control";
const POLL_INTERVAL_MS = 2500;

type Tone = "ok" | "warn" | "bad" | "pending";

const TONE_CLASS = {
	ok: "bg-success",
	warn: "bg-warning",
	bad: "bg-destructive",
	pending: "bg-muted-foreground/40",
} satisfies Record<Tone, string>;

function StatusDot({ tone }: { tone: Tone }) {
	return (
		<span
			className={cn(
				"size-2 shrink-0 rounded-full",
				TONE_CLASS[tone],
				tone === "pending" && "motion-safe:animate-pulse"
			)}
		/>
	);
}

/**
 * One component as a disclosure row of the embedded (Settings) card: the status
 * line is the trigger, its controls open beneath it inside the same row. The
 * trigger's accessible name starts with the component name and carries
 * `aria-expanded`, which the preflight proof drives.
 */
function ComponentRow({
	children,
	onToggle,
	open,
	title,
}: {
	children: ReactNode;
	onToggle: () => void;
	open: boolean;
	title: ReactNode;
}) {
	const id = useId();
	return (
		<div>
			<button
				aria-controls={`${id}-panel`}
				aria-expanded={open}
				className="flex min-h-11 w-full min-w-0 items-center gap-3 px-3.5 py-2.5 text-left text-sm outline-none focus-visible:bg-muted/40"
				id={`${id}-trigger`}
				onClick={onToggle}
				type="button"
			>
				<span className="min-w-0 flex-1">{title}</span>
				<HugeiconsIcon
					aria-hidden
					className={cn(
						"size-4 shrink-0 text-muted-foreground transition-transform",
						open && "rotate-180"
					)}
					icon={ArrowDown01Icon}
				/>
			</button>
			<div
				aria-labelledby={`${id}-trigger`}
				className="px-3.5 pb-3 text-muted-foreground text-sm"
				hidden={!open}
				id={`${id}-panel`}
				role="region"
			>
				{children}
			</div>
		</div>
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

/** Probe the Island loopback control server; best-effort (may CORS-fail). */
async function probeIsland(): Promise<boolean> {
	try {
		const resp = await fetch(ISLAND_CONTROL_URL, { method: "GET" });
		return resp.ok;
	} catch {
		return false;
	}
}

function usePreflightHealth(target: ApiTarget) {
	const scope = useMemo(
		() => ({
			target: { ...target },
			controller: new AbortController(),
			autoStarted: false,
			poll: 0,
			polling: new Set<AbortSignal>(),
		}),
		[target.url, target.token, target.userJwt]
	);
	const current = useRef(scope);
	current.current = scope;
	const [result, setResult] = useState<{
		scope: typeof scope;
		health: Health;
	}>();
	const setCoreStatus = useAppStore((store) => store.setCoreStatus);
	const poll = useCallback(async () => {
		const signal = scope.controller.signal;
		if (scope.polling.has(signal)) {
			return;
		}
		scope.polling.add(signal);
		try {
			const sequence = ++scope.poll;
			const owns = () =>
				current.current === scope && !signal.aborted && sequence === scope.poll;
			const target = scope.target;
			const local = isLocalNode(target);
			const status = local
				? await getRyuStatus().catch(() => "stopped")
				: await fetchHealth(target, signal)
						.then(() => "running")
						.catch(() => "stopped");
			if (!owns()) {
				return;
			}
			const coreRunning = status === "running";
			if (local && !(coreRunning || scope.autoStarted)) {
				scope.autoStarted = true;
				void startRyuCore().catch(() => undefined);
			}
			if (!coreRunning) {
				const island = await probeIsland();
				if (owns()) {
					setResult({
						scope,
						health: {
							...INITIAL_HEALTH,
							coreState: "stopped",
							islandReachable: island,
							loading: false,
						},
					});
				}
				return;
			}
			const [sys, health, update, island] = await Promise.all([
				fetchSystemStatus(target).catch(() => null),
				fetchHealth(target, signal).catch(() => null),
				checkForUpdate(target, { signal }).catch(() => null),
				probeIsland(),
			]);
			if (!owns()) {
				return;
			}
			setCoreStatus("running");
			setResult({
				scope,
				health: {
					coreState: "running",
					coreVersion: health?.version ?? null,
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
				},
			});
		} finally {
			scope.polling.delete(signal);
		}
	}, [scope, setCoreStatus]);
	useEffect(() => {
		scope.controller = new AbortController();
		void poll().catch(() => undefined);
		const timer = setInterval(() => {
			void poll().catch(() => undefined);
		}, POLL_INTERVAL_MS);
		return () => {
			scope.controller.abort();
			clearInterval(timer);
		};
	}, [scope, poll]);
	return {
		health: result?.scope === scope ? result.health : INITIAL_HEALTH,
		refresh: poll,
	};
}

export function PreflightPage({
	embedded = false,
}: {
	embedded?: boolean;
} = {}) {
	const { engines } = useEngines();
	const [open, setOpen] = useState<string | null>("core");
	const node = useActiveNode();
	const target = toTarget(node);
	const { health, refresh } = usePreflightHealth(target);
	const {
		state: safeMode,
		sentinel,
		pending,
		apply: changeSafeMode,
		local,
	} = useSafeMode(target, POLL_INTERVAL_MS);
	const safeModeArmed =
		pending ??
		(safeMode?.userClearable === false
			? safeMode.enabled
			: safeMode?.preferenceEnabled) ??
		sentinel ??
		false;

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
			<span className={cn("text-foreground", !embedded && "font-medium")}>
				{name}
			</span>
			<span className="truncate text-muted-foreground text-xs" title={detail}>
				{detail}
			</span>
			{badge ? (
				<span className="type-compact rounded-full bg-primary/10 px-2 py-0.5 text-primary">
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
					<p>Ryu's brain. Chat, agents, and automations all need it running.</p>
					<div className="flex flex-wrap gap-2">
						{!local || health.coreState === "running" ? null : (
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
						{local ? (
							<ActionButton
								busyLabel="Restarting…"
								label="Restart Core"
								onRun={async () => {
									await restartRyuCore();
									toast.info("Restarting Core…");
								}}
							/>
						) : null}
						{/* Safe Mode: restart with apps, plugins, skills, user MCP servers
						    and the scheduler switched off, to find out whether one of them
						    is what's wrong. Nothing is uninstalled — it only changes what
						    loads, so leaving it puts everything back. */}
						{!safeMode?.enabled || safeMode.userClearable ? (
							<ActionButton
								busyLabel={safeModeArmed ? "Restoring…" : "Arming…"}
								label={
									local
										? safeModeArmed
											? "Leave Safe Mode"
											: "Restart in Safe Mode"
										: safeModeArmed
											? "Clear Safe Mode for next boot"
											: "Save Safe Mode for next boot"
								}
								onRun={async () => {
									const next = !safeModeArmed;
									// Core first when it is up, so BOTH persistence tiers move
									// together — see `applySafeMode`.
									await changeSafeMode(next);
								}}
							/>
						) : (
							<p className="text-muted-foreground text-sm">
								Safe Mode is forced by the node’s environment. Remove its
								RYU_SAFE_MODE override before clearing it.
							</p>
						)}
						{!local && pending !== null ? (
							<p className="text-muted-foreground text-sm">
								Saved for this node. Restart the remote node to apply the
								change.
							</p>
						) : null}
						{coreUpdateAvailable && health.coreUpdate ? (
							<ActionButton
								busyLabel="Updating…"
								label="Update Core"
								onRun={async () => {
									if (!health.coreUpdate) {
										return;
									}
									// Routes to the node's OWN updater when this Core is
									// remote — the bundled desktop updater would otherwise
									// replace this machine's app and leave that node behind.
									const message = await applyReleaseUpdate(
										target,
										node,
										health.coreUpdate
									);
									if (message) {
										toast.info(message);
									}
								}}
								variant="default"
							/>
						) : null}
						{/* Only for a REMOTE node. A local node's Core ships inside this
						    app bundle and is installed by the native updater with its own
						    restart flow, so there is nothing on it to defer — offering the
						    choice there would be a button that always errors. */}
						{coreUpdateAvailable && health.coreUpdate && !isLocalNode(node) ? (
							<ActionButton
								busyLabel="Scheduling…"
								label="Update tonight"
								onRun={async () => {
									if (!health.coreUpdate) {
										return;
									}
									// Deferred to the NODE's quiet hour, not the viewer's:
									// the machine that restarts is the one whose night
									// matters. The confirmation names the zone.
									if (!health.coreUpdate) {
										return;
									}
									const message = await scheduleReleaseUpdate(
										target,
										node,
										health.coreUpdate
									);
									toast.info(message);
								}}
								variant="outline"
							/>
						) : null}
					</div>
					{health.coreState === "running" && visibleSidecars.length > 0 ? (
						<div className="flex flex-col gap-2 border-border/60 border-t pt-3">
							<span className="text-foreground text-xs">
								Helpers ({visibleSidecars.length - failedSidecars.length}/
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
						? "connected"
						: "can't connect"
					: "waiting for Core"
			),
			description: (
				<div className="flex flex-col gap-3">
					<p>
						Keeps Ryu safe — what it can do, and how much it uses. Restart if it
						looks stuck.
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
										: "Gateway can't be restarted from here"
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
					<p>This app. Relaunch if the window freezes or looks stuck.</p>
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
		// Island is behind the ISLAND_ENABLED release gate.
		...(ISLAND_ENABLED
			? [
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
									The floating companion at the top of your screen. Use Show to
									bring it back if it's hidden.
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
				]
			: []),
	];

	// Embedded (Settings → Diagnostics): one grouped card of disclosure rows,
	// with the diagnostics actions and Refresh in the section header.
	if (embedded) {
		return (
			<SettingsSection
				headerAction={
					<div className="flex flex-wrap items-center justify-end gap-2">
						<PreflightDiagnosticsActions target={target} />
						<Button onClick={() => refresh()} size="sm" variant="ghost">
							Refresh
						</Button>
					</div>
				}
				title="Components"
			>
				<SettingsGroup>
					{items.map((item) => (
						<ComponentRow
							key={item.id}
							onToggle={() =>
								setOpen((current) => (current === item.id ? null : item.id))
							}
							open={open === item.id}
							title={item.title}
						>
							{item.description}
						</ComponentRow>
					))}
				</SettingsGroup>
			</SettingsSection>
		);
	}

	// Full-window boot matches Login / onboarding: GhostOrb + PageHeader +
	// staggered reveal.
	const body = (
		<>
			<BouncyAccordion
				classNames={{ title: "truncate" }}
				items={items}
				onValueChange={setOpen}
				value={open}
			/>

			<div className="flex items-center justify-between gap-2">
				<PreflightDiagnosticsActions target={target} />
				{health.coreState === "running" ? (
					<Button onClick={() => refresh()} size="sm" variant="default">
						Continue
					</Button>
				) : null}
			</div>
		</>
	);

	return (
		// Full-window boot screen renders outside Layout, so it has no TitleBar
		// drag region — mark the background draggable so the window can still be
		// moved. Interactive children override it.
		<div
			className="flex h-full w-full flex-col items-center justify-center gap-8 overflow-y-auto bg-background p-8"
			data-tauri-drag-region="true"
		>
			<StaggerReveal>
				<div className="shrink-0">
					<GhostOrb size="50px" variant="outline" />
				</div>
				<PageHeader
					stagger={false}
					subtitle={
						health.coreState === "running"
							? "Core is up. Check any component below, then continue."
							: "Core isn't running yet. It should start automatically, or start it below."
					}
					title={
						health.coreState === "running"
							? "Almost there"
							: "Getting Ryu ready"
					}
				/>
				<div className="flex w-full max-w-md flex-col gap-5">{body}</div>
			</StaggerReveal>
		</div>
	);
}
