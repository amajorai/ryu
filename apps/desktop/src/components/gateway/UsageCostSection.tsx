// apps/desktop/src/components/gateway/UsageCostSection.tsx
//
// The Gateway "Usage & Cost" surface. Four cards:
//  1. Per-provider quota / rate-limit countdowns — read live from the gateway
//     `/metrics` `provider_quota` block (proxied through Core's gateway-status
//     endpoint, so no extra fetch loop: the parent's 5s status poll feeds this
//     card and a local 1s ticker smooths the countdown between polls).
//  2. Per-model spend — the control-plane usage rollup (`fetchProfileStats`:
//     lifetime cost in micro-USD + per-model request counts). Reuses the same
//     query key as the Stats tab so the cache is shared.
//  3. Provider cost-tier editor — reads the current `routing.provider_tiers`
//     from the config GET and writes it back with a full read-modify-write of
//     the whole `routing` object (0 = subscription, 1 = cheap, 2 = free),
//     because PUT /v1/config replaces the entire routing object.
//  4. Additional account keys — READ-ONLY. Provider credentials are
//     environment-variable-only; the config GET reports only an `api_key_count`
//     per provider and PUT has no `providers` arm, so this just displays counts.
//
// The tier editor goes through the SAME save path the rest of the dialog uses
// (`updateGatewayConfig`), which Core forwards verbatim to the gateway's
// `PUT /v1/config`.

