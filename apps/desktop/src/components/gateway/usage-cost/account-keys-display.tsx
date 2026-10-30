import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { useEffect, useMemo, useState } from "react";
import { CaptionInfo } from "@/src/components/gateway/quiet.tsx";
import {
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "@/src/components/settings/shared/settings-items.tsx";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import { fetchGatewayConfig } from "@/src/lib/api/gateway.ts";
import { ROTATION_PROVIDERS } from "./format.ts";

// ── 4. Additional account keys (rotation) — read-only ────────────────────────
//
// Provider credentials are environment-variable-only by design: the config GET
// redacts the keys and reports only an `api_key_count`, and `PUT /v1/config` has
// no `providers` arm. So this is a read-only status display, not an editor —
// rotation accounts are added via the `*_API_KEYS` env vars.

export function AccountKeysDisplay({
	target,
	reachable,
}: {
	reachable: boolean;
	target: ApiTarget;
}) {
	const tl = useLiteralMessages();
	const [counts, setCounts] = useState<Record<string, number> | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const [loadAttempt, setLoadAttempt] = useState(0);
	const configTarget = useMemo(
		() => ({ ...target }),
		[target.token, target.url, target.userJwt]
	);

	useEffect(() => {
		if (!reachable) {
			return;
		}
		let cancelled = false;
		setLoading(true);
		setCounts(null);
		setLoadError(null);
		fetchGatewayConfig(configTarget)
			.then((cfg) => {
				if (cancelled) {
					return;
				}
				setCounts({
					openai: cfg.providers.openai?.api_key_count ?? 0,
					anthropic: cfg.providers.anthropic?.api_key_count ?? 0,
					openrouter: cfg.providers.openrouter?.api_key_count ?? 0,
				});
			})
			.catch((e) => {
				if (!cancelled) {
					setLoadError(
						e instanceof Error ? e.message : "Failed to load providers"
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
	}, [configTarget, loadAttempt, reachable]);

	const retryLoad = () => {
		setLoadError(null);
		setLoadAttempt((attempt) => attempt + 1);
	};

	return (
		<SettingsSection
			caption={
				<CaptionInfo
					detail={
						"Extra API keys per provider for round-robin account rotation, alongside the primary key. Credentials are environment-variable-only: set OPENAI_API_KEYS / ANTHROPIC_API_KEYS / OPENROUTER_API_KEYS (comma-separated) and restart the gateway. The count reflects how many are configured; keys are never displayed."
					}
				>
					{"Extra keys per provider for round-robin rotation."}
				</CaptionInfo>
			}
			title="Additional account keys"
		>
			<SettingsGroup>
				{reachable && loadError ? (
					<SettingsItem
						actions={
							<Button
								aria-label="Retry additional account key counts"
								onClick={retryLoad}
								size="sm"
								variant="outline"
							>
								Retry
							</Button>
						}
						title={
							<span className="text-status-destructive" title={loadError}>
								Couldn’t load account key counts.
							</span>
						}
					/>
				) : null}
				{reachable && loading && !loadError ? (
					<SettingsItem
						title={
							<span className="text-muted-foreground">
								Checking additional account keys…
							</span>
						}
					/>
				) : null}
				{reachable ? null : (
					<SettingsItem
						title={
							<span className="text-muted-foreground">
								Gateway unreachable. Start the gateway and refresh to view
								account keys.
							</span>
						}
					/>
				)}
				{ROTATION_PROVIDERS.map(({ slug, label, envVar }) => {
					const n = counts?.[slug] ?? 0;
					return (
						<SettingsItem
							actions={
								<span className="text-muted-foreground text-sm tabular-nums">
									{counts
										? n > 0
											? tl(
													"{keyCount, plural, one {# account key} other {# account keys}}",
													{ keyCount: n }
												)
											: "None"
										: loading && reachable
											? "Checking…"
											: "Unavailable"}
								</span>
							}
							// The env var is the only way to set these keys, so it stays visible.
							description={<span className="font-mono text-xs">{envVar}</span>}
							key={slug}
							// A plain label: the section already says these are keys.
							title={label}
						/>
					);
				})}
			</SettingsGroup>
		</SettingsSection>
	);
}
