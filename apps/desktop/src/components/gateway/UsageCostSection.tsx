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

import { Dollar01Icon, Key01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Badge } from "@ryu/ui/components/badge";
import { Button } from "@ryu/ui/components/button";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select";
import { Spinner } from "@ryu/ui/components/spinner";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import {
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "@/src/components/settings/shared/settings-items.tsx";
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

const PROVIDER_LABELS: Record<string, string> = {
	openai: "OpenAI",
	anthropic: "Anthropic",
	local: "Local",
	openrouter: "OpenRouter",
	core: "Core",
	modal: "Modal",
	genai: "Gemini",
	replicate: "Replicate",
	fal: "Fal",
};

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
	return PROVIDER_LABELS[kind] ?? kind;
}

function formatCost(microUsd: number): string {
	const dollars = microUsd / MICRO_PER_USD;
	if (dollars > 0 && dollars < 0.01) {
		return "<$0.01";
	}
	return new Intl.NumberFormat("en-US", {
		style: "currency",
		currency: "USD",
		maximumFractionDigits: dollars >= 10 ? 0 : 2,
	}).format(dollars);
}

function formatNumber(value: number): string {
	return value.toLocaleString();
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
			caption="Live upstream rate-limit windows reported by each provider. The countdown ticks down between polls; a provider only appears once its quota headers have been seen at least once."
			title="Provider quota"
		>
			{entries.length === 0 ? (
				<p className="px-3.5 text-muted-foreground text-sm">
					No provider quota observed yet. Drive a few requests through the
					gateway and this fills in as upstreams report their limits.
				</p>
			) : (
				<div className="overflow-x-auto px-3.5">
					<table className="w-full text-sm">
						<thead>
							<tr className="border-b text-left text-muted-foreground text-xs">
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
									<tr className="border-b last:border-0" key={name}>
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
				</div>
			)}
		</SettingsSection>
	);
}

// ── 2. Per-model spend ───────────────────────────────────────────────────────

