import {
	Share08Icon,
	Shield01Icon,
	SquareLock01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { SkeletonRows } from "@ryu/ui/components/skeleton.tsx";
import { useEffect, useState } from "react";
import { WEB_URL } from "@/lib/app-urls.ts";
import { openExternal } from "@/lib/tauri-bridge.ts";
import { CaptionInfo } from "@/src/components/gateway/quiet.tsx";
import {
	SettingsCard,
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "@/src/components/settings/shared/settings-items.tsx";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import type { GatewayAuthConfig } from "@/src/lib/api/gateway.ts";
import { fetchGatewayConfig } from "@/src/lib/api/gateway.ts";

// ── Gateway API-keys management surface (Unit U102) ─────────────────────────
//
// Lists the gateway's configured API keys (name + masked prefix) and whether
// auth is required. Never renders a plaintext key — the gateway redacts all key
// values to "***" in GET /v1/config responses. The "Manage in web" action deep-
// links to the web org gateway-keys page (built by WB4 / #94).

/**
 * Derive a display-safe prefix from a redacted key value.
 * The gateway always returns "***" for the key field; we show the key name
 * and a fixed masked placeholder so users can confirm their key is registered.
 */
function maskedKeyPrefix(name: string): string {
	const prefix = name.slice(0, 6).padEnd(6, "*");
	return `${prefix}···`;
}

export function GatewayKeysCard({
	target,
	reachable,
}: {
	target: ApiTarget;
	reachable: boolean;
}) {
	const [authConfig, setAuthConfig] = useState<GatewayAuthConfig | null>(null);
	const [loading, setLoading] = useState(false);
	const [loadError, setLoadError] = useState<string | null>(null);

	useEffect(() => {
		if (!reachable || authConfig !== null) {
			return;
		}
		let cancelled = false;
		setLoading(true);
		fetchGatewayConfig(target)
			.then((cfg) => {
				if (!cancelled) {
					setAuthConfig(cfg.auth);
					setLoadError(null);
				}
			})
			.catch((e) => {
				if (!cancelled) {
					setLoadError(
						e instanceof Error ? e.message : "Failed to load auth config"
					);
				}
			})
			.finally(() => {
				if (!cancelled) {
					setLoading(false);
				}
			});
		return () => {
			cancelled = true;
		};
	}, [reachable, authConfig, target]);

	const handleManageInWeb = () => {
		openExternal(`${WEB_URL}/organizations`).catch(() => undefined);
	};

	const keys = authConfig?.api_keys ?? [];
	const requireAuth = authConfig?.require_auth ?? false;

	return (
		<SettingsSection
			caption={
				<CaptionInfo
					detail={
						"Plaintext values are shown only at creation time and never stored in the desktop."
					}
				>
					{"Issue or revoke keys in Console on the web."}
				</CaptionInfo>
			}
			headerAction={
				<Button onClick={handleManageInWeb} size="sm" variant="ghost">
					<HugeiconsIcon className="size-4" icon={Share08Icon} />
					Manage in web
				</Button>
			}
			title="Gateway keys"
		>
			{reachable && loading ? (
				<SettingsCard>
					<SkeletonRows label="Loading…" spacing="panel" />
				</SettingsCard>
			) : null}
			{reachable && !loading && loadError ? (
				<SettingsCard className="text-muted-foreground text-sm">
					<span title={loadError}>Couldn't load the gateway's API keys.</span>
				</SettingsCard>
			) : null}
			{reachable && !(loading || loadError) ? (
				<>
					{requireAuth ? null : (
						<SettingsCard className="flex items-start gap-2 text-sm text-status-warning">
							<HugeiconsIcon
								className="mt-0.5 size-4 shrink-0"
								icon={Shield01Icon}
							/>
							<span>
								<span className="font-medium">Auth disabled.</span> The gateway
								accepts requests without an API key. Enable{" "}
								<span className="font-mono">require_auth</span> in the gateway
								config or via the web org settings to require authentication.
							</span>
						</SettingsCard>
					)}

					{keys.length === 0 ? (
						<SettingsCard className="py-3 text-muted-foreground text-sm">
							No API keys configured. Use the web org settings to issue keys.
						</SettingsCard>
					) : (
						<SettingsGroup>
							{keys.map((k) => (
								<SettingsItem
									actions={
										<div className="flex items-center gap-2">
											<span className="font-mono text-muted-foreground text-xs">
												{maskedKeyPrefix(k.name)}
											</span>
											{k.trusted_forwarder ? (
												<span className="text-muted-foreground text-xs">
													Trusted forwarder
												</span>
											) : null}
											{k.org_id ? (
												<span className="text-muted-foreground text-xs">
													Org
												</span>
											) : null}
										</div>
									}
									key={k.name}
									title={k.name}
								/>
							))}
						</SettingsGroup>
					)}
				</>
			) : null}
			{reachable ? null : (
				<SettingsCard className="py-3 text-muted-foreground text-sm">
					Gateway unreachable, so the key list is unavailable. Start the gateway
					and refresh.
				</SettingsCard>
			)}
		</SettingsSection>
	);
}

// ── BYOK provider-key vault (Unit U026) ─────────────────────────────────────

/**
 * Banner atop the Keys section on a managed node, explaining why every key card
 * is read-only. Copy only — no action, since editing is deliberately unavailable.
 */
export function ManagedKeysBanner() {
	return (
		<SettingsCard className="flex items-start gap-2 text-muted-foreground text-sm">
			<HugeiconsIcon
				className="mt-0.5 size-4 shrink-0"
				icon={SquareLock01Icon}
			/>
			<span>
				<span className="font-medium text-foreground">Ryu Cloud computer.</span>{" "}
				Provider keys are held securely server-side by Ryu Cloud and can't be
				changed from the desktop.
			</span>
		</SettingsCard>
	);
}