import { Key01Icon } from "@hugeicons/core-free-icons";
import { SettingsIconTile } from "@ryu/blocks/desktop/settings-nav.tsx";
import { Badge } from "@ryu/ui/components/badge.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select.tsx";
import { SkeletonRows } from "@ryu/ui/components/skeleton.tsx";
import {
	formatCurrency,
	formatNumber as formatSharedNumber,
} from "@ryu/ui/lib/number-format.ts";
import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { OrgBillingContext } from "@/src/components/billing/OrgBillingContext.tsx";
import {
	SettingsCard,
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "@/src/components/settings/shared/settings-items.tsx";
import { useProviderCredits } from "@/src/hooks/useProviderCredits.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import type { GatewayMetrics, ProviderQuota } from "@/src/lib/api/gateway.ts";
import {
	fetchGatewayConfig,
	updateGatewayConfig,
} from "@/src/lib/api/gateway.ts";
import { fetchProfileStats } from "@/src/lib/api/profile.ts";

const MICRO_PER_USD = 1_000_000;
const SECONDS_PER_MINUTE = 60;
const TICK_MS = 1000;

/** All provider kinds a cost tier can be assigned to (the 9 gateway kinds). */
const TIER_PROVIDER_KINDS = [
	"openai",
	"anthropic",
	"local",
	"openrouter",
	"core",
	"modal",
	"genai",
	"replicate",
	"fal",
] as const;

const PROVIDER_LABELS = new Map<string, string>([
	["openai", "OpenAI"],
	["anthropic", "Anthropic"],
	["local", "Local"],
	["openrouter", "OpenRouter"],
	["core", "Core"],
	["modal", "Modal"],
	["genai", "Gemini"],
	["replicate", "Replicate"],
	["fal", "Fal"],
]);

const ROTATION_PROVIDERS: { slug: string; label: string; envVar: string }[] = [
	{ slug: "openai", label: "OpenAI", envVar: "OPENAI_API_KEYS" },
	{ slug: "anthropic", label: "Anthropic", envVar: "ANTHROPIC_API_KEYS" },
	{ slug: "openrouter", label: "OpenRouter", envVar: "OPENROUTER_API_KEYS" },
];

const TIER_OPTIONS: { value: string; label: string }[] = [
	{ value: "0", label: "Subscription (0)" },
	{ value: "1", label: "Cheap (1)" },
	{ value: "2", label: "Free (2)" },
];

function providerLabel(kind: string): string {
	return PROVIDER_LABELS.get(kind) ?? kind;
}

function formatCost(microUsd: number): string {
	const dollars = microUsd / MICRO_PER_USD;
	if (dollars > 0 && dollars < 0.01) {
		return "<$0.01";
	}
	return formatCurrency(dollars, "USD", {
		maximumFractionDigits: dollars >= 10 ? 0 : 2,
	});
}

function formatNumber(value: number): string {
	return formatSharedNumber(value);
}

/** "2m 05s" / "42s" / "now" / "—" for a whole-seconds countdown. */
function formatCountdown(secs: number | null): string {
	if (secs === null) {
		return "—";
	}
	if (secs <= 0) {
		return "now";
	}
	const minutes = Math.floor(secs / SECONDS_PER_MINUTE);
	const seconds = secs % SECONDS_PER_MINUTE;
	if (minutes > 0) {
		return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
	}
	return `${seconds}s`;
}

function formatQuota(quota: ProviderQuota): string {
	if (quota.remaining === null && quota.limit === null) {
		return "—";
	}
	const remaining =
		quota.remaining === null ? "?" : formatNumber(quota.remaining);
	if (quota.limit === null) {
		return remaining;
	}
	return `${remaining} / ${formatNumber(quota.limit)}`;
}

// ── 1. Provider quota countdowns ─────────────────────────────────────────────

/**
 * Live seconds remaining for a quota window: the snapshot's `resetInSecs`
 * decremented by the wall-clock time elapsed since the snapshot arrived, so the
 * value keeps ticking down smoothly between the parent's 5s status polls.
 */
function liveResetSecs(
	quota: ProviderQuota,
	elapsedSecs: number
): number | null {
	if (quota.resetInSecs === null) {
		return null;
	}
	return Math.max(0, quota.resetInSecs - elapsedSecs);
}

function ProviderQuotaCard({ metrics }: { metrics: GatewayMetrics | null }) {
	const [nowMs, setNowMs] = useState(() => Date.now());
	const receivedAtRef = useRef(Date.now());

	// Reset the elapsed clock whenever a fresh metrics snapshot arrives.
	useEffect(() => {
		receivedAtRef.current = Date.now();
		setNowMs(Date.now());
	}, [metrics]);

	// Local 1s ticker to advance the countdown between polls; cleaned up on unmount.
	useEffect(() => {
		const id = setInterval(() => setNowMs(Date.now()), TICK_MS);
		return () => clearInterval(id);
	}, []);

	const quota = metrics?.providerQuota ?? {};
	const entries = Object.entries(quota).sort(([a], [b]) => a.localeCompare(b));
	const elapsedSecs = Math.max(
		0,
		Math.floor((nowMs - receivedAtRef.current) / TICK_MS)
	);

	return (
		<SettingsSection
			caption="Live upstream rate-limit windows reported by each provider. The countdown ticks down between polls; a provider only appears after its quota headers have been seen once."
			title="Provider quota"
		>
			{entries.length === 0 ? (
				<SettingsCard className="text-center text-muted-foreground text-sm">
					No provider quota observed yet. Drive a few requests through the
					gateway and this fills in as upstreams report their limits.
				</SettingsCard>
			) : (
				<SettingsCard className="overflow-x-auto py-2">
					<table className="w-full text-sm">
						<thead>
							<tr className="border-border/60 border-b text-left text-muted-foreground text-xs">
								<th className="pr-3 pb-2 font-medium">Provider</th>
								<th className="pr-3 pb-2 font-medium">Remaining / Limit</th>
								<th className="pr-3 pb-2 font-medium">Resets in</th>
								<th className="pb-2 font-medium">Status</th>
							</tr>
						</thead>
						<tbody>
							{entries.map(([name, q]) => {
								const secs = liveResetSecs(q, elapsedSecs);
								return (
									<tr
										className="border-border/60 border-b last:border-0"
										key={name}
									>
										<td className="py-2 pr-3 font-medium">
											{providerLabel(name)}
										</td>
										<td className="py-2 pr-3 font-mono text-xs tabular-nums">
											{formatQuota(q)}
										</td>
										<td className="py-2 pr-3 font-mono text-xs tabular-nums">
											{formatCountdown(secs)}
										</td>
										<td className="py-2">
											{q.rateLimited ? (
												<Badge variant="destructive">rate limited</Badge>
											) : (
												<Badge variant="default">ok</Badge>
											)}
										</td>
									</tr>
								);
							})}
						</tbody>
					</table>
				</SettingsCard>
			)}
		</SettingsSection>
	);
}

// ── 2. Per-model spend ───────────────────────────────────────────────────────

function ModelSpendCard() {
	const { data, isLoading, isError, error, refetch } = useQuery({
		queryKey: ["profile", "stats"],
		queryFn: fetchProfileStats,
	});

	const renderBody = () => {
		if (isLoading) {
			return (
				<SettingsCard>
					<SkeletonRows label="Loading…" spacing="budget" />
				</SettingsCard>
			);
		}
		if (isError || !data) {
			const requiresSignIn =
				error instanceof Error &&
				error.message === "Sign in to view your stats.";
			return (
				<SettingsItem
					actions={
						requiresSignIn ? null : (
							<Button
								aria-label="Retry account usage rollup"
								onClick={() => void refetch()}
								size="sm"
								variant="outline"
							>
								Retry
							</Button>
						)
					}
					title={
						<span className="text-muted-foreground">
							{error instanceof Error
								? error.message
								: "Sign in to view your usage and spend."}
						</span>
					}
				/>
			);
		}
		const totalTokens = data.totals.inputTokens + data.totals.outputTokens;
		const topModels = data.insights.topModels;
		return (
			<>
				<SettingsGroup>
					<MetricRow
						label="Total spend"
						value={formatCost(data.totals.costMicroUsd)}
					/>
					<MetricRow
						label="Requests"
						value={formatNumber(data.totals.requestCount)}
					/>
					<MetricRow label="Tokens" value={formatNumber(totalTokens)} />
				</SettingsGroup>
				{topModels.length === 0 ? (
					<SettingsCard className="text-center text-muted-foreground text-sm">
						No model usage recorded yet.
					</SettingsCard>
				) : (
					<SettingsCard className="overflow-x-auto py-2">
						<table className="w-full text-sm">
							<thead>
								<tr className="border-border/60 border-b text-left text-muted-foreground text-xs">
									<th className="pr-3 pb-2 font-medium">Model</th>
									<th className="pb-2 text-right font-medium">Requests</th>
								</tr>
							</thead>
							<tbody>
								{topModels.map((m) => (
									<tr
										className="border-border/60 border-b last:border-0"
										key={m.id}
									>
										<td className="py-2 pr-3 font-mono text-xs">{m.id}</td>
										<td className="py-2 text-right font-mono text-xs tabular-nums">
											{formatNumber(m.count)}
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</SettingsCard>
				)}
			</>
		);
	};

	return (
		<SettingsSection
			caption="This is the signed-in account profile rollup, not the shared organization wallet. Organization credits and managed-inference debits are shown in Credits and Usage."
			title="Account usage rollup"
		>
			{renderBody()}
		</SettingsSection>
	);
}

function MetricRow({ label, value }: { label: string; value: string }) {
	return (
		<SettingsItem
			actions={
				<span className="font-mono text-muted-foreground text-sm tabular-nums">
					{value}
				</span>
			}
			title={label}
		/>
	);
}

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

function ProviderTierEditor({
	target,
	reachable,
	configuredProviders,
}: {
	target: ApiTarget;
	reachable: boolean;
	configuredProviders: string[];
}) {
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

	const setTier = (kind: string, tier: number) => {
		setTiers((prev) => ({ ...prev, [kind]: tier }));
		setSaveOk(false);
		setSaveError(null);
	};

	const handleSave = async () => {
		if (!tiers) {
			return;
		}
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
				routing: { ...cfg.routing, provider_tiers: tiers },
				expectedRevision: cfg.configRevision ?? undefined,
			});
			setSaveOk(true);
			setTimeout(() => setSaveOk(false), 3000);
		} catch (e) {
			setSaveError(
				e instanceof Error ? e.message : "Failed to save provider tiers"
			);
		} finally {
			setSaving(false);
		}
	};

	const isDisabled = !reachable || tiers === null || loading;
	const kinds = tierRowKinds(configuredProviders, tiers ?? {});
	const retryLoad = () => {
		setLoadError(null);
		setLoadAttempt((attempt) => attempt + 1);
	};
	let saveNotice: ReactNode;
	if (saveOk) {
		saveNotice = (
			<span className="text-status-success">
				Saved. Restart the gateway for changes to take effect.
			</span>
		);
	} else if (saveError) {
		saveNotice = <span className="text-status-destructive">{saveError}</span>;
	}

	return (
		<SettingsSection
			caption="Cost tier per provider, used to order the fallback chain: a rate-limited or failed primary demotes down the cost ladder (subscription → cheap → free) instead of retrying at random. Absent providers default to Subscription. Takes effect after the gateway restarts."
			headerAction={
				<Button
					disabled={isDisabled}
					loading={saving}
					onClick={() => handleSave()}
					size="sm"
					variant="ghost"
				>
					Save
				</Button>
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
				{kinds.map((kind, index) => (
					<SettingsItem
						actions={
							<Select
								disabled={isDisabled}
								items={TIER_OPTIONS}
								onValueChange={(v) => v && setTier(kind, Number(v))}
								value={String(tiers?.[kind] ?? 0)}
							>
								<SelectTrigger
									aria-label={`Cost tier for ${providerLabel(kind)}`}
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
						// The save outcome is the footer of the last row, so it reads
						// directly under the card it describes.
						description={index === kinds.length - 1 ? saveNotice : undefined}
						key={kind}
						title={providerLabel(kind)}
					/>
				))}
			</SettingsGroup>
		</SettingsSection>
	);
}

// ── 4. Additional account keys (rotation) — read-only ────────────────────────
//
// Provider credentials are environment-variable-only by design: the config GET
// redacts the keys and reports only an `api_key_count`, and `PUT /v1/config` has
// no `providers` arm. So this is a read-only status display, not an editor —
// rotation accounts are added via the `*_API_KEYS` env vars.

function AccountKeysDisplay({
	target,
	reachable,
}: {
	reachable: boolean;
	target: ApiTarget;
}) {
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
			caption="Extra API keys per provider for round-robin account rotation, alongside the primary key. Credentials are environment-variable-only: set OPENAI_API_KEYS / ANTHROPIC_API_KEYS / OPENROUTER_API_KEYS (comma-separated) and restart the gateway. The count reflects how many are configured; keys are never displayed."
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
								<Badge variant={counts && n > 0 ? "default" : "secondary"}>
									{counts
										? `${n} account ${n === 1 ? "key" : "keys"}`
										: loading && reachable
											? "Checking…"
											: "Unavailable"}
								</Badge>
							}
							key={slug}
							title={
								<span className="flex items-center gap-2.5" title={envVar}>
									{/* Tagged so the group's hairline starts at the label. */}
									<span className="contents" data-slot="settings-icon-tile">
										<SettingsIconTile icon={Key01Icon} tint="yellow" />
									</span>
									{label}
								</span>
							}
						/>
					);
				})}
			</SettingsGroup>
		</SettingsSection>
	);
}

