// Usage & Cost: provider cost-tier editor.

import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select.tsx";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { InlineErrorRow } from "@/src/components/chat/InlineErrorRow.tsx";
import { CaptionInfo } from "@/src/components/gateway/quiet.tsx";
import {
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "@/src/components/settings/shared/settings-items.tsx";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	fetchGatewayConfig,
	updateGatewayConfig,
} from "@/src/lib/api/gateway.ts";
import {
	providerLabel,
	TIER_OPTIONS,
	TIER_PROVIDER_KINDS,
} from "./UsageCostSection-format.ts";

// ── 3. Provider cost-tier editor ─────────────────────────────────────────────

/** Provider kinds to show a tier row for: those seen in metrics/config, else all. */
function tierRowKinds(
	configuredProviders: string[],
	tiers: Record<string, number>
): string[] {
	const present = new Set<string>([
		...configuredProviders,
		...Object.keys(tiers),
	]);
	const known = TIER_PROVIDER_KINDS.filter((k) => present.has(k));
	const extra = [...present].filter(
		(k) =>
			!TIER_PROVIDER_KINDS.includes(
				/* SAFETY: This assertion only adapts the native includes search parameter. The unchanged string is compared against the authored TIER_PROVIDER_KINDS values; it does not establish membership before that comparison. */ k as (typeof TIER_PROVIDER_KINDS)[number]
			)
	);
	const rows = [...known, ...extra];
	return rows.length > 0 ? rows : [...TIER_PROVIDER_KINDS];
}

export function ProviderTierEditor({
	target,
	reachable,
	configuredProviders,
}: {
	target: ApiTarget;
	reachable: boolean;
	configuredProviders: string[];
}) {
	const tl = useLiteralMessages();
	const [tiers, setTiers] = useState<Record<string, number> | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const [loadAttempt, setLoadAttempt] = useState(0);
	const [saving, setSaving] = useState(false);
	const [saveError, setSaveError] = useState<string | null>(null);
	const [saveOk, setSaveOk] = useState(false);
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
		setTiers(null);
		setLoadError(null);
		fetchGatewayConfig(configTarget)
			.then((cfg) => {
				if (!cancelled) {
					setTiers(cfg.routing.provider_tiers ?? {});
				}
			})
			.catch((e) => {
				if (!cancelled) {
					setLoadError(
						e instanceof Error ? e.message : "Failed to load provider tiers"
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

	// Each change saves at once (no Save button). A failed save keeps the
	// chosen values on screen and offers Retry, which re-sends the same map.
	const save = async (next: Record<string, number>) => {
		setSaving(true);
		setSaveError(null);
		setSaveOk(false);
		try {
			// Re-fetch so the PUT carries the full routing object (preserving
			// default_provider / model_map / fallback_chain) with only the
			// provider_tiers map replaced. The revision of that read makes a
			// concurrent routing edit a conflict instead of a silent overwrite.
			const cfg = await fetchGatewayConfig(configTarget);
			await updateGatewayConfig(configTarget, {
				routing: { ...cfg.routing, provider_tiers: next },
				expectedRevision: cfg.configRevision ?? undefined,
			});
			setSaveOk(true);
		} catch (e) {
			setSaveError(
				e instanceof Error ? e.message : "Failed to save provider tiers"
			);
		} finally {
			setSaving(false);
		}
	};

	const setTier = (kind: string, tier: number) => {
		const next = { ...tiers, [kind]: tier };
		setTiers(next);
		save(next).catch(() => undefined);
	};

	const isDisabled = !reachable || tiers === null || loading || saving;
	const kinds = tierRowKinds(configuredProviders, tiers ?? {});
	const retryLoad = () => {
		setLoadError(null);
		setLoadAttempt((attempt) => attempt + 1);
	};
	let saveNotice: ReactNode = null;
	if (saveError && tiers) {
		saveNotice = (
			<InlineErrorRow
				details={saveError}
				message="Couldn't save provider cost tiers."
				onRetry={() => {
					save(tiers).catch(() => undefined);
				}}
			/>
		);
	} else if (saveOk) {
		saveNotice = (
			<p className="text-detail text-muted-foreground" role="status">
				Saved. Restart the gateway for changes to take effect.
			</p>
		);
	}

	return (
		<SettingsSection
			caption={
				<CaptionInfo
					detail={
						"Cost tier per provider, used to order the fallback chain: a rate-limited or failed primary demotes down the cost ladder (subscription → cheap → free) instead of retrying at random. Absent providers default to Subscription. Takes effect after the gateway restarts."
					}
				>
					{"Orders the fallback chain. Applies after the gateway restarts."}
				</CaptionInfo>
			}
			title="Provider cost tiers"
		>
			<SettingsGroup>
				{reachable && loadError ? (
					<SettingsItem
						actions={
							<Button
								aria-label="Retry provider cost tier load"
								onClick={retryLoad}
								size="sm"
								variant="outline"
							>
								Retry
							</Button>
						}
						title={
							<span className="text-status-destructive" title={loadError}>
								Couldn’t load provider cost tiers.
							</span>
						}
					/>
				) : null}
				{reachable && loading && !loadError ? (
					<SettingsItem
						title={
							<span className="text-muted-foreground">
								Loading provider cost tiers…
							</span>
						}
					/>
				) : null}
				{reachable ? null : (
					<SettingsItem
						title={
							<span className="text-muted-foreground">
								Gateway unreachable. Start the gateway and refresh to configure
								provider tiers.
							</span>
						}
					/>
				)}
				{kinds.map((kind) => (
					<SettingsItem
						actions={
							<Select
								disabled={isDisabled}
								items={TIER_OPTIONS}
								onValueChange={(v) => v && setTier(kind, Number(v))}
								value={String(tiers?.[kind] ?? 0)}
							>
								<SelectTrigger
									aria-label={tl("Cost tier for {provider}", {
										provider: providerLabel(kind),
									})}
									className="w-44"
								>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{TIER_OPTIONS.map((opt) => (
										<SelectItem key={opt.value} value={opt.value}>
											{opt.label}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						}
						key={kind}
						title={providerLabel(kind)}
					/>
				))}
			</SettingsGroup>
			{saveNotice}
		</SettingsSection>
	);
}
