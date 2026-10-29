import { Badge } from "@ryu/ui/components/badge.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import { SkeletonRows } from "@ryu/ui/components/skeleton.tsx";
import { useMemo } from "react";
import { useApps } from "@/src/hooks/useApps.ts";
import { OAuthConnections } from "../marketplace/ConnectionsTab.tsx";
import { SettingsCard, SettingsSection } from "./shared/settings-items.tsx";

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
		<SettingsSection
			caption="Marketplace apps are installed on this node. Review their permissions and connected services here; removing an app from one node does not remove it from another."
			title="Ryu Apps"
		>
			{loading ? (
				<SettingsCard>
					<SkeletonRows
						label="Loading installed Ryu apps…"
						spacing="comfortable"
					/>
				</SettingsCard>
			) : error ? (
				<SettingsCard>
					<p className="text-sm text-status-destructive">{error}</p>
				</SettingsCard>
			) : installedApps.length === 0 ? (
				<SettingsCard>
					<p className="text-muted-foreground text-sm">
						No marketplace Ryu apps are installed on this node.
					</p>
				</SettingsCard>
			) : (
				<SettingsCard>
					<div className="space-y-4">
						{installedApps.map((app, index) => (
							<div
								className={index > 0 ? "border-t pt-4" : undefined}
								key={app.id}
							>
								<div className="flex flex-wrap items-start justify-between gap-3">
									<div className="min-w-0">
										<div className="flex flex-wrap items-center gap-2">
											<p className="font-medium text-sm">{app.name}</p>
											<Badge variant={app.enabled ? "default" : "secondary"}>
												{app.enabled ? "Enabled" : "Disabled"}
											</Badge>
											{app.builtIn ? (
												<Badge variant="outline">Built in</Badge>
											) : null}
										</div>
										<p className="mt-1 break-all font-mono text-muted-foreground text-xs">
											{app.id}
										</p>
									</div>
									{app.mandatory ? null : (
										<Button
											onClick={() => void toggle(app.id, !app.enabled)}
											size="sm"
											variant="outline"
										>
											{app.enabled ? "Disable" : "Enable"}
										</Button>
									)}
								</div>

								<div className="mt-3 space-y-2 text-muted-foreground text-xs">
									<p>
										<strong className="font-medium text-foreground">
											Permissions:
										</strong>{" "}
										{app.approvedGrants.length > 0
											? app.approvedGrants.join(", ")
											: "None approved"}
									</p>
									{app.mcpOAuthServers.length > 0 ? (
										<p>
											<strong className="font-medium text-foreground">
												OAuth services declared:
											</strong>{" "}
											{app.mcpOAuthServers
												.map((server) => server.name)
												.join(", ")}
										</p>
									) : null}
								</div>
							</div>
						))}
					</div>
				</SettingsCard>
			)}
			{hasOAuthServices ? (
				<div className="pt-2">
					<OAuthConnections apps={installedApps} loading={false} />
				</div>
			) : null}
			{toggleError ? (
				<p className="mt-1.5 px-3.5 text-status-destructive text-xs">
					{toggleError}
				</p>
			) : null}
		</SettingsSection>
	);
}
