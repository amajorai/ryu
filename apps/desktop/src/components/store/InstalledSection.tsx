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

import { ComputerIcon, PackageIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import StoreCatalogCard from "@ryu/marketplace/catalog/chrome/store-catalog-card";
import StoreCatalogLayout, {
	StoreCardGrid,
} from "@ryu/marketplace/catalog/chrome/store-catalog-layout";
import StoreItemAction, {
	StoreItemOverflowMenu,
	storeItemContextMenu,
} from "@ryu/marketplace/catalog/chrome/store-item-action";
import StoreShelfHeading from "@ryu/marketplace/catalog/chrome/store-shelf-heading";
import { isDeprecated } from "@ryu/marketplace/catalog/deprecation";
import { iconCacheKey } from "@ryu/marketplace/catalog/icon-cache";
import { Badge } from "@ryu/ui/components/badge.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@ryu/ui/components/empty.tsx";
import { SkeletonRows } from "@ryu/ui/components/skeleton.tsx";
import {
	StandaloneAppContextMenuItems,
	StandaloneAppDropdownMenuItems,
} from "@/src/components/apps/standalone-app-menu.tsx";
import type { AppInfo } from "@/src/lib/api/plugins.ts";
import { InstalledAppDetail } from "./InstalledSection-app-detail.tsx";
import { BuiltInAppDetail } from "./InstalledSection-builtin-detail.tsx";
import {
	appCategory,
	CATEGORY_LABELS,
	CATEGORY_ORDER,
	cardDescription,
	installedVersionOf,
} from "./InstalledSection-categories.ts";
import { useInstalledSectionController } from "./InstalledSection-controller.ts";
import { LifecycleAccessCard } from "./InstalledSection-lifecycle-access.tsx";
import { appSandboxStatus } from "./InstalledSection-sandbox.ts";

export default function InstalledSection() {
	const {
		clearToggleError,
		error,
		handleInstall,
		handleInstallStandalone,
		handleLaunch,
		handleOpenStandalone,
		handleRemoveStandalone,
		handleSidecar,
		handleToggle,
		handleUninstall,
		installedAppIds,
		lifecycleCapabilities,
		loading,
		navigate,
		pending,
		pollSidecarStatus,
		query,
		reload,
		selectedApp,
		selectedId,
		setQuery,
		setSelectedId,
		settingsByPlugin,
		settingsOpener,
		sidecarSandbox,
		sidecarStatus,
		target,
		toggleError,
		visibleApps,
	} = useInstalledSectionController();

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
						<div className="flex items-start justify-between gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-status-destructive">
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
