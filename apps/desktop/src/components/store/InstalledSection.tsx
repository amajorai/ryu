// apps/desktop/src/components/store/InstalledSection.tsx
//
// The Store's "Installed" section — the single "what I already have" surface,
// merging the former Apps page (launch + sidecar running-state + install/enable)
// and Extensions page (enable/disable toggle, plain-English permission grants,
// bundled runnable kinds, and the live extension-host demo). Both were `useApps()`
// grids over /api/plugins; this unifies them so the sidebar keeps one Customize
// entry instead of two adjacent, overlapping buttons.

import {
	ArrowDown01Icon,
	BotIcon,
	ComputerIcon,
	Delete02Icon,
	Download04Icon,
	PackageIcon,
	PlayIcon,
	Settings01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@ryu/ui/components/alert-dialog";
import { Badge } from "@ryu/ui/components/badge";
import { Button } from "@ryu/ui/components/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@ryu/ui/components/card";
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@ryu/ui/components/empty";
import { toast } from "@ryu/ui/components/sileo";
import { Spinner } from "@ryu/ui/components/spinner";
import { Switch } from "@ryu/ui/components/switch";
import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { SystemAppCard } from "@/src/components/SystemAppCard.tsx";
import { PluginSettingsFields } from "@/src/components/settings/PluginSettingsFields.tsx";
import { ExamplePluginPanel } from "@/src/contributions/host/ExamplePluginPanel.tsx";
import { useActiveNodeGetter } from "@/src/hooks/useActiveNode.ts";
import { useApps } from "@/src/hooks/useApps.ts";
import { usePluginSettingsTabs } from "@/src/hooks/usePluginSettingsTabs.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import type { AppInfo } from "@/src/lib/api/plugins.ts";
import { fetchSidecarStatus, setPluginGrants } from "@/src/lib/api/plugins.ts";
import type { PluginSettingsTab } from "@/src/lib/pluginSettings.ts";
import {
	grantDescription,
	grantLabel,
} from "@/src/lib/plugins/grant-labels.ts";

const AGENT_KIND = "agent";
const SIDECAR_POLL_MS = 5000;

// ── Kind + permission labels (from the former Extensions page) ──────────────────

const KIND_LABELS: Record<string, string> = {
	agent: "Agent",
	workflow: "Workflow",
	tool: "Tool",
	skill: "Skill",
	companion: "Companion",
	channel: "Channel",
	engine: "Engine",
	policy: "Policy",
};

// Plain-English grant labels + descriptions live in one shared module so the store
// consent dialog and this per-app permissions view speak the same vocabulary.

function primaryAgentId(app: AppInfo): string | null {
	const entry = app.runnables.find((r) => r.kind === AGENT_KIND);
	return entry?.id ?? null;
}

export default function InstalledSection() {
	const navigate = useNavigate();
	const {
		apps,
		loading,
		error,
		install,
		toggle,
		toggleError,
		clearToggleError,
		reload,
		uninstall,
	} = useApps();
	const getActiveNode = useActiveNodeGetter();
	const activeNode = getActiveNode();
	const target: ApiTarget = {
		url: activeNode.url,
		token: activeNode.token ?? null,
	};
	const { byPlugin: settingsByPlugin } = usePluginSettingsTabs();

	const [pending, setPending] = useState<Record<string, boolean>>({});
	const [sidecarStatus, setSidecarStatus] = useState<Record<string, boolean>>(
		{}
	);

	// A plugin's `requires.apps` names its dependencies by ID; the cards show human
	// names. Resolve through the installed list (an id we don't know — a dependency
	// that isn't installed — falls back to the raw id, which is still actionable).
	const displayName = useCallback(
		(id: string) => apps.find((a) => a.id === id)?.name ?? id,
		[apps]
	);

	const pollSidecarStatus = useCallback(async () => {
		const node = getActiveNode();
		const nodeTarget: ApiTarget = { url: node.url, token: node.token ?? null };
		try {
			const status = await fetchSidecarStatus(nodeTarget);
			setSidecarStatus(status);
		} catch {
			// Non-fatal: status stays at last known value.
		}
	}, [getActiveNode]);

	useEffect(() => {
		pollSidecarStatus().catch(() => {
			// Best-effort initial poll.
		});
		const id = setInterval(() => {
			pollSidecarStatus().catch(() => {
				// Best-effort interval poll.
			});
		}, SIDECAR_POLL_MS);
		return () => clearInterval(id);
	}, [pollSidecarStatus]);

	const setPendingFor = (id: string, val: boolean) =>
		setPending((prev) => ({ ...prev, [id]: val }));

	const handleInstall = async (app: AppInfo) => {
		setPendingFor(app.id, true);
		try {
			// Install and turn on in a single step so there is no hidden second
			// click needed to start using the app.
			await install(app.id);
			await toggle(app.id, true);
		} catch {
			toast.error("Couldn't install this app", {
				description: "Check your connection and try again.",
			});
		} finally {
			setPendingFor(app.id, false);
		}
	};

	const handleToggle = async (app: AppInfo, checked: boolean) => {
		if (!app.installed) {
			return;
		}
		setPendingFor(app.id, true);
		try {
			await toggle(app.id, checked);
		} finally {
			setPendingFor(app.id, false);
		}
	};

	const handleUninstall = async (app: AppInfo) => {
		setPendingFor(app.id, true);
		try {
			// `uninstall` routes a 409 refusal (built-in, or enabled dependents)
			// through `toggleError` — the SAME banner the disable-refusal uses — so
			// no per-call error handling is needed here.
			await uninstall(app.id);
		} finally {
			setPendingFor(app.id, false);
		}
	};

	const handleLaunch = (app: AppInfo) => {
		const agentId = primaryAgentId(app);
		if (agentId) {
			localStorage.setItem("ryu_default_agent", agentId);
		}
		navigate("/chat");
	};

	if (loading) {
		return (
			<div className="flex h-full items-center justify-center">
				<Spinner />
			</div>
		);
	}

	if (error) {
		return (
			<Empty className="h-full">
				<EmptyHeader>
					<EmptyMedia variant="icon">
						<HugeiconsIcon icon={PackageIcon} />
					</EmptyMedia>
					<EmptyTitle>Couldn't load installed items</EmptyTitle>
					<EmptyDescription>
						Something went wrong while loading what you have installed. Check
						your connection and try again.
					</EmptyDescription>
				</EmptyHeader>
				<EmptyContent>
					<Button
						onClick={() =>
							reload().catch(() => {
								// Retry is best-effort.
							})
						}
						size="sm"
						variant="ghost"
					>
						Retry
					</Button>
				</EmptyContent>
			</Empty>
		);
	}

	return (
		<div className="flex h-full flex-col overflow-hidden">
			<div className="scroll-fade-effect-y flex-1 overflow-auto p-4">
				{toggleError ? (
					<div className="mb-4 flex items-start justify-between gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-destructive text-sm">
						<span>{toggleError}</span>
						<button
							className="shrink-0 font-medium underline-offset-2 hover:underline"
							onClick={clearToggleError}
							type="button"
						>
							Dismiss
						</button>
					</div>
				) : null}

				{apps.length === 0 ? (
					<Empty>
						<EmptyHeader>
							<EmptyMedia variant="icon">
								<HugeiconsIcon icon={PackageIcon} />
							</EmptyMedia>
							<EmptyTitle>Nothing installed yet</EmptyTitle>
							<EmptyDescription>
								Plugins, agents, and tools you install from the store show up
								here. Built-in plugins like Ghost and Shadow are always
								available.
							</EmptyDescription>
						</EmptyHeader>
					</Empty>
				) : (
					<div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
						{apps.map((app) => {
							if (app.builtIn) {
								const running =
									app.sidecarName === null
										? undefined
										: sidecarStatus[app.sidecarName];
								return (
									<SystemAppCard
										app={app}
										key={app.id}
										onStatusChange={() =>
											pollSidecarStatus().catch(() => {
												// Best-effort refresh.
											})
										}
										running={running}
										target={target}
									/>
								);
							}
							return (
								<InstalledAppCard
									app={app}
									busy={pending[app.id] ?? false}
									displayName={displayName}
									key={app.id}
									onGrantsChanged={reload}
									onInstall={handleInstall}
									onLaunch={handleLaunch}
									onToggle={handleToggle}
									onUninstall={handleUninstall}
									settingsTabs={settingsByPlugin.get(app.id) ?? []}
									target={target}
								/>
							);
						})}
					</div>
				)}

				{/* Live extension-host demo (#446): the example plugin runs in a
				    sandboxed null-origin iframe and reaches Core only over the
				    capability-gated RPC bridge. Dev-only, and below the installed
				    grid, so real content leads the end-user surface. */}
				{import.meta.env.DEV ? (
					<div className="mt-4 h-72">
						<ExamplePluginPanel />
					</div>
				) : null}
			</div>
		</div>
	);
}

interface InstalledAppCardProps {
	app: AppInfo;
	busy: boolean;
	/** Resolve a dependency's plugin id to its display name (falls back to the id). */
	displayName: (id: string) => string;
	/** Refresh the app list after a per-grant revoke/restore so the toggles reflect
	 *  the newly-persisted approved set. */
	onGrantsChanged: () => void;
	onInstall: (app: AppInfo) => Promise<void>;
	onLaunch: (app: AppInfo) => void;
	onToggle: (app: AppInfo, checked: boolean) => Promise<void>;
	onUninstall: (app: AppInfo) => Promise<void>;
	settingsTabs: PluginSettingsTab[];
	target: ApiTarget;
}

// The per-plugin "Settings" disclosure on an installed card: a toggle button
// that expands the fields the plugin declared in its manifest
// (`contributes.settings_tabs`), each persisted under its own preference key.
// Extracted from the card so the card stays simple and the disclosure owns its
// own open/close state.
function InstalledAppSettings({
	settingsTabs,
	target,
}: {
	settingsTabs: PluginSettingsTab[];
	target: ApiTarget;
}) {
	const [open, setOpen] = useState(false);

	return (
		<>
			<Button
				aria-expanded={open}
				onClick={() => setOpen((o) => !o)}
				size="sm"
				variant="ghost"
			>
				<HugeiconsIcon className="size-4" icon={Settings01Icon} />
				Settings
				<HugeiconsIcon
					className={`size-3.5 transition-transform ${
						open ? "rotate-180" : ""
					}`}
					icon={ArrowDown01Icon}
				/>
			</Button>
			{open ? (
				<div className="w-full border-t pt-3">
					<PluginSettingsFields
						hideTabTitles={settingsTabs.length === 1}
						tabs={settingsTabs}
						target={target}
					/>
				</div>
			) : null}
		</>
	);
}

// The per-app permissions editor: one row per grant the app DECLARED. When the app
// is enabled each row is a Switch reflecting whether the grant is currently in the
// app's APPROVED set; toggling it POSTs the new subset to `/api/plugins/:id/grants`
// (escalation-guarded + Gateway-revalidated Core-side). When disabled the grants are
// read-only (grant editing requires an enabled app). This is what lets a user revoke
// "use AI models" from an app without uninstalling it.
function PermissionsEditor({
	app,
	target,
	onGrantsChanged,
}: {
	app: AppInfo;
	target: ApiTarget;
	onGrantsChanged: () => void;
}) {
	const [pending, setPending] = useState<string | null>(null);
	const approved = new Set(app.approvedGrants);

	const setGrant = async (grant: string, on: boolean) => {
		setPending(grant);
		const next = new Set(app.approvedGrants);
		if (on) {
			next.add(grant);
		} else {
			next.delete(grant);
		}
		try {
			await setPluginGrants(target, app.id, Array.from(next));
			onGrantsChanged();
		} catch (e) {
			toast.error("Couldn't update permissions", {
				description: e instanceof Error ? e.message : "Please try again.",
			});
		} finally {
			setPending(null);
		}
	};

	return (
		<div>
			<p className="mb-1 font-medium text-muted-foreground text-xs">
				Permissions
			</p>
			<div className="flex flex-col gap-1.5">
				{app.permissionGrants.map((grant) => {
					const description = grantDescription(grant);
					const on = approved.has(grant);
					return (
						<div
							className="flex items-center justify-between gap-3 rounded-md border px-3 py-1.5"
							key={grant}
						>
							<div className="min-w-0">
								<div className="font-medium text-sm">{grantLabel(grant)}</div>
								{description ? (
									<div className="text-muted-foreground text-xs">
										{description}
									</div>
								) : null}
							</div>
							{app.enabled ? (
								<Switch
									aria-label={`${on ? "Revoke" : "Grant"} "${grantLabel(grant)}" for ${app.name}`}
									checked={on}
									disabled={pending !== null}
									onCheckedChange={(checked) => {
										setGrant(grant, checked).catch(() => {
											// Errors surfaced via toast in setGrant.
										});
									}}
								/>
							) : (
								<Badge variant="secondary">{on ? "Granted" : "Off"}</Badge>
							)}
						</div>
					);
				})}
			</div>
			{app.enabled ? null : (
				<p className="mt-1 text-muted-foreground text-xs">
					Enable this app to change its permissions.
				</p>
			)}
		</div>
	);
}

function InstalledAppCard({
	app,
	busy,
	displayName,
	onInstall,
	onLaunch,
	onToggle,
	onUninstall,
	onGrantsChanged,
	settingsTabs,
	target,
}: InstalledAppCardProps) {
	const isInstalled = app.installed;
	const agentId = primaryAgentId(app);
	const hasSettings = isInstalled && settingsTabs.length > 0;
	const dependencies = app.requires?.apps ?? [];
	const [confirmUninstall, setConfirmUninstall] = useState(false);

	return (
		<Card>
			<CardHeader>
				<div className="flex items-start justify-between gap-2">
					<CardTitle className="flex items-center gap-2 text-base">
						<HugeiconsIcon className="size-4 opacity-70" icon={ComputerIcon} />
						{app.name}
					</CardTitle>
					{isInstalled ? (
						<Switch
							aria-label={
								app.enabled ? `Disable ${app.name}` : `Enable ${app.name}`
							}
							checked={app.enabled}
							disabled={busy}
							onCheckedChange={(checked) => onToggle(app, checked)}
						/>
					) : null}
				</div>
				<CardDescription className="flex flex-wrap items-center gap-1">
					<Badge className="font-mono text-xs" variant="secondary">
						v{app.version}
					</Badge>
					{isInstalled ? (
						<Badge variant={app.enabled ? "default" : "secondary"}>
							{app.enabled ? "Enabled" : "Disabled"}
						</Badge>
					) : (
						<Badge variant="secondary">Not installed</Badge>
					)}
					{app.runnables.some((r) => r.kind === AGENT_KIND) ? (
						<Badge className="gap-1" variant="secondary">
							<HugeiconsIcon className="size-3" icon={BotIcon} />
							Agent
						</Badge>
					) : null}
				</CardDescription>
			</CardHeader>

			<CardContent className="flex flex-col gap-3">
				{/* Bundled Runnable kinds */}
				{app.runnables.length > 0 ? (
					<div>
						<p className="mb-1 font-medium text-muted-foreground text-xs">
							Bundles
						</p>
						<div className="flex flex-wrap gap-1">
							{app.runnables.map((r) => (
								<Badge key={r.id} variant="secondary">
									{KIND_LABELS[r.kind] ?? r.kind} — {r.name}
								</Badge>
							))}
						</div>
					</div>
				) : null}

				{/* Plugin-to-plugin dependencies (`requires.apps`). Enabling this app
				    auto-enables these first, in dependency order; disabling one of THEM
				    while this app is on is refused by Core (409) and surfaced through
				    `useApps` as "Disable <this app> first". Shown here so the coupling is
				    visible BEFORE the user hits that refusal. Empty for every plugin that
				    declares no `requires` — i.e. all of them today. */}
				{dependencies.length > 0 ? (
					<div>
						<p className="mb-1 font-medium text-muted-foreground text-xs">
							Requires
						</p>
						<div className="flex flex-wrap gap-1">
							{dependencies.map((dep) => (
								<Badge key={dep.id} variant="secondary">
									{displayName(dep.id)}
									{dep.minVersion ? ` ${dep.minVersion}+` : ""}
								</Badge>
							))}
						</div>
						<p className="mt-1 text-muted-foreground text-xs">
							Enabling {app.name} enables these first.
						</p>
					</div>
				) : null}

				{/* Permission grants, in plain English. When the app is enabled each
				    grant becomes a per-grant toggle so the user can REVOKE a single
				    capability (e.g. "use AI models") without disabling the whole app;
				    when disabled they are shown read-only (grants are edited only on an
				    enabled app — Core rejects otherwise). */}
				{app.permissionGrants.length > 0 ? (
					<PermissionsEditor
						app={app}
						onGrantsChanged={onGrantsChanged}
						target={target}
					/>
				) : null}

				<div className="flex flex-wrap gap-2">
					{app.enabled && agentId ? (
						<Button onClick={() => onLaunch(app)} size="sm" variant="default">
							<HugeiconsIcon className="size-4" icon={PlayIcon} />
							Launch
						</Button>
					) : null}
					{isInstalled ? null : (
						<Button
							disabled={busy}
							onClick={() => onInstall(app)}
							size="sm"
							variant="ghost"
						>
							{busy ? (
								<Spinner className="size-4" />
							) : (
								<HugeiconsIcon className="size-4" icon={Download04Icon} />
							)}
							Install
						</Button>
					)}
					{/* Inline plugin settings — the fields the plugin declared in its
					    manifest (contributes.settings_tabs), persisted per pref key. */}
					{hasSettings ? (
						<InstalledAppSettings settingsTabs={settingsTabs} target={target} />
					) : null}
					{/* Uninstall — only for installed plugins. Built-ins (Ghost/Shadow)
					    render as SystemAppCard, not here, so every card in this branch is
					    a removable plugin. Default-on plugins (Meetings/Spaces) still show
					    the action but Core refuses them with a 409 the `uninstall` hook
					    surfaces cleanly in the shared banner — there is no client signal
					    to hide them ahead of time. */}
					{isInstalled ? (
						<Button
							className="text-destructive hover:text-destructive"
							disabled={busy}
							onClick={() => setConfirmUninstall(true)}
							size="sm"
							variant="ghost"
						>
							<HugeiconsIcon className="size-4" icon={Delete02Icon} />
							Uninstall
						</Button>
					) : null}
				</div>

				{/* App id */}
				<code className="truncate rounded bg-muted px-2 py-1 text-muted-foreground text-xs">
					{app.id}
				</code>
			</CardContent>

			<AlertDialog onOpenChange={setConfirmUninstall} open={confirmUninstall}>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>Uninstall {app.name}?</AlertDialogTitle>
						<AlertDialogDescription>
							This removes {app.name} and disables it. You can reinstall it from
							the store later. Its settings and permission grants are cleared.
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>Cancel</AlertDialogCancel>
						<AlertDialogAction
							onClick={() => {
								onUninstall(app).catch(() => {
									// Refusals surface via the shared toggleError banner.
								});
							}}
						>
							Uninstall
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</Card>
	);
}
