"use client";

import { Delete02Icon, PlayIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { type LiteralMessage, useLiteralMessages } from "@ryu/i18n/react";
import { Badge } from "@ryu/ui/components/badge";
import { Button } from "@ryu/ui/components/button";
import { isNativeNumber } from "@ryu/ui/lib/native-primitive-observation.ts";
import {
	type AppResponseValue,
	appResponseValueSchema,
} from "@ryuhq/core-client/app-request-json";
import type {
	Alert,
	Monitor,
	Snapshot,
	UsageProviderOption,
} from "@ryuhq/core-client/monitors";
import {
	CHECK_LABELS,
	safeMonitorUrl,
	statusColor,
} from "./monitors-form-state.ts";
import {
	type UsageAccountsByProvider,
	watchedAccountLabel,
} from "./monitors-usage-accounts.ts";

export function MonitorDetail({
	monitor,
	running,
	snapshots,
	alerts,
	onRun,
	onEdit,
	onDelete,
	providerOptions,
	usageAccounts,
}: {
	monitor: Monitor;
	running: boolean;
	snapshots: Snapshot[];
	alerts: Alert[];
	onRun: () => void;
	onEdit: () => void;
	onDelete: () => void;
	providerOptions: UsageProviderOption[];
	usageAccounts: UsageAccountsByProvider;
}) {
	const tl = useLiteralMessages();
	const monitorUrl = safeMonitorUrl(monitor.url);
	const check = monitor.check;
	const sourceLabel =
		check.type === "provider_usage_reset"
			? providerSourceLabel(
					check.provider_id,
					check.account_id,
					providerOptions,
					usageAccounts,
					tl
				)
			: monitor.url;
	return (
		<div className="mx-auto max-w-2xl space-y-5">
			<div className="flex items-start justify-between">
				<div>
					<h1 className="font-medium text-lg">{monitor.name}</h1>
					{monitor.check.type === "provider_usage_reset" ? (
						<span className="text-muted-foreground text-sm">{sourceLabel}</span>
					) : monitorUrl ? (
						<a
							className="text-muted-foreground text-sm hover:underline"
							href={monitorUrl}
							rel="noopener noreferrer"
							target="_blank"
						>
							{monitor.url}
						</a>
					) : (
						<span className="text-muted-foreground text-sm">{monitor.url}</span>
					)}
				</div>
				<div className="flex gap-2">
					<Button disabled={running} onClick={onRun} size="sm">
						<HugeiconsIcon className="size-4" icon={PlayIcon} />
						{running ? "Checking…" : "Run now"}
					</Button>
					<Button onClick={onEdit} size="sm" variant="outline">
						Edit
					</Button>
					<Button
						aria-label="Delete monitor"
						onClick={onDelete}
						size="icon-sm"
						variant="ghost"
					>
						<HugeiconsIcon
							className="size-4 text-status-destructive"
							icon={Delete02Icon}
						/>
					</Button>
				</div>
			</div>

			<div className="flex flex-wrap gap-2 text-sm">
				<Badge variant="secondary">{CHECK_LABELS[monitor.check.type]}</Badge>
				<Badge variant="outline">
					{tl("every {interval}", { interval: monitor.interval })}
				</Badge>
				<Badge variant="outline">
					{monitor.check.type === "provider_usage_reset"
						? "Core usage reader"
						: monitor.backend}
				</Badge>
				{monitor.last_status ? (
					<span className="inline-flex items-center gap-1.5">
						<span
							className={`inline-block size-2 rounded-full ${statusColor(monitor.last_status)}`}
						/>
						{formatMonitorValue(monitor, monitor.last_value) ??
							monitor.last_status}
					</span>
				) : null}
			</div>

			<section>
				<h2 className="mb-2 font-medium text-sm">Recent alerts</h2>
				{alerts.length > 0 ? (
					<ul className="space-y-1.5">
						{alerts.map((a) => (
							<li className="rounded-md border px-3 py-2 text-sm" key={a.id}>
								<div className="font-medium">{a.title}</div>
								<div className="text-muted-foreground">{a.message}</div>
								<div className="text-muted-foreground text-xs">
									{a.created_at}
								</div>
							</li>
						))}
					</ul>
				) : (
					<p className="text-muted-foreground text-sm">No alerts yet.</p>
				)}
			</section>

			<section>
				<h2 className="mb-2 font-medium text-sm">Check history</h2>
				{snapshots.length > 0 ? (
					<ul className="space-y-1">
						{snapshots.map((s) => (
							<li
								className="flex items-center gap-2 rounded-md px-2 py-1 text-sm hover:bg-accent"
								key={s.id}
							>
								<span
									className={`inline-block size-2 rounded-full ${statusColor(s.status)}`}
								/>
								<span className="text-muted-foreground text-xs">
									{s.checked_at}
								</span>
								<span className="flex-1 truncate">
									{formatMonitorValue(monitor, s.value) ?? s.note ?? ""}
								</span>
								{s.http_status == null ? null : (
									<span className="text-muted-foreground text-xs">
										{s.http_status}
									</span>
								)}
								{s.latency_ms == null ? null : (
									<span className="text-muted-foreground text-xs">
										{s.latency_ms}ms
									</span>
								)}
							</li>
						))}
					</ul>
				) : (
					<p className="text-muted-foreground text-sm">
						No checks recorded yet — hit “Run now”.
					</p>
				)}
			</section>
		</div>
	);
}

function providerSourceLabel(
	providerId: string,
	accountId: string | null | undefined,
	providerOptions: UsageProviderOption[],
	usageAccounts: UsageAccountsByProvider,
	tl: LiteralMessage
): string {
	const provider =
		providerOptions.find((option) => option.providerId === providerId)?.label ??
		providerId;
	const accounts = usageAccounts[providerId] ?? [];
	// Without an account list (older host, or no per-account usage), only a
	// pinned monitor needs its account named.
	if (accounts.length === 0 && !accountId) {
		return tl("Provider usage · {provider}", { provider });
	}
	return tl("Provider usage · {provider} · {account}", {
		provider,
		account: watchedAccountLabel(accountId, accounts),
	});
}

// Stored values can retain a previous check's JSON after a failed provider
// read. Observe raw native JSON cells rather than promise the current baseline.
interface ProviderStoredValueObservation {
	targets?: AppResponseValue;
}
interface ProviderStoredTargetObservation {
	kind?: AppResponseValue;
	label?: AppResponseValue;
	model?: AppResponseValue;
	number?: AppResponseValue;
	unit?: AppResponseValue;
	usedPercent?: AppResponseValue;
}

function formatMonitorValue(monitor: Monitor, raw: string | null | undefined) {
	if (!raw || monitor.check.type !== "provider_usage_reset") {
		return raw;
	}
	try {
		// SAFETY: This is only a lazy property-read view of the entire validated
		// native JSON node; it asserts no object brand, target presence or DTO.
		// Keep nil in the receiver domain so the original first read still fails.
		const snapshot = appResponseValueSchema.parse(JSON.parse(raw)) as
			| ProviderStoredValueObservation
			| null
			| undefined;
		// SAFETY: Native Object.values enumerates JSON descendants, string index
		// characters, or an empty scalar object; it establishes no target DTO.
		// The first snapshot read intentionally keeps the original nil failure.
		const targets = Object.values(
			snapshot!.targets ?? {}
		) as AppResponseValue[];
		const entries = targets.map((target) => {
			// SAFETY: Observe only the original raw JSON member cells, including
			// boxed scalar access and nil failure. No string/number/row guarantee.
			const reading = target as
				| ProviderStoredTargetObservation
				| null
				| undefined;
			const label = reading!.model
				? `${reading!.label ?? "Usage"} · ${reading!.model}`
				: (reading!.label ?? "Usage");
			if (reading!.kind === "window" && isNativeNumber(reading!.usedPercent)) {
				return `${label}: ${reading!.usedPercent.toFixed(1)}% used`;
			}
			if (reading!.kind === "meter" && isNativeNumber(reading!.number)) {
				return `${label}: ${reading!.number.toFixed(2)} ${reading!.unit ?? ""}`.trim();
			}
			return label;
		});
		return entries.length > 0 ? entries.join(" · ") : "Usage baseline recorded";
	} catch {
		return "Provider usage checked";
	}
}
