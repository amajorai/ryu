// apps/desktop/src/components/store/InstalledSection-builtin-detail.tsx
//
// The sidecar-control preview (install/start/stop) for built-in system apps.

import {
	Download01Icon,
	Square01Icon,
	Triangle01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import {
	ListingAsideCard,
	ListingDetailShell,
	ListingHero,
	ListingInfoGrid,
	ListingSection,
	ListingStatStrip,
} from "@ryu/marketplace/catalog/detail/listing-detail-shell";
import { iconCacheKey } from "@ryu/marketplace/catalog/icon-cache";
import { Button } from "@ryu/ui/components/button.tsx";
import { StatusBadge } from "@ryu/ui/components/status-badge.tsx";
import { formatCount } from "@ryu/ui/lib/number-format.ts";
import { useState } from "react";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	type AppInfo,
	installSidecar,
	startSidecar,
	stopSidecar,
} from "@/src/lib/api/plugins.ts";
import {
	cardDescription,
	installedVersionOf,
} from "./InstalledSection-categories.ts";

// Built-in system apps (Ghost, Shadow) whose lifecycle is sidecar-based rather
// than App-store lifecycle. The preview carries Install → Start → Stop against the
// live running-state polled by the parent.
type SidecarAction = "install" | "start" | "stop";

export function BuiltInAppDetail({
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
	const tl = useLiteralMessages();
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
				e instanceof Error
					? e.message
					: tl(
							"{action, select, install {Failed to install sidecar} start {Failed to start sidecar} stop {Failed to stop sidecar} other {Failed to {action} sidecar}}",
							{ action }
						)
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