function ModelSpendCard() {
	const { data, isLoading, isError, error } = useQuery({
		queryKey: ["profile", "stats"],
		queryFn: fetchProfileStats,
	});

	const renderBody = () => {
		if (isLoading) {
			return (
				<div className="flex items-center gap-2 px-3.5 text-muted-foreground text-sm">
					<Spinner className="size-4" />
					Loading…
				</div>
			);
		}
		if (isError || !data) {
			return (
				<p className="px-3.5 text-muted-foreground text-sm">
					{error instanceof Error
						? error.message
						: "Sign in to view your usage and spend."}
				</p>
			);
		}
		const totalTokens = data.totals.inputTokens + data.totals.outputTokens;
		const topModels = data.insights.topModels;
		return (
			<div className="flex flex-col gap-3">
				<div className="grid grid-cols-2 gap-3 px-3.5 sm:grid-cols-3">
					<MetricTile
						label="Total spend"
						value={formatCost(data.totals.costMicroUsd)}
					/>
					<MetricTile
						label="Requests"
						value={formatNumber(data.totals.requestCount)}
					/>
					<MetricTile label="Tokens" value={formatNumber(totalTokens)} />
				</div>
				{topModels.length === 0 ? (
					<p className="px-3.5 text-muted-foreground text-sm">
						No model usage recorded yet.
					</p>
				) : (
					<div className="overflow-x-auto px-3.5">
						<table className="w-full text-sm">
							<thead>
								<tr className="border-b text-left text-muted-foreground text-xs">
									<th className="pr-3 pb-2 font-medium">Model</th>
									<th className="pb-2 text-right font-medium">Requests</th>
								</tr>
							</thead>
							<tbody>
								{topModels.map((m) => (
									<tr className="border-b last:border-0" key={m.id}>
										<td className="py-2 pr-3 font-mono text-xs">{m.id}</td>
										<td className="py-2 text-right font-mono text-xs tabular-nums">
											{formatNumber(m.count)}
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				)}
			</div>
		);
	};

	return (
		<SettingsSection
			caption="Your account's usage rollup: lifetime spend (in USD) and the most-used models by request count. Per-model dollar attribution is not yet broken out — only the aggregate cost and per-model request share are available."
			title="Spend by model"
		>
			{renderBody()}
		</SettingsSection>
	);
}

function MetricTile({ label, value }: { label: string; value: string }) {
	return (
		<div className="rounded-lg bg-muted/40 p-3">
			<div className="text-muted-foreground text-xs">{label}</div>
			<div className="mt-1 font-semibold text-lg tabular-nums">{value}</div>
		</div>
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
			!TIER_PROVIDER_KINDS.includes(k as (typeof TIER_PROVIDER_KINDS)[number])
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
	const [saving, setSaving] = useState(false);
	const [saveError, setSaveError] = useState<string | null>(null);
	const [saveOk, setSaveOk] = useState(false);

	useEffect(() => {
		if (!reachable || tiers !== null) {
			return;
		}
		let cancelled = false;
		fetchGatewayConfig(target)
			.then((cfg) => {
				if (!cancelled) {
					setTiers(cfg.routing.provider_tiers ?? {});
					setLoadError(null);
				}
			})
			.catch((e: unknown) => {
				if (!cancelled) {
					setLoadError(
						e instanceof Error ? e.message : "Failed to load provider tiers"
					);
				}
			});
		return () => {
			cancelled = true;
		};
	}, [reachable, tiers, target]);

	const setTier = (kind: string, tier: number) => {
		setTiers((prev) => ({ ...(prev ?? {}), [kind]: tier }));
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
			// provider_tiers map replaced.
			const cfg = await fetchGatewayConfig(target);
			await updateGatewayConfig(target, {
				routing: { ...cfg.routing, provider_tiers: tiers },
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

	const isDisabled = !reachable || tiers === null;
	const kinds = tierRowKinds(configuredProviders, tiers ?? {});

	return (
		<SettingsSection
			caption="Cost tier per provider, used to order the fallback chain: a rate-limited or failed primary demotes down the cost ladder (subscription → cheap → free) instead of retrying at random. Absent providers default to Subscription. Takes effect after the gateway restarts."
			headerAction={
				<Button
					disabled={isDisabled || saving}
					onClick={() => handleSave()}
					size="sm"
					variant="ghost"
				>
					{saving ? <Spinner className="size-4" /> : null}
					Save
				</Button>
			}
			title="Provider cost tiers"
		>
			<div className="flex flex-col gap-3">
				{reachable && loadError ? (
					<p className="px-3.5 text-destructive text-sm">{loadError}</p>
				) : null}
				{reachable ? null : (
					<p className="px-3.5 text-muted-foreground text-sm">
						Gateway unreachable — start the gateway and refresh to configure
						provider tiers.
					</p>
				)}
				<SettingsGroup>
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
							key={kind}
							title={providerLabel(kind)}
						/>
					))}
				</SettingsGroup>
				<div className="flex items-center gap-3 px-3.5">
					{saveOk ? (
						<span className="text-sm text-success">
							Saved. Restart the gateway for changes to take effect.
						</span>
					) : null}
					{saveError ? (
						<span className="text-destructive text-sm">{saveError}</span>
					) : null}
				</div>
			</div>
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

	useEffect(() => {
		if (!reachable) {
			return;
		}
		let cancelled = false;
		fetchGatewayConfig(target)
			.then((cfg) => {
				if (cancelled) {
					return;
				}
				setCounts({
					openai: cfg.providers.openai?.api_key_count ?? 0,
					anthropic: cfg.providers.anthropic?.api_key_count ?? 0,
					openrouter: cfg.providers.openrouter?.api_key_count ?? 0,
				});
				setLoadError(null);
			})
			.catch((e: unknown) => {
				if (!cancelled) {
					setLoadError(
						e instanceof Error ? e.message : "Failed to load providers"
					);
				}
			});
		return () => {
			cancelled = true;
		};
	}, [reachable, target]);

	return (
		<SettingsSection
			caption="Extra API keys per provider for round-robin account rotation, alongside the primary key. Credentials are environment-variable-only: set OPENAI_API_KEYS / ANTHROPIC_API_KEYS / OPENROUTER_API_KEYS (comma-separated) and restart the gateway. The count reflects how many are configured; keys are never displayed."
			title="Additional account keys"
		>
			<div className="flex flex-col gap-3">
				{reachable && loadError ? (
					<p className="px-3.5 text-destructive text-sm">{loadError}</p>
				) : null}
				{reachable ? null : (
					<p className="px-3.5 text-muted-foreground text-sm">
						Gateway unreachable — start the gateway and refresh to view account
						keys.
					</p>
				)}
				<SettingsGroup>
					{ROTATION_PROVIDERS.map(({ slug, label, envVar }) => {
						const n = counts?.[slug] ?? 0;
						return (
							<SettingsItem
								actions={
									<Badge variant={n > 0 ? "default" : "secondary"}>
										{n} account {n === 1 ? "key" : "keys"}
									</Badge>
								}
								description={`Add rotation accounts via the ${envVar} env var (comma-separated).`}
								key={slug}
								title={
									<span className="flex items-center gap-2">
										<HugeiconsIcon
											className="size-4 text-muted-foreground"
											icon={Key01Icon}
										/>
										{label}
									</span>
								}
							/>
						);
					})}
				</SettingsGroup>
			</div>
		</SettingsSection>
	);
}

// ── Section ──────────────────────────────────────────────────────────────────

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
				caption="Live provider rate-limit windows, your spend rollup, and the cost knobs that shape routing and account rotation."
				title="Usage & cost"
			>
				<div className="flex items-center gap-2 px-3.5 text-muted-foreground text-sm">
					<HugeiconsIcon className="size-4" icon={Dollar01Icon} />
					<span>
						Quota countdowns refresh with the gateway status poll; spend comes
						from your account usage rollup.
					</span>
				</div>
			</SettingsSection>
			<ProviderQuotaCard metrics={metrics} />
			<ModelSpendCard />
			<ProviderTierEditor
				configuredProviders={configuredProviders}
				reachable={reachable}
				target={target}
			/>
			<AccountKeysDisplay reachable={reachable} target={target} />
		</div>
	);
}
