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

import {
	OnboardingCta,
	OnboardingShell,
} from "@ryu/blocks/desktop/onboarding-shell.tsx";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { toast } from "@ryu/ui/components/sileo.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import { relaunch } from "@tauri-apps/plugin-process";
import { useState } from "react";
import { restartRyuCore, startRyuCore } from "@/lib/tauri-bridge.ts";
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
import { toTarget } from "@/src/lib/api/client.ts";
import { restartGateway } from "@/src/lib/api/system.ts";

import { ISLAND_ENABLED } from "@/src/lib/island-availability.ts";
import { restartSidecar, startSidecar } from "@/src/lib/services-api.ts";

import { isLocalNode } from "@/src/store/useNodeStore.ts";
import {
	ISLAND_CONTROL_URL,
	POLL_INTERVAL_MS,
	usePreflightHealth,
} from "./PreflightPage.health.ts";
import { ComponentRow, StatusDot, type Tone } from "./PreflightPage.parts.tsx";

export function PreflightPage({
	embedded = false,
}: {
	embedded?: boolean;
} = {}) {
	const tl = useLiteralMessages();
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
			<span
				className="truncate text-detail text-muted-foreground"
				title={detail}
			>
				{detail}
			</span>
			{badge ? (
				<span className="shrink-0 text-detail text-status-info">{badge}</span>
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
						<div className="flex flex-col gap-2 border-border border-t pt-3">
							<span className="text-detail text-foreground">
								{tl("Helpers ({running}/{total} running)", {
									running: String(
										visibleSidecars.length - failedSidecars.length
									),
									total: String(visibleSidecars.length),
								})}
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

	// Full-window boot matches onboarding: the shared OnboardingShell (persona
	// mark, centered header, one fade).
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
					<OnboardingCta onClick={() => refresh()}>Continue</OnboardingCta>
				) : null}
			</div>
		</>
	);

	return (
		// Full-window boot screen renders outside Layout, so it has no TitleBar
		// drag region — mark the background draggable so the window can still be
		// moved. Interactive children override it.
		<div className="size-full bg-background">
			<OnboardingShell
				subtitle={
					health.coreState === "running"
						? "Core is up. Check any component below, then continue."
						: "Core isn't running yet. It should start automatically, or start it below."
				}
				title={
					health.coreState === "running" ? "Almost there" : "Getting Ryu ready"
				}
			>
				{body}
			</OnboardingShell>
		</div>
	);
}
