// apps/desktop/src/components/store/InstalledSection-lifecycle-access.tsx
//
// The server-authoritative lifecycle ACL card above the Installed grid.

import { useLiteralMessages } from "@ryu/i18n/react";
import {
	APP_LIFECYCLE_PERMISSIONS,
	type AppLifecycleCapabilities,
} from "@/src/lib/api/plugins.ts";

const LIFECYCLE_LABELS = {
	"app.disable": "Disable",
	"app.enable": "Enable",
	"app.install": "Install",
	"app.uninstall": "Uninstall",
	"app.update": "Update",
} satisfies Record<(typeof APP_LIFECYCLE_PERMISSIONS)[number], string>;

export function LifecycleAccessCard({
	capabilities,
	error,
	loading,
}: {
	capabilities: AppLifecycleCapabilities | null;
	error: Error | null;
	loading: boolean;
}) {
	const tl = useLiteralMessages();
	const node = capabilities?.node;
	// Only what this node refuses is worth a line; allowed is the normal state.
	const denied = capabilities
		? APP_LIFECYCLE_PERMISSIONS.filter(
				(permission) => capabilities.permissions[permission] !== true
			)
		: [];
	return (
		<section
			aria-label="App lifecycle access"
			className="flex flex-col gap-1"
			data-testid="app-lifecycle-access"
		>
			<h3 className="font-semibold text-sm">Lifecycle access</h3>
			<p className="text-detail text-muted-foreground">
				{loading
					? "Checking this node's access…"
					: node
						? tl("{scope} node · {id} · enforced by the server", {
								scope: node.scope,
								id: node.id,
							})
						: "Local node · enforced by the server"}
			</p>
			{error ? (
				<p className="text-detail text-status-destructive">
					Lifecycle access is unavailable; the server still enforces every
					action.
				</p>
			) : capabilities && denied.length === 0 ? (
				<p className="text-detail text-muted-foreground">
					Every lifecycle action is allowed.
				</p>
			) : (
				<ul className="mt-1">
					{denied.map((permission) => (
						<li
							className="flex items-baseline justify-between gap-3 border-border border-b py-2 text-sm last:border-b-0"
							key={permission}
						>
							<span>{LIFECYCLE_LABELS[permission]}</span>
							<span className="truncate text-muted-foreground text-xs">
								{capabilities?.reasons?.[permission] ?? "Not allowed"}
							</span>
						</li>
					))}
				</ul>
			)}
		</section>
	);
}