// ── Section ──────────────────────────────────────────────────────────────────

/**
 * Remaining prepaid credit on the BYOK provider keys stored on this node.
 *
 * A separate card rather than a column on the quota table above, because the two
 * are different universes: that table is keyed by GATEWAY provider kinds
 * (`openai`, `anthropic`, `local`, `core`, …) whose credentials are
 * environment-variable-only, while these are Pi/BYOK provider ids whose keys live
 * in Core's own config. Joining them would need an id mapping that doesn't exist
 * and would silently mismatch.
 *
 * Only three providers publish a balance to the key you already hold. The rest is
 * not an oversight worth hiding: the card says so, because "why is OpenAI not
 * listed" is otherwise the first question.
 */
function ProviderCreditsCard() {
	return (
		<SettingsSection
			caption="Provider-side prepaid balance left on API keys stored on this node. This is separate from the active organization's shared Ryu credits. Only vendors that publish a balance to an inference key can be shown."
			title="BYOK provider key balance"
		>
			<SettingsGroup>
				{CREDIT_PROVIDER_IDS.map((id) => (
					<ProviderCreditsRow key={id} providerId={id} />
				))}
			</SettingsGroup>
		</SettingsSection>
	);
}

/** The provider ids Core can read a balance for (mirrors `supportsProviderCredits`). */
const CREDIT_PROVIDER_IDS = ["openrouter", "deepseek", "moonshot"] as const;

