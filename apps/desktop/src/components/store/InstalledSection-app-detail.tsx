// apps/desktop/src/components/store/InstalledSection-app-detail.tsx
//
// The preview aside for a regular installed app: toggle, grants, inline
// settings, uninstall confirmation, and the store detail tabs.

import {
	ArrowDown01Icon,
	Delete02Icon,
	Download04Icon,
	PlayIcon,
	Settings01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import DeprecationNotice from "@ryu/marketplace/catalog/chrome/deprecation-notice";
import {
	DEPRECATED_LABEL,
	resolveDeprecation,
} from "@ryu/marketplace/catalog/deprecation";
import {
	ListingAsideCard,
	ListingDetailShell,
	ListingHero,
	ListingInfoGrid,
	ListingSection,
	ListingStatStrip,
} from "@ryu/marketplace/catalog/detail/listing-detail-shell";
import { iconCacheKey } from "@ryu/marketplace/catalog/icon-cache";
import { catalogLayerBadges } from "@ryu/marketplace/catalog/types";
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
import { Switch } from "@ryu/ui/components/switch.tsx";
import { formatCount } from "@ryu/ui/lib/number-format.ts";
import { useState } from "react";
import { OAuthConnections } from "@/src/components/marketplace/ConnectionsTab.tsx";
import { PluginSettingsFields } from "@/src/components/settings/PluginSettingsFields.tsx";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import type { AppInfo, SidecarSandboxStatus } from "@/src/lib/api/plugins.ts";
import type { PluginSettingsTab } from "@/src/lib/pluginSettings.ts";
import { AppPermissionsEditor as PermissionsEditor } from "./AppPermissionsEditor.tsx";
import { InstalledAppTabs } from "./InstalledSection-app-tabs.tsx";
import {
	AGENT_KIND,
	cardDescription,
	installedVersionOf,
	KIND_LABELS,
	primaryAgentId,
} from "./InstalledSection-categories.ts";
import { sandboxLabel } from "./InstalledSection-sandbox.ts";

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

export function InstalledAppDetail({
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
	const tl = useLiteralMessages();
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
									app.enabled
										? tl("Disable {name}", { name: app.name })
										: tl("Enable {name}", { name: app.name })
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
							className="block truncate rounded-lg bg-muted px-2 py-1 text-muted-foreground text-xs"
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
							<div className="flex items-start justify-between gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-status-destructive">
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
						<AlertDialogTitle>
							{tl("Remove {name}?", { name: app.name })}
						</AlertDialogTitle>
						<AlertDialogDescription>
							{tl(
								"This removes {name} and disables it. You can add it again from the store later. Its settings and permission grants are cleared, and its saved secrets are removed.",
								{ name: app.name }
							)}
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
