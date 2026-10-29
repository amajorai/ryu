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
	ComputerIcon,
	Delete02Icon,
	Download01Icon,
	Download04Icon,
	PackageIcon,
	PlayIcon,
	Settings01Icon,
	Square01Icon,
	Triangle01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Markdown } from "@ryu/blocks/desktop/agent-elements/markdown.tsx";
import DeprecationNotice from "@ryu/marketplace/catalog/chrome/deprecation-notice";
import StoreCatalogCard from "@ryu/marketplace/catalog/chrome/store-catalog-card";
import StoreCatalogLayout, {
	StoreCardGrid,
} from "@ryu/marketplace/catalog/chrome/store-catalog-layout";
import StoreItemAction, {
	StoreItemOverflowMenu,
	storeItemContextMenu,
} from "@ryu/marketplace/catalog/chrome/store-item-action";
import StoreShelfHeading from "@ryu/marketplace/catalog/chrome/store-shelf-heading";
import {
	DEPRECATED_LABEL,
	isDeprecated,
	resolveDeprecation,
} from "@ryu/marketplace/catalog/deprecation";
import { RequiredPluginsSection } from "@ryu/marketplace/catalog/detail/dependency-graph";
import {
	ListingAsideCard,
	ListingDetailShell,
	ListingHero,
	ListingInfoGrid,
	ListingSection,
	ListingStatStrip,
} from "@ryu/marketplace/catalog/detail/listing-detail-shell";
import { ListingDetailTabs } from "@ryu/marketplace/catalog/detail/listing-detail-tabs";
import { iconCacheKey } from "@ryu/marketplace/catalog/icon-cache";
import { runScorecard } from "@ryu/marketplace/catalog/scorecard";
import {
	type CatalogEntry,
	catalogLayerBadges,
} from "@ryu/marketplace/catalog/types";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@ryu/ui/components/alert-dialog.tsx";
import { Badge } from "@ryu/ui/components/badge.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import { Checkbox } from "@ryu/ui/components/checkbox.tsx";
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@ryu/ui/components/empty.tsx";
import { toast } from "@ryu/ui/components/sileo.tsx";
import { SkeletonRows } from "@ryu/ui/components/skeleton.tsx";
import { StatusBadge } from "@ryu/ui/components/status-badge.tsx";
import { Switch } from "@ryu/ui/components/switch.tsx";
import { formatCount } from "@ryu/ui/lib/number-format.ts";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useContext, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
	StandaloneAppContextMenuItems,
	StandaloneAppDropdownMenuItems,
} from "@/src/components/apps/standalone-app-menu.tsx";
import { OAuthConnections } from "@/src/components/marketplace/ConnectionsTab.tsx";
import { PluginSettingsFields } from "@/src/components/settings/PluginSettingsFields.tsx";
import { TabsContext } from "@/src/contexts/TabsContext.tsx";
import { useActiveNodeGetter } from "@/src/hooks/useActiveNode.ts";
import { useApps } from "@/src/hooks/useApps.ts";
import { usePluginSettingsOpener } from "@/src/hooks/usePluginSettingsOpener.ts";
import { usePluginSettingsTabs } from "@/src/hooks/usePluginSettingsTabs.ts";
import { useStandaloneApps } from "@/src/hooks/useStandaloneApps.ts";
import { runCatalogScan } from "@/src/lib/api/catalog-scan.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	APP_LIFECYCLE_PERMISSIONS,
	type AppInfo,
	type AppLifecycleCapabilities,
	fetchAppLifecycleCapabilities,
	fetchPluginCatalogDetail,
	fetchPluginDoctor,
	fetchSidecarDetails,
	installSidecar,
	type PluginDoctorReport,
	type SidecarSandboxStatus,
	startSidecar,
	stopSidecar,
} from "@/src/lib/api/plugins.ts";
import type { PluginSettingsTab } from "@/src/lib/pluginSettings.ts";
import { AppPermissionsEditor as PermissionsEditor } from "./AppPermissionsEditor.tsx";
import { InstalledPluginEvalCard } from "./InstalledPluginEvalCard.tsx";

const AGENT_KIND = "agent";
const SIDECAR_POLL_MS = 5000;

const KIND_LABELS = new Map<string, string>([
	["agent", "Agent"],
	["workflow", "Workflow"],
	["tool", "Tool"],
	["skill", "Skill"],
	["companion", "Companion"],
	["channel", "Channel"],
	["engine", "Engine"],
	["policy", "Policy"],
]);

function primaryAgentId(app: AppInfo): string | null {
	const entry = app.runnables.find((r) => r.kind === AGENT_KIND);
	return entry?.id ?? null;
}

/** The version that is ACTUALLY ON THIS MACHINE.
 *
 *  `app.version` is the MANIFEST's version — for an install that has fallen behind
 *  its manifest that is the newer number, so a card rendering it claims a version
 *  the user does not have. The lifecycle record's `installedVersion` is the truth,
 *  and it is null for a built-in (which has no record) and for anything not yet
 *  installed — hence coalesce, never swap. */
