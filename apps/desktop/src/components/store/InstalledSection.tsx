// apps/desktop/src/components/store/InstalledSection.tsx
//
// The Store's "Installed" section — the single "what I already have" surface,
// merging the former Apps page (launch + sidecar running-state + install/enable)
// and Extensions page (enable/disable toggle, plain-English permission grants,
// bundled runnable kinds, and the live extension-host demo).
//
// Reshaped onto the shared App Store layout (StoreCatalogLayout): a centered
// 2-column card grid of thin rows on the left, a preview aside on the right that
// carries every control (toggle, per-grant permissions, inline settings, bundled
// runnables, dependencies, launch, install, uninstall). Built-in sidecar apps
// (Ghost/Shadow) share the same card row and get their own sidecar-control
// preview (install/start/stop) with the live running-state.

import {
	ArrowDown01Icon,
	BotIcon,
	ComputerIcon,
	Delete02Icon,
	Download01Icon,
	Download04Icon,
	GlobeIcon,
	PackageIcon,
	PlayIcon,
	Settings01Icon,
	Square01Icon,
	Triangle01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import StoreCatalogCard from "@ryu/marketplace/catalog/chrome/store-catalog-card";
import StoreCatalogLayout, {
	StoreCardGrid,
} from "@ryu/marketplace/catalog/chrome/store-catalog-layout";
import StoreItemAction from "@ryu/marketplace/catalog/chrome/store-item-action";
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
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { PluginSettingsFields } from "@/src/components/settings/PluginSettingsFields.tsx";
import { useActiveNodeGetter } from "@/src/hooks/useActiveNode.ts";
import { useApps } from "@/src/hooks/useApps.ts";
import { usePluginSettingsTabs } from "@/src/hooks/usePluginSettingsTabs.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import type { AppInfo } from "@/src/lib/api/plugins.ts";
import {
	fetchSidecarStatus,
	installSidecar,
	setPluginGrants,
	startSidecar,
	stopSidecar,
} from "@/src/lib/api/plugins.ts";
import type { PluginSettingsTab } from "@/src/lib/pluginSettings.ts";
import {
	grantDescription,
	grantLabel,
} from "@/src/lib/plugins/grant-labels.ts";

const AGENT_KIND = "agent";
const SIDECAR_POLL_MS = 5000;

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

function primaryAgentId(app: AppInfo): string | null {
	const entry = app.runnables.find((r) => r.kind === AGENT_KIND);
	return entry?.id ?? null;
}

/** The installed-tab category an app belongs to, derived from what it bundles.
 *  Built-ins are their own "System" group; everything else is keyed by its
 *  dominant runnable kind so the grid reads as one section per kind. */
type InstalledCategory =
	| "apps"
	| "agents"
	| "tools"
	| "skills"
	| "workflows"
	| "channels"
	| "policies"
	| "plugins"
	| "system";

const CATEGORY_ORDER: InstalledCategory[] = [
	"apps",
	"agents",
	"tools",
	"skills",
	"workflows",
	"channels",
	"policies",
	"plugins",
	"system",
];

const CATEGORY_LABELS: Record<InstalledCategory, string> = {
	apps: "Apps",
	agents: "Agents",
	tools: "Tools",
	skills: "Skills",
	workflows: "Workflows",
	channels: "Channels",
	policies: "Policies",
	plugins: "Plugins",
	system: "System",
};

function appCategory(app: AppInfo): InstalledCategory {
	if (app.builtIn) {
		return "system";
	}
	const kinds = new Set(app.runnables.map((r) => r.kind));
	if (kinds.has("companion")) {
		return "apps";
	}
	if (kinds.has("agent")) {
		return "agents";
	}
	if (kinds.has("skill")) {
		return "skills";
	}
	if (kinds.has("workflow")) {
		return "workflows";
	}
	if (kinds.has("channel")) {
		return "channels";
	}
	if (kinds.has("policy")) {
		return "policies";
	}
	if (kinds.has("tool")) {
		return "tools";
	}
	return "plugins";
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

	const [query, setQuery] = useState("");
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [pending, setPending] = useState<Record<string, boolean>>({});
	const [sidecarStatus, setSidecarStatus] = useState<Record<string, boolean>>(
		{}
	);

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
			await uninstall(app.id);
		} finally {
			setPendingFor(app.id, false);
		}
	};

	// Built-in sidecar apps (Ghost/Shadow) have no enable/disable record — their
	// "enabled" IS the sidecar running-state, so the card's Enable/Disable maps to
	// start/stop, then re-polls the live status.
	const handleSidecar = async (app: AppInfo, action: "start" | "stop") => {
		if (!app.sidecarName) {
			return;
		}
		setPendingFor(app.id, true);
		try {
			await (action === "start"
				? startSidecar(target, app.sidecarName)
				: stopSidecar(target, app.sidecarName));
			await pollSidecarStatus();
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

	const visibleApps = useMemo(() => {
		const q = query.trim().toLowerCase();
		if (!q) {
			return apps;
		}
		return apps.filter(
			(a) => a.name.toLowerCase().includes(q) || a.id.toLowerCase().includes(q)
		);
	}, [apps, query]);

	const selectedApp = selectedId
		? (apps.find((a) => a.id === selectedId) ?? null)
		: null;

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

	const sidecarRunning = (app: AppInfo): boolean | undefined =>
		app.sidecarName === null ? undefined : sidecarStatus[app.sidecarName];

	// The Installed tab shows only what is actually installed — a built-in counts
	// once its sidecar reports a running-state, everything else once its record is
	// installed. Not-installed items belong in their catalog tab, not here.
	const isAppInstalled = (app: AppInfo): boolean =>
		app.builtIn ? sidecarRunning(app) !== undefined : app.installed;

	// Group the installed set into one section per category, in a fixed order, so
	// the tab reads as "Apps / Agents / Tools / …" instead of one flat wall.
	const groupedApps = CATEGORY_ORDER.map((category) => ({
		category,
		items: visibleApps.filter(
			(app) => isAppInstalled(app) && appCategory(app) === category
		),
	})).filter((group) => group.items.length > 0);

	const hasInstalled = groupedApps.length > 0;

	// The lifecycle control on each row — the same 3-dot menu the catalog tabs use.
	// Built-ins map Enable/Disable to sidecar start/stop and offer no uninstall;
	// regular apps get Enable/Disable + Uninstall.
	const renderAppAction = (app: AppInfo) => {
		const busy = pending[app.id] ?? false;
		if (app.builtIn) {
			return (
				<StoreItemAction
					busy={busy}
					enabled={sidecarRunning(app) === true}
					installed
					onDisable={() => {
						handleSidecar(app, "stop").catch(() => {
							// Errors surface via the detail panel's state.
						});
					}}
					onEnable={() => {
						handleSidecar(app, "start").catch(() => {
							// Errors surface via the detail panel's state.
						});
					}}
				/>
			);
		}
		return (
			<StoreItemAction
				busy={busy}
				enabled={app.enabled}
				installed
				onDisable={() => {
					handleToggle(app, false).catch(() => {
						// Errors surface via the shared toggleError banner.
					});
				}}
				onEnable={() => {
					handleToggle(app, true).catch(() => {
						// Errors surface via the shared toggleError banner.
					});
				}}
				onUninstall={() => {
					handleUninstall(app).catch(() => {
						// Errors surface via the shared toggleError banner.
					});
				}}
			/>
		);
	};

	return (
		<StoreCatalogLayout
			detail={
				selectedApp ? (
					selectedApp.builtIn ? (
						<BuiltInAppDetail
							app={selectedApp}
							onStatusChange={() =>
								pollSidecarStatus().catch(() => {
									// Best-effort refresh.
								})
							}
							running={sidecarRunning(selectedApp)}
							target={target}
						/>
					) : (
						<InstalledAppDetail
							app={selectedApp}
							busy={pending[selectedApp.id] ?? false}
							displayName={displayName}
							onClearToggleError={clearToggleError}
							onGrantsChanged={reload}
							onInstall={handleInstall}
							onLaunch={handleLaunch}
							onToggle={handleToggle}
							onUninstall={handleUninstall}
							settingsTabs={settingsByPlugin.get(selectedApp.id) ?? []}
							target={target}
							toggleError={toggleError}
						/>
					)
				) : null
			}
			detailTitle={selectedApp?.name ?? "App"}
			hasSelection={selectedApp != null}
			list={
				<div className="flex flex-col gap-4 pt-2">
					{toggleError ? (
						<div className="flex items-start justify-between gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-destructive text-sm">
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

					{hasInstalled ? (
						groupedApps.map((group) => (
							<section className="flex flex-col gap-2" key={group.category}>
								<h3 className="px-1 font-medium text-muted-foreground text-xs uppercase tracking-wide">
									{CATEGORY_LABELS[group.category]}
								</h3>
								<StoreCardGrid>
									{group.items.map((app) => (
										<StoreCatalogCard
											action={renderAppAction(app)}
											description={
												app.builtIn ? "Built-in system app." : `v${app.version}`
											}
											icon={
												<HugeiconsIcon className="size-5" icon={ComputerIcon} />
											}
											key={app.id}
											name={app.name}
											onClick={() => setSelectedId(app.id)}
											seedId={app.id}
											selected={app.id === selectedId}
										/>
									))}
								</StoreCardGrid>
							</section>
						))
					) : (
						<Empty className="py-10">
							<EmptyHeader>
								<EmptyMedia variant="icon">
									<HugeiconsIcon icon={PackageIcon} />
								</EmptyMedia>
								<EmptyTitle>
									{query.trim() ? "No matches" : "Nothing installed yet"}
								</EmptyTitle>
								<EmptyDescription>
									{query.trim()
										? "Try a different search."
										: "Plugins, agents, and tools you install from the store show up here."}
								</EmptyDescription>
							</EmptyHeader>
						</Empty>
					)}
				</div>
			}
			onCloseDetail={() => setSelectedId(null)}
			search={{
				value: query,
				onChange: setQuery,
				placeholder: "Search installed…",
			}}
		/>
	);
}

// The per-plugin "Settings" disclosure: a toggle button that expands the fields
// the plugin declared in its manifest (`contributes.settings_tabs`), each
// persisted under its own preference key.
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
// app's APPROVED set; toggling it POSTs the new subset to `/api/plugins/:id/grants`.
// When disabled the grants are read-only (grant editing requires an enabled app).
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
		<section className="flex flex-col gap-2">
			<h3 className="font-medium text-sm">Permissions</h3>
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
				<p className="text-muted-foreground text-xs">
					Enable this app to change its permissions.
				</p>
			)}
		</section>
	);
}

