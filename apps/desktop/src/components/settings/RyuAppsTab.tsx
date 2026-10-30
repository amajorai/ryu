import { InformationCircleIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { SkeletonRows } from "@ryu/ui/components/skeleton.tsx";
import { Switch } from "@ryu/ui/components/switch.tsx";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ryu/ui/components/tooltip.tsx";
import { useMemo } from "react";
import { useApps } from "@/src/hooks/useApps.ts";
import type { AppInfo } from "@/src/lib/api/plugins.ts";
import { OAuthConnections } from "../marketplace/ConnectionsTab.tsx";
import {
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "./shared/settings-items.tsx";

/** Hidden until the row is hovered or focused; always shown without hover. */
const ROW_REVEAL =
	"opacity-0 transition-opacity duration-150 focus-visible:opacity-100 group-focus-within/item:opacity-100 group-hover/item:opacity-100 group-hover/item:duration-0 [@media(hover:none)]:opacity-100";

/**
 * Provenance and wiring that matter only when you go looking: the app id,
 * whether it ships with Ryu, and the OAuth services it declares.
 */
function AppDetails({ app }: { app: AppInfo }) {
	const tl = useLiteralMessages();
	const oauth = app.mcpOAuthServers.map((server) => server.name).join(", ");
	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<Button
						aria-label={tl("About {appName}", { appName: app.name })}
						className={ROW_REVEAL}
						size="icon-sm"
						variant="ghost-muted"
					/>
				}
			>
				<HugeiconsIcon icon={InformationCircleIcon} size={16} />
			</TooltipTrigger>
			<TooltipContent className="max-w-80">
				<span className="flex flex-col gap-0.5">
					{app.builtIn ? <span>Built in</span> : null}
					<span className="break-all font-mono">{app.id}</span>
					{oauth ? (
						<span>
							{tl("OAuth services declared: {oauthServices}", {
								oauthServices: oauth,
							})}
						</span>
					) : null}
				</span>
			</TooltipContent>
		</Tooltip>
	);
}

function AppRow({
	app,
	onToggle,
}: {
	app: AppInfo;
	onToggle: (enabled: boolean) => void;
}) {
	const tl = useLiteralMessages();
	return (
		// A block wrapper, not `display: contents`: the flush group draws its
		// hairlines on its direct children, and a `contents` box paints no border.
		<div data-app-id={app.id} data-built-in={app.builtIn ? "" : undefined}>
			<SettingsItem
				actions={
					<span className="flex items-center gap-2">
						<AppDetails app={app} />
						<Switch
							aria-label={tl("{appName} enabled", { appName: app.name })}
							checked={app.enabled}
							// Core refuses to disable a mandatory app, so its switch stays on.
							disabled={app.mandatory}
							onCheckedChange={onToggle}
						/>
					</span>
				}
				description={
					<span data-slot="app-permissions">
						{app.approvedGrants.length > 0
							? tl("Permissions: {permissions}", {
									permissions: app.approvedGrants.join(", "),
								})
							: tl("Permissions: None approved")}
					</span>
				}
				// A node, not a string: the name is third-party text, so the
				// settings formatter must not read its braces as placeholders.
				title={<span>{app.name}</span>}
			/>
		</div>
	);
}

/**
 * The account-level view of marketplace Ryu Apps. Installation and grants are
 * node-local, so this reads Core's authoritative app list instead of pretending
 * a cloud account owns the same install on every device.
 */
export function RyuAppsTab() {
	const { apps, error, loading, toggle, toggleError } = useApps();
	const installedApps = useMemo(
		() =>
			apps.filter(
				(app) => app.installed && (app.companion !== null || app.builtIn)
			),
		[apps]
	);
	const hasOAuthServices = installedApps.some(
		(app) => app.mcpOAuthServers.length > 0
	);

	return (
		<>
			<SettingsSection
				caption={
					installedApps.length > 0
						? "Installed on this node. Removing an app here leaves your other nodes alone."
						: undefined
				}
			>
				{loading ? (
					<SkeletonRows label="Loading installed Ryu apps…" />
				) : error ? (
					<div className="flex flex-col gap-1 py-3">
						<p className="text-sm">Couldn't load your Ryu apps.</p>
						<details className="text-detail text-muted-foreground">
							<summary className="w-fit cursor-pointer hover:text-foreground">
								Details
							</summary>
							<p className="mt-1 break-all font-mono">{error}</p>
						</details>
					</div>
				) : installedApps.length === 0 ? (
					<p className="py-3 text-muted-foreground text-sm">
						No marketplace Ryu apps are installed on this node.
					</p>
				) : (
					<SettingsGroup>
						{installedApps.map((app) => (
							<AppRow
								app={app}
								key={app.id}
								onToggle={(enabled) => void toggle(app.id, enabled)}
							/>
						))}
					</SettingsGroup>
				)}
				{toggleError ? (
					<p className="mt-2 text-detail text-status-destructive" role="alert">
						{toggleError}
					</p>
				) : null}
			</SettingsSection>
			{hasOAuthServices ? (
				<div className="mt-8">
					<OAuthConnections apps={installedApps} loading={false} />
				</div>
			) : null}
		</>
	);
}