function installedVersionOf(app: AppInfo): string {
	return app.installedVersion ?? app.version;
}

/** The one-line card description.
 *
 *  `tagline` is the manifest's short pitch and `description` its long
 *  plaintext/markdown body; the card slot truncates to a single line, so the
 *  tagline wins and the description is only a fallback. Before this the slot
 *  carried the version string — which the stat strip already states twice — so
 *  every installed row read "v1.0.0" and said nothing about what the app does. */
function cardDescription(app: AppInfo): string | null {
	const text = app.tagline?.trim() || app.description?.trim();
	if (text) {
		return text;
	}
	return app.builtIn ? "Built-in system app." : null;
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

const CATEGORY_LABELS = {
	apps: "Apps",
	agents: "Agents",
	tools: "Tools",
	skills: "Skills",
	workflows: "Workflows",
	channels: "Channels",
	policies: "Policies",
	plugins: "Plugins",
	system: "System",
} satisfies Record<InstalledCategory, string>;

function appCategory(app: AppInfo): InstalledCategory {
	// "System" is exactly what Core refuses to uninstall (`app.system`), plus the
	// sidecar-managed built-ins that have no lifecycle record of their own.
	if (app.builtIn || app.system) {
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

const LIFECYCLE_LABELS = {
	"app.disable": "Disable",
	"app.enable": "Enable",
	"app.install": "Install",
	"app.uninstall": "Uninstall",
	"app.update": "Update",
} satisfies Record<(typeof APP_LIFECYCLE_PERMISSIONS)[number], string>;

function LifecycleAccessCard({
	capabilities,
	error,
	loading,
}: {
	capabilities: AppLifecycleCapabilities | null;
	error: Error | null;
	loading: boolean;
}) {
	const node = capabilities?.node;
	return (
		<section
			aria-label="App lifecycle access"
			className="rounded-lg border bg-card/60 px-4 py-3"
			data-testid="app-lifecycle-access"
		>
			<div className="flex items-start justify-between gap-3">
				<div>
					<p className="font-medium text-sm">Lifecycle access</p>
					<p className="text-muted-foreground text-xs">
						{loading
							? "Checking this node’s ACL…"
							: node
								? `${node.scope} node · ${node.id}`
								: "Local node · server ACL not bound"}
					</p>
				</div>
				<Badge variant="outline">Server-authoritative</Badge>
			</div>
			{error ? (
				<p className="mt-3 text-status-destructive text-xs">
					Lifecycle access is unavailable; the server will still enforce every
					action.
				</p>
			) : capabilities ? (
				<div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-5">
					{APP_LIFECYCLE_PERMISSIONS.map((permission) => {
						const allowed = capabilities.permissions[permission] === true;
						return (
							<div className="min-w-0" key={permission}>
								<p className="truncate text-xs">
									{LIFECYCLE_LABELS[permission]}
								</p>
								<p
									className={
										allowed
											? "text-status-success text-xs"
											: "text-muted-foreground text-xs"
									}
								>
									{allowed
										? "Allowed"
										: (capabilities.reasons?.[permission] ?? "Not allowed")}
								</p>
							</div>
						);
					})}
				</div>
			) : null}
		</section>
	);
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
		userJwt: activeNode.userJwt ?? null,
	};
	const lifecycleCapabilities = useQuery({
		queryFn: () => fetchAppLifecycleCapabilities(target),
		queryKey: ["plugins", "lifecycle-capabilities", activeNode.url],
		staleTime: 30_000,
	});
	const { byPlugin: settingsByPlugin } = usePluginSettingsTabs();
	const {
		install: installStandalone,
		installedAppIds,
		open: openStandalone,
		uninstall: uninstallStandalone,
	} = useStandaloneApps();
	// Where each row's settings live (Gateway dialog vs App Settings, at its own
	// tab). Resolved once for the whole list and read per row below.
	const settingsOpener = usePluginSettingsOpener();

	const [query, setQuery] = useState("");
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [pending, setPending] = useState<Record<string, boolean>>({});
	const [sidecarStatus, setSidecarStatus] = useState<Record<string, boolean>>(
		{}
	);
	const [sidecarSandbox, setSidecarSandbox] = useState<
		Record<string, SidecarSandboxStatus>
	>({});

	const pollSidecarStatus = useCallback(async () => {
		const node = getActiveNode();
		const nodeTarget: ApiTarget = {
			url: node.url,
			token: node.token,
			userJwt: node.userJwt ?? null,
		};
		try {
			const details = await fetchSidecarDetails(nodeTarget);
			const running: Record<string, boolean> = {};
			const sandbox: Record<string, SidecarSandboxStatus> = {};
			for (const [name, detail] of Object.entries(details)) {
				running[name] = detail.running;
				if (detail.sandbox) {
					sandbox[name] = detail.sandbox;
				}
			}
			setSidecarStatus(running);
			setSidecarSandbox(sandbox);
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

	const handleUninstall = async (
		app: AppInfo,
		options?: { deleteStorage?: boolean }
	) => {
		setPendingFor(app.id, true);
		try {
			await uninstall(app.id, options);
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

	const standaloneTarget = (app: AppInfo) => ({
		appId: app.id,
		name: app.name,
		version: app.installedVersion ?? app.version,
	});

	const handleInstallStandalone = async (app: AppInfo) => {
		try {
			const appTarget = standaloneTarget(app);
			await installStandalone(appTarget);
			await openStandalone(appTarget);
			toast.success("Standalone app installed", {
				description: `${app.name} now opens in its own window and keeps using the same Ryu data.`,
			});
		} catch (error) {
			toast.error("Couldn't install the standalone app", {
				description:
					error instanceof Error ? error.message : "Please try again.",
			});
		}
	};

	const handleOpenStandalone = async (app: AppInfo) => {
		try {
			await openStandalone(standaloneTarget(app));
		} catch (error) {
			toast.error("Couldn't open the standalone app", {
				description:
					error instanceof Error ? error.message : "Please try again.",
			});
		}
	};

	const handleRemoveStandalone = async (app: AppInfo) => {
		try {
			await uninstallStandalone(app.id);
			toast.success("Standalone app removed", {
				description: `${app.name} is still installed inside Ryu with all of its data.`,
			});
		} catch (error) {
			toast.error("Couldn't remove the standalone app", {
				description:
					error instanceof Error ? error.message : "Please try again.",
			});
		}
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
		return <SkeletonRows rows={6} spacing="library" />;
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
	const standaloneEnabled = (app: AppInfo): boolean =>
		app.builtIn && app.sidecarName ? sidecarRunning(app) === true : app.enabled;

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
		const standaloneMenu = {
			enabled: standaloneEnabled(app),
			hasCompanion: app.runnables.some(
				(runnable) => runnable.kind === "companion"
			),
			installed: installedAppIds.has(app.id),
			onInstall: () => {
				handleInstallStandalone(app).catch(() => {
					// The handler already surfaces the error.
				});
			},
			onOpen: () => {
				handleOpenStandalone(app).catch(() => {
					// The handler already surfaces the error.
				});
			},
			onRemove: () => {
				handleRemoveStandalone(app).catch(() => {
					// The handler already surfaces the error.
				});
			},
		};
		// Where this row's own settings live, or null when it declares none. Passed
		// to every branch below — including the mandatory one, whose lifecycle verbs
		// are all refused but whose settings are still perfectly reachable.
		const openSettings = settingsOpener(app.id) ?? undefined;
		// Required for Core: no lifecycle menu, because every verb in it (disable,
		// uninstall) is refused server-side. A static badge states the fact instead
		// of offering three actions that all end in the same 403.
		if (app.mandatory) {
			return (
				<div className="flex shrink-0 items-center gap-1">
					<Badge variant="secondary">Required</Badge>
					<StoreItemOverflowMenu
						extra={<StandaloneAppDropdownMenuItems {...standaloneMenu} />}
						onOpenSettings={openSettings}
					/>
				</div>
			);
		}
		if (app.builtIn) {
			return (
				<StoreItemAction
					busy={busy}
					enabled={sidecarRunning(app) === true}
					extra={<StandaloneAppDropdownMenuItems {...standaloneMenu} />}
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
					onOpenSettings={openSettings}
				/>
			);
		}
		return (
			<StoreItemAction
				busy={busy}
				enabled={app.enabled}
				extra={<StandaloneAppDropdownMenuItems {...standaloneMenu} />}
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
				onOpenSettings={openSettings}
				// Core refuses to uninstall a system app; offer no Remove for it.
				onUninstall={
					app.system
						? undefined
						: () => {
								handleUninstall(app).catch(() => {
									// Errors surface via the shared toggleError banner.
								});
							}
				}
				reportTarget={{
					id: app.id,
					kind: "plugin",
					itemName: app.name,
					source: "installed",
				}}
			/>
		);
	};

	/** The card's right-click rows — the same three branches `renderAppAction`
	 *  takes. This surface lists ONLY installed apps, so before this the gesture
	 *  did nothing anywhere on the page. */
	const appContextMenu = (app: AppInfo) => {
		const openSettings = settingsOpener(app.id) ?? undefined;
		const standaloneMenu = {
			enabled: standaloneEnabled(app),
			hasCompanion: app.runnables.some(
				(runnable) => runnable.kind === "companion"
			),
			installed: installedAppIds.has(app.id),
			onInstall: () => {
				handleInstallStandalone(app).catch(() => {
					// The handler already surfaces the error.
				});
			},
			onOpen: () => {
				handleOpenStandalone(app).catch(() => {
					// The handler already surfaces the error.
				});
			},
			onRemove: () => {
				handleRemoveStandalone(app).catch(() => {
					// The handler already surfaces the error.
				});
			},
		};
		if (app.mandatory) {
			return storeItemContextMenu({
				extra: <StandaloneAppContextMenuItems {...standaloneMenu} />,
				installed: true,
				locked: true,
				onOpenSettings: openSettings,
			});
		}
		if (app.builtIn) {
			return storeItemContextMenu({
				enabled: sidecarRunning(app) === true,
				extra: <StandaloneAppContextMenuItems {...standaloneMenu} />,
				installed: true,
				onDisable: () => {
					handleSidecar(app, "stop").catch(() => {
						// Errors surface via the detail panel's state.
					});
				},
				onEnable: () => {
					handleSidecar(app, "start").catch(() => {
						// Errors surface via the detail panel's state.
					});
				},
				onOpenSettings: openSettings,
			});
		}
		return storeItemContextMenu({
			enabled: app.enabled,
			extra: <StandaloneAppContextMenuItems {...standaloneMenu} />,
			installed: true,
			onDisable: () => {
				handleToggle(app, false).catch(() => {
					// Errors surface via the shared toggleError banner.
				});
			},
			onEnable: () => {
				handleToggle(app, true).catch(() => {
					// Errors surface via the shared toggleError banner.
				});
			},
			onOpenSettings: openSettings,
			onUninstall: app.system
				? undefined
				: () => {
						handleUninstall(app).catch(() => {
							// Errors surface via the shared toggleError banner.
						});
					},
		});
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
							onClearToggleError={clearToggleError}
							onGrantsChanged={reload}
							onInstall={handleInstall}
							onLaunch={handleLaunch}
							onToggle={handleToggle}
							onUninstall={handleUninstall}
							sandbox={appSandboxStatus(selectedApp.id, sidecarSandbox)}
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
					<LifecycleAccessCard
						capabilities={lifecycleCapabilities.data ?? null}
						error={lifecycleCapabilities.error}
						loading={lifecycleCapabilities.isLoading}
					/>
					{toggleError ? (
						<div className="flex items-start justify-between gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-status-destructive">
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
								{/* `mb-0`: the section is already a `gap-2` column, so the
								    heading's own bottom margin would stack on top of it. */}
								<StoreShelfHeading className="mb-0">
									{CATEGORY_LABELS[group.category]}
								</StoreShelfHeading>
								<StoreCardGrid>
									{group.items.map((app) => (
										<StoreCatalogCard
											action={renderAppAction(app)}
											cacheKey={iconCacheKey(app.id, installedVersionOf(app))}
											contextMenu={appContextMenu(app)}
											deprecated={isDeprecated(app.deprecated)}
											description={cardDescription(app)}
											dither={app.iconDither}
											external={app.external}
											icon={
												<HugeiconsIcon className="size-5" icon={ComputerIcon} />
											}
											iconBackground={app.iconBackground ?? undefined}
											iconId={app.icon}
											iconPadding={app.iconPadding}
											iconUrl={app.iconUrl}
											key={app.id}
											layers={app.layers}
											name={app.name}
											onClick={() => setSelectedId(app.id)}
											seedId={app.id}
											selected={app.id === selectedId}
											stability={app.stability}
										/>
									))}
								</StoreCardGrid>
							</section>
						))
					) : (
						<Empty spacing="comfortable">
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
							<EmptyContent>
								<Button
									onClick={() => {
										if (query.trim()) {
											setQuery("");
											return;
										}
										navigate("/store");
									}}
									size="sm"
								>
									{query.trim() ? "Clear search" : "Browse the Store"}
								</Button>
							</EmptyContent>
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

interface InstalledAppDetailProps {
	app: AppInfo;
	busy: boolean;
	onClearToggleError: () => void;
	onGrantsChanged: () => void;
	onInstall: (app: AppInfo) => Promise<void>;
	onLaunch: (app: AppInfo) => void;
	onToggle: (app: AppInfo, checked: boolean) => Promise<void>;
	onUninstall: (
		app: AppInfo,
		options?: { deleteStorage?: boolean }
	) => Promise<void>;
	/** OS isolation of the app's sidecar process(es); null when it has none. */
	sandbox: SidecarSandboxStatus | null;
	settingsTabs: PluginSettingsTab[];
	target: ApiTarget;
	toggleError: string | null;
}

const SANDBOX_BACKEND_LABELS = new Map<string, string>([
	["landlock", "Landlock"],
	["seatbelt", "Seatbelt"],
	["job_object", "Job Object"],
]);

/** How strongly a status confines its process, for picking the weakest. */
function sandboxStrength(status: SidecarSandboxStatus): number {
	if (status.fsRestricted) {
		return 2;
	}
	return status.enforced ? 1 : 0;
}

/** The least-confined OS isolation among an app's sidecars (keyed
 *  `<plugin_id>/<sidecar>`), so the detail never overstates the protection. */
function appSandboxStatus(
	appId: string,
	statuses: Record<string, SidecarSandboxStatus>
): SidecarSandboxStatus | null {
	let weakest: SidecarSandboxStatus | null = null;
	for (const [name, status] of Object.entries(statuses)) {
		if (!name.startsWith(`${appId}/`)) {
			continue;
		}
		if (
			weakest === null ||
			sandboxStrength(status) < sandboxStrength(weakest)
		) {
			weakest = status;
		}
	}
	return weakest;
}

/** A short "OS sandbox" value for the app's Information card. */
function sandboxLabel(status: SidecarSandboxStatus): string {
	const backend = SANDBOX_BACKEND_LABELS.get(status.backend) ?? status.backend;
	if (status.mode === "off") {
		return "Off";
	}
	if (status.mode === "audit") {
		return "Audit only";
	}
	if (status.fsRestricted) {
		return `Enforced · ${backend}`;
	}
	return status.enforced ? `${backend} · no file limits` : "Unavailable";
}

/** The catalog entry an installed app maps onto, so the shared detail tabs can
 *  grade and render it exactly as the store does.
 *
 *  Only the five fields `CatalogEntry` requires are synthesised; everything the
 *  tabs actually read (README, versions, permissions, licence…) comes from the
 *  DETAIL fetch, not from here. Kept deliberately thin rather than fabricating
 *  plausible-looking values — a made-up description or tag would be graded by the
 *  scorecard as if the listing had declared it.
 *
 *  `description` is the one field that stopped being a synthesis: the manifest
 *  declares it and Core has always serialised it, so passing it through grades the
 *  listing on what it actually says. `tags` stays empty — no manifest field backs
 *  it, so anything here would be invented. */
function installedAppAsEntry(app: AppInfo): CatalogEntry {
	return {
		description: app.description ?? app.tagline ?? "",
		id: app.id,
		kinds: [...new Set(app.runnables.map((r) => r.kind))],
		name: app.name,
		surface_support: app.surfaceSupport,
		// The one exception to "synthesise nothing": the installed record IS the
		// authority on what this app requires, and the catalog detail is not — Core's
		// catalog source only emits `requires` when it has it, which is why
		// `useAppsCatalog` falls back to the record too. Carried as `apps` only:
		// `requires.grants` feeds the scorecard's permission-breadth check, and a
		// synthesised value there would grade a listing on a field it never declared.
		requires: app.requires
			? {
					apps: app.requires.apps.map((dep) => ({
						id: dep.id,
						min_version: dep.minVersion,
					})),
				}
			: null,
		tags: [],
		version: app.version,
	};
}

/** README / API / Versions / Dependencies / Reviews / Health for an INSTALLED
 *  app — the same tabs the store shows.
 *
 *  Installing an app used to make its documentation disappear: the store rendered
 *  the full tabbed panel, and Store → Installed rendered a separate view with none
 *  of it. Fetched lazily and rendered only once it resolves, so the lifecycle
 *  controls above are never blocked on a network round-trip.
 *
 *  A local-only app has no catalog listing and so no tabs — but its dependency
 *  chain comes off the installed record, not the catalog, so that one section is
 *  rendered on its own rather than lost with the rest. */
function InstalledAppTabs({
	app,
	target,
}: {
	app: AppInfo;
	target: ApiTarget;
}) {
	const entry = useMemo(() => installedAppAsEntry(app), [app]);
	const { data: detail } = useQuery({
		enabled: Boolean(app.id),
		queryFn: () => fetchPluginCatalogDetail(target, app.id),
		queryKey: ["plugins", "detail", "installed", app.id],
		// A local-only app has no catalog listing; that is expected, not an error.
		retry: false,
		staleTime: 5 * 60 * 1000,
	});
	const tabsHost = useContext(TabsContext);
	const scorecard = useMemo(
		() => (detail ? runScorecard(entry, detail) : null),
		[detail, entry]
	);
	const doctorQuery = useQuery({
		enabled: false,
		queryFn: () => fetchPluginDoctor(target, app.id),
		queryKey: ["plugins", "doctor", app.id],
	});
	if (!detail) {
		return (
			<div className="flex flex-col gap-4">
				<RequiredPluginsSection
					apps={entry.requires?.apps ?? []}
					subjectId={app.id}
					subjectName={app.name}
				/>
				<InstalledDoctorCard
					onRun={() => {
						void doctorQuery.refetch();
					}}
					report={doctorQuery.data ?? null}
					running={doctorQuery.isFetching}
				/>
				<InstalledPluginEvalCard appId={app.id} target={target} />
			</div>
		);
	}
	return (
		<ListingDetailTabs
			agentScan={
				scorecard
					? () =>
							runCatalogScan(target, {
								description: detail.description ?? entry.description,
								id: entry.id,
								kind: "app",
								metadata: {
									source: detail.source,
									url: detail.url,
								},
								name: entry.name,
								scorecard,
							})
					: undefined
			}
			detail={detail}
			developerDoctor={
				<InstalledDoctorCard
					onRun={() => {
						void doctorQuery.refetch();
					}}
					report={doctorQuery.data ?? null}
					running={doctorQuery.isFetching}
				/>
			}
			developerEvals={
				<InstalledPluginEvalCard appId={app.id} target={target} />
			}
			entry={entry}
			key={target.url}
			Markdown={Markdown}
			onOpenAuditConversation={
				tabsHost
					? (conversationId) => tabsHost.openTab("/chat", { conversationId })
					: undefined
			}
			scorecard={scorecard}
		/>
	);
}

function InstalledDoctorCard({
	onRun,
	report,
	running,
}: {
	onRun: () => void;
	report: PluginDoctorReport | null;
	running: boolean;
}) {
	return (
		<section
			className="flex flex-col gap-3 rounded-lg border border-primary/25 bg-primary/5 p-4"
			data-testid="plugin-runtime-doctor"
		>
			<div className="flex flex-wrap items-start justify-between gap-3">
				<div>
					<h3 className="font-medium text-sm">Run runtime doctor</h3>
					<p className="mt-1 text-muted-foreground text-xs leading-relaxed">
						Checks the loaded manifest, lifecycle record, dependencies, grants,
						and contribution shape. It is read-only and does not execute plugin
						code or start a sidecar.
					</p>
				</div>
				<Button loading={running} onClick={onRun} size="sm">
					{running ? "Checking" : "Run doctor"}
				</Button>
			</div>
			{report ? (
				<div className="space-y-2 text-xs">
					<div className="flex flex-wrap items-center gap-2">
						<Badge variant="outline">{report.score}/100</Badge>
						<span className="text-muted-foreground">
							{formatCount(report.counts.errors) ?? "—"} errors ·{" "}
							{formatCount(report.counts.warnings) ?? "—"} warnings
						</span>
					</div>
					{report.findings.length > 0 ? (
						<ul className="space-y-1.5">
							{report.findings.slice(0, 5).map((finding) => (
								<li
									className="rounded-md bg-background px-3 py-2"
									key={finding.checkId}
								>
									<p className="font-medium">
										{finding.severity} · {finding.summary}
									</p>
									<p className="mt-0.5 text-muted-foreground">
										{finding.detail}
									</p>
								</li>
							))}
						</ul>
					) : (
						<p className="text-status-success">
							Healthy — no runtime findings.
						</p>
					)}
				</div>
			) : null}
		</section>
	);
}

function InstalledAppDetail({
	app,
	busy,
	onInstall,
	onLaunch,
	onToggle,
	onUninstall,
	onGrantsChanged,
	sandbox,
	settingsTabs,
	target,
	toggleError,
	onClearToggleError,
}: InstalledAppDetailProps) {
	const isInstalled = app.installed;
	const agentId = primaryAgentId(app);
	const hasSettings = isInstalled && settingsTabs.length > 0;
	const [confirmUninstall, setConfirmUninstall] = useState(false);
	const deprecation = resolveDeprecation(null, app.deprecated);
	const [deleteStorage, setDeleteStorage] = useState(false);
	const handleConfirmOpenChange = (open: boolean) => {
		setConfirmUninstall(open);
		if (!open) {
			setDeleteStorage(false);
		}
	};

	return (
		<ListingDetailShell
			actions={
				<>
					{app.enabled && agentId ? (
						<Button onClick={() => onLaunch(app)} size="sm" variant="default">
							<HugeiconsIcon className="size-4" icon={PlayIcon} />
							Launch
						</Button>
					) : null}
					{isInstalled ? null : (
						<Button
							disabled={busy}
							loading={busy}
							onClick={() => onInstall(app)}
							size="sm"
							variant="ghost"
						>
							{busy ? null : (
								<HugeiconsIcon className="size-4" icon={Download04Icon} />
							)}
							Add
						</Button>
					)}
					{isInstalled && !(app.mandatory || app.system) ? (
						<Button
							appearance="dictation-recording"
							disabled={busy}
							onClick={() => setConfirmUninstall(true)}
							size="sm"
							variant="ghost"
						>
							<HugeiconsIcon className="size-4" icon={Delete02Icon} />
							Remove
						</Button>
					) : null}
					{/* A mandatory app gets no toggle at all. Core refuses the disable
					    with a 403 and no force override, so a switch here could only
					    flip back with an error — and a switch that refuses to move reads
					    as a bug, not as a policy. The "Required" hero chip carries the
					    explanation instead. */}
					{isInstalled && !app.mandatory ? (
						<label className="ml-auto flex shrink-0 items-center gap-2 text-sm">
							{/* Safe Mode is a READ mask — `enabled` is still the user's own
							    choice, and the switch stays where they left it. What the
							    label has to say is that the app is not actually loaded this
							    boot, or the card would read "Enabled" beside a panel that
							    is missing. */}
							{app.suppressedBySafeMode
								? "Off — Safe Mode"
								: app.enabled
									? "Enabled"
									: "Disabled"}
							<Switch
								aria-label={
									app.enabled ? `Disable ${app.name}` : `Enable ${app.name}`
								}
								checked={app.enabled}
								disabled={busy}
								onCheckedChange={(checked) => onToggle(app, checked)}
							/>
						</label>
					) : null}
				</>
			}
			aside={
				<>
					<ListingAsideCard title="Information">
						<ListingInfoGrid
							rows={[
								{ label: "Version", value: `v${installedVersionOf(app)}` },
								{
									label: "State",
									value: isInstalled
										? app.enabled
											? "Enabled"
											: "Disabled"
										: "Not installed",
								},
								{
									label: "Bundles",
									value: formatCount(app.runnables.length) ?? "—",
								},
								{
									label: "Grants",
									value: formatCount(app.permissionGrants.length) ?? "—",
								},
								...(sandbox
									? [{ label: "OS sandbox", value: sandboxLabel(sandbox) }]
									: []),
							]}
						/>
					</ListingAsideCard>
					<ListingAsideCard title="Plugin ID">
						<code
							className="block truncate rounded bg-muted px-2 py-1 text-muted-foreground text-xs"
							title={app.id}
						>
							{app.id}
						</code>
					</ListingAsideCard>
				</>
			}
			hero={
				<ListingHero
					badges={[
						isInstalled
							? app.enabled
								? "Enabled"
								: "Disabled"
							: "Not installed",
						app.mandatory ? "Required" : null,
						deprecation ? DEPRECATED_LABEL : null,
						app.system && !app.mandatory ? "System" : null,
						app.runnables.some((r) => r.kind === AGENT_KIND) ? "Agent" : null,
						...catalogLayerBadges(app.layers, app.external),
					].filter((b): b is string => Boolean(b))}
					cacheKey={iconCacheKey(app.id, installedVersionOf(app))}
					dither={app.iconDither}
					// No `icon` node: an app with no art of its own gets the generative
					// tile seeded from its id, exactly as its CARD does (StoreCatalogCard
					// drops the generic glyph for the same reason). Handing a BotIcon over
					// here would make the hero the one surface showing a stock glyph where
					// every other surface shows that app's own tile.
					iconBackground={app.iconBackground}
					iconId={app.icon}
					iconName={app.name}
					iconPadding={app.iconPadding}
					iconUrl={app.iconUrl}
					name={app.name}
					seedId={app.id}
					tagline={cardDescription(app) ?? `v${installedVersionOf(app)}`}
				/>
			}
			notice={
				toggleError || deprecation ? (
					<div className="flex flex-col gap-3">
						{toggleError ? (
							<div className="flex items-start justify-between gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-status-destructive">
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
						{deprecation ? (
							<DeprecationNotice
								message={deprecation.message}
								name={app.name}
								replacement={deprecation.replacement}
							/>
						) : null}
					</div>
				) : null
			}
			stats={
				<ListingStatStrip
					items={[
						{ label: "Version", value: `v${installedVersionOf(app)}` },
						{
							label: "State",
							value: isInstalled
								? app.enabled
									? "Enabled"
									: "Disabled"
								: "Not installed",
						},
						{
							label: "Bundles",
							value: formatCount(app.runnables.length) ?? "—",
						},
						{
							label: "Grants",
							value: formatCount(app.permissionGrants.length) ?? "—",
						},
					]}
				/>
			}
		>
			{/* Bundled Runnable kinds */}
			{app.runnables.length > 0 ? (
				<ListingSection title="Bundles">
					<div className="flex flex-wrap gap-1">
						{app.runnables.map((r) => (
							<Badge key={r.id} variant="secondary">
								{KIND_LABELS.get(r.kind) ?? r.kind} — {r.name}
							</Badge>
						))}
					</div>
				</ListingSection>
			) : null}

			{/* Plugin-to-plugin dependencies are NOT rendered here: they are the
			    Dependencies tab's subject, and this page mounts those tabs below. A
			    compact "Requires" badge row used to sit here as well, which meant the
			    same chain was told twice on one page, in two shapes, from two code
			    paths. */}

			{/* Permission grants, in plain English, with per-grant revoke toggles. */}
			{app.permissionGrants.length > 0 ||
			(app.optionalPermissionGrants?.length ?? 0) > 0 ? (
				<PermissionsEditor
					app={app}
					onGrantsChanged={onGrantsChanged}
					target={target}
				/>
			) : null}

			{app.mcpOAuthServers.length > 0 ? (
				<OAuthConnections apps={[app]} loading={false} />
			) : null}

			{/* Inline plugin settings — the fields the plugin declared in its manifest. */}
			{hasSettings ? (
				<InstalledAppSettings settingsTabs={settingsTabs} target={target} />
			) : null}

			<AlertDialog
				onOpenChange={handleConfirmOpenChange}
				open={confirmUninstall}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>Remove {app.name}?</AlertDialogTitle>
						<AlertDialogDescription>
							This removes {app.name} and disables it. You can add it again from
							the store later. Its settings and permission grants are cleared,
							and its saved secrets are removed.
						</AlertDialogDescription>
					</AlertDialogHeader>
					<label className="flex items-center gap-3 text-sm">
						<Checkbox
							checked={deleteStorage}
							onCheckedChange={(value) => setDeleteStorage(value === true)}
						/>
						Also delete this app's saved data
					</label>
					<AlertDialogFooter>
						<AlertDialogCancel>Cancel</AlertDialogCancel>
						<AlertDialogAction
							onClick={() => {
								onUninstall(app, { deleteStorage }).catch(() => {
									// Refusals surface via the shared toggleError banner.
								});
							}}
						>
							Remove
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
			<InstalledAppTabs app={app} target={target} />
		</ListingDetailShell>
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

	const run = async <TResult,>(
		action: SidecarAction,
		call: (target: ApiTarget, name: string) => Promise<TResult>
	) => {
		if (!isConfigured || pending !== null) {
			return;
		}
		setActionError(null);
		setPending(action);
		try {
			await call(target, sidecarName);
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
		<ListingDetailShell
			actions={
				<>
					{isInstalled ? null : (
						<Button
							disabled={pending !== null || !isConfigured}
							loading={pending === "install"}
							onClick={() => run("install", installSidecar)}
							size="sm"
							variant="ghost"
						>
							{pending === "install" ? null : (
								<HugeiconsIcon className="size-4" icon={Download01Icon} />
							)}
							Add
						</Button>
					)}
					{isInstalled && !isRunning ? (
						<Button
							disabled={pending !== null}
							loading={pending === "start"}
							onClick={() => run("start", startSidecar)}
							size="sm"
							variant="default"
						>
							{pending === "start" ? null : (
								<HugeiconsIcon className="size-4" icon={Triangle01Icon} />
							)}
							Start
						</Button>
					) : null}
					{isInstalled && isRunning ? (
						<Button
							disabled={pending !== null}
							loading={pending === "stop"}
							onClick={() => run("stop", stopSidecar)}
							size="sm"
							variant="ghost"
						>
							{pending === "stop" ? null : (
								<HugeiconsIcon className="size-4" icon={Square01Icon} />
							)}
							Stop
						</Button>
					) : null}
					{actionError ? (
						<span className="ml-auto text-sm text-status-destructive">
							{actionError}
						</span>
					) : null}
				</>
			}
			aside={
				<>
					<ListingAsideCard title="Information">
						<ListingInfoGrid
							rows={[
								{ label: "Version", value: `v${installedVersionOf(app)}` },
								{ label: "Lifecycle", value: "Sidecar" },
								{
									label: "Sidecar",
									value: sidecarName ?? "Not configured",
								},
								{
									label: "Scope",
									value: app.localOnly ? "Local only" : "Any node",
								},
							]}
						/>
					</ListingAsideCard>
					{app.permissionGrants.length > 0 ? (
						<ListingAsideCard title="Permissions">
							<p className="font-mono text-muted-foreground text-xs">
								{app.permissionGrants.join(", ")}
							</p>
						</ListingAsideCard>
					) : null}
					<ListingAsideCard title="Plugin ID">
						<code
							className="block truncate rounded bg-muted px-2 py-1 text-muted-foreground text-xs"
							title={app.id}
						>
							{app.id}
						</code>
					</ListingAsideCard>
				</>
			}
			hero={
				<ListingHero
					badges={[
						app.windowsFirst ? "Windows-first" : null,
						app.localOnly ? "Local only" : null,
						isInstalled ? (isRunning ? "Running" : "Stopped") : "Not installed",
					].filter((b): b is string => Boolean(b))}
					cacheKey={iconCacheKey(app.id, installedVersionOf(app))}
					dither={app.iconDither}
					// No `icon` node — see the app hero above: the generative tile is what
					// this sidecar's card shows for the same artless item.
					iconBackground={app.iconBackground}
					iconId={app.icon}
					iconName={app.name}
					iconPadding={app.iconPadding}
					iconUrl={app.iconUrl}
					name={app.name}
					seedId={app.id}
					statusIcons={<StatusBadge kind="builtin" tone="hero" />}
					tagline={cardDescription(app) ?? `v${installedVersionOf(app)}`}
				/>
			}
			stats={
				<ListingStatStrip
					items={[
						{ label: "Version", value: `v${installedVersionOf(app)}` },
						{
							label: "Process",
							value: isInstalled
								? isRunning
									? "Running"
									: "Stopped"
								: "Not installed",
						},
						{
							label: "Includes",
							value: formatCount(app.runnables.length) ?? "—",
						},
						{
							label: "Grants",
							value: formatCount(app.permissionGrants.length) ?? "—",
						},
					]}
				/>
			}
		>
			<ListingSection title="Includes">
				<p className="text-muted-foreground text-sm">
					{app.runnables.length === 0
						? "No runnables."
						: app.runnables.map((r) => `${r.name} (${r.kind})`).join(" · ")}
				</p>
			</ListingSection>
		</ListingDetailShell>
	);
}