interface InstalledAppDetailProps {
	app: AppInfo;
	busy: boolean;
	displayName: (id: string) => string;
	onClearToggleError: () => void;
	onGrantsChanged: () => void;
	onInstall: (app: AppInfo) => Promise<void>;
	onLaunch: (app: AppInfo) => void;
	onToggle: (app: AppInfo, checked: boolean) => Promise<void>;
	onUninstall: (app: AppInfo) => Promise<void>;
	settingsTabs: PluginSettingsTab[];
	target: ApiTarget;
	toggleError: string | null;
}

function InstalledAppDetail({
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
	toggleError,
	onClearToggleError,
}: InstalledAppDetailProps) {
	const isInstalled = app.installed;
	const agentId = primaryAgentId(app);
	const hasSettings = isInstalled && settingsTabs.length > 0;
	const dependencies = app.requires?.apps ?? [];
	const [confirmUninstall, setConfirmUninstall] = useState(false);

	return (
		<div className="flex flex-col gap-6 p-4">
			<header className="flex flex-col gap-3">
				<div className="flex items-start justify-between gap-3 pr-8">
					<div className="min-w-0">
						<h2 className="truncate font-semibold text-xl">{app.name}</h2>
						<p className="text-muted-foreground text-sm">v{app.version}</p>
					</div>
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
				<div className="flex flex-wrap items-center gap-1">
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
				</div>

				{toggleError ? (
					<div className="flex items-start justify-between gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-destructive text-sm">
						<span>{toggleError}</span>
						<button
							className="shrink-0 font-medium underline-offset-2 hover:underline"
							onClick={onClearToggleError}
							type="button"
						>
							Dismiss
						</button>
					</div>
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
							variant="default"
						>
							{busy ? (
								<Spinner className="size-4" />
							) : (
								<HugeiconsIcon className="size-4" icon={Download04Icon} />
							)}
							Install
						</Button>
					)}
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
			</header>

			{/* Bundled Runnable kinds */}
			{app.runnables.length > 0 ? (
				<section className="flex flex-col gap-2">
					<h3 className="font-medium text-sm">Bundles</h3>
					<div className="flex flex-wrap gap-1">
						{app.runnables.map((r) => (
							<Badge key={r.id} variant="secondary">
								{KIND_LABELS[r.kind] ?? r.kind} — {r.name}
							</Badge>
						))}
					</div>
				</section>
			) : null}

			{/* Plugin-to-plugin dependencies (`requires.apps`). */}
			{dependencies.length > 0 ? (
				<section className="flex flex-col gap-2">
					<h3 className="font-medium text-sm">Requires</h3>
					<div className="flex flex-wrap gap-1">
						{dependencies.map((dep) => (
							<Badge key={dep.id} variant="secondary">
								{displayName(dep.id)}
								{dep.minVersion ? ` ${dep.minVersion}+` : ""}
							</Badge>
						))}
					</div>
					<p className="text-muted-foreground text-xs">
						Enabling {app.name} enables these first.
					</p>
				</section>
			) : null}

			{/* Permission grants, in plain English, with per-grant revoke toggles. */}
			{app.permissionGrants.length > 0 ? (
				<PermissionsEditor
					app={app}
					onGrantsChanged={onGrantsChanged}
					target={target}
				/>
			) : null}

			{/* Inline plugin settings — the fields the plugin declared in its manifest. */}
			{hasSettings ? (
				<section className="flex flex-col gap-2">
					<InstalledAppSettings settingsTabs={settingsTabs} target={target} />
				</section>
			) : null}

			<code className="truncate rounded bg-muted px-2 py-1 text-muted-foreground text-xs">
				{app.id}
			</code>

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
		</div>
	);
}