const CREDIT_PROVIDER_LABELS = new Map<string, string>([
	["openrouter", "OpenRouter"],
	["deepseek", "DeepSeek"],
	["moonshot", "Moonshot / Kimi"],
]);

/**
 * One provider's balance row. Unlike the picker badge (which hides entirely when
 * there is nothing to show), this surface is a deliberate list, so a row always
 * renders and states WHY it has no number — on a settings page "no key stored" is
 * the actionable answer, not noise.
 */
function ProviderCreditsRow({ providerId }: { providerId: string }) {
	// Through the shared hook, not a hand-rolled query: it carries the
	// supported-provider gate and the poll cadence, and re-typing its query key
	// here would make the two surfaces share cache only by coincidence.
	const data = useProviderCredits(providerId);
	const label = CREDIT_PROVIDER_LABELS.get(providerId) ?? providerId;
	const meter = data?.available ? data.meters.at(0) : undefined;
	const amount = meter?.values.at(0);
	let value = "Checking…";
	if (data) {
		if (amount) {
			value = `${formatCurrency(amount.number, "USD", {
				maximumFractionDigits: 2,
				minimumFractionDigits: 2,
			})} left`;
		} else if (data.reason === "not_logged_in") {
			value = "No key stored";
		} else if (data.reason === "token_expired") {
			value = "Key rejected";
		} else if (data.reason === "rate_limited") {
			value = "Rate limited";
		} else {
			value = "Unavailable";
		}
	}
	return (
		<SettingsItem
			actions={
				<span
					className={`text-muted-foreground text-sm tabular-nums ${
						amount ? "font-mono" : ""
					}`}
				>
					{value}
				</span>
			}
			title={label}
		/>
	);
}

export function UsageCostSection({
	target,
	reachable,
	metrics,
	configuredProviders,
}: {
	configuredProviders: string[];
	metrics: GatewayMetrics | null;
	reachable: boolean;
	target: ApiTarget;
}) {
	return (
		<div className="flex flex-col gap-6">
			<SettingsSection
				caption="Managed inference debits this organization wallet; BYOK balances belong to keys stored on this node. Quota countdowns refresh with the gateway status poll, and the account rollup below is separate from the organization wallet."
				title="Billing"
			>
				<OrgBillingContext
					compact
					description="Ryu managed inference spends from this organization's shared credits."
					label="Managed inference billing"
				/>
			</SettingsSection>
			<ProviderQuotaCard metrics={metrics} />
			<ModelSpendCard />
			<ProviderTierEditor
				configuredProviders={configuredProviders}
				reachable={reachable}
				target={target}
			/>
			<ProviderCreditsCard />
			<AccountKeysDisplay reachable={reachable} target={target} />
		</div>
	);
}