// Built-in system apps (Ghost, Shadow) whose lifecycle is sidecar-based rather
// than App-store lifecycle. The preview carries Install → Start → Stop against the
// live running-state polled by the parent.
type SidecarAction = "install" | "start" | "stop";

function BuiltInAppDetail({
	app,
	running,
	target,
	onStatusChange,
}: {
	app: AppInfo;
	running: boolean | undefined;
	target: ApiTarget;
	onStatusChange: () => void;
}) {
	const [pending, setPending] = useState<SidecarAction | null>(null);
	const [actionError, setActionError] = useState<string | null>(null);

	const sidecarName = app.sidecarName;
	const isConfigured = sidecarName !== null;
	const isInstalled = running !== undefined;
	const isRunning = running === true;

	const run = async (
		action: SidecarAction,
		call: (target: ApiTarget, name: string) => Promise<unknown>
	) => {
		if (!isConfigured || pending !== null) {
			return;
		}
		setActionError(null);
		setPending(action);
		try {
			await call(target, sidecarName as string);
			onStatusChange();
		} catch (e) {
			setActionError(
				e instanceof Error ? e.message : `Failed to ${action} sidecar`
			);
		} finally {
			setPending(null);
		}
	};

	return (
		<div className="flex flex-col gap-6 p-4">
			<header className="flex flex-col gap-3">
				<div className="pr-8">
					<h2 className="truncate font-semibold text-xl">{app.name}</h2>
					<p className="text-muted-foreground text-sm">v{app.version}</p>
				</div>
				<div className="flex flex-wrap items-center gap-1">
					<Badge variant="secondary">Built-in</Badge>
					{app.windowsFirst ? (
						<Badge className="gap-1" variant="secondary">
							<HugeiconsIcon className="size-3" icon={ComputerIcon} />
							Windows-first
						</Badge>
					) : null}
					{app.localOnly ? (
						<Badge className="gap-1" variant="secondary">
							<HugeiconsIcon className="size-3" icon={GlobeIcon} />
							Local only
						</Badge>
					) : null}
					{isInstalled ? (
						<Badge variant={isRunning ? "default" : "secondary"}>
							{isRunning ? "Running" : "Stopped"}
						</Badge>
					) : (
						<Badge variant="secondary">Not installed</Badge>
					)}
				</div>

				{actionError ? (
					<p className="text-destructive text-sm">{actionError}</p>
				) : null}

				<div className="flex flex-wrap gap-2">
					{isInstalled ? null : (
						<Button
							disabled={pending !== null || !isConfigured}
							onClick={() => run("install", installSidecar)}
							size="sm"
							variant="default"
						>
							{pending === "install" ? (
								<Spinner className="size-4" />
							) : (
								<HugeiconsIcon className="size-4" icon={Download01Icon} />
							)}
							Install
						</Button>
					)}
					{isInstalled && !isRunning ? (
						<Button
							disabled={pending !== null}
							onClick={() => run("start", startSidecar)}
							size="sm"
							variant="default"
						>
							{pending === "start" ? (
								<Spinner className="size-4" />
							) : (
								<HugeiconsIcon className="size-4" icon={Triangle01Icon} />
							)}
							Start
						</Button>
					) : null}
					{isInstalled && isRunning ? (
						<Button
							disabled={pending !== null}
							onClick={() => run("stop", stopSidecar)}
							size="sm"
							variant="outline"
						>
							{pending === "stop" ? (
								<Spinner className="size-4" />
							) : (
								<HugeiconsIcon className="size-4" icon={Square01Icon} />
							)}
							Stop
						</Button>
					) : null}
				</div>
			</header>

			<section className="flex flex-col gap-2">
				<h3 className="font-medium text-sm">Includes</h3>
				<p className="text-muted-foreground text-sm">
					{app.runnables.length === 0
						? "No runnables."
						: app.runnables.map((r) => `${r.name} (${r.kind})`).join(" · ")}
				</p>
			</section>

			{app.permissionGrants.length > 0 ? (
				<section className="flex flex-col gap-2">
					<h3 className="font-medium text-sm">Permissions</h3>
					<p className="font-mono text-muted-foreground text-xs">
						{app.permissionGrants.join(", ")}
					</p>
				</section>
			) : null}

			<code className="truncate rounded bg-muted px-2 py-1 text-muted-foreground text-xs">
				{app.id}
			</code>
		</div>
	);
}
