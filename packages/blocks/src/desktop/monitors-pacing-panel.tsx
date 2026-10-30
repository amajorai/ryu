"use client";

import {
	type LiteralMessage,
	useLiteralMessages,
	useLocalizedText,
} from "@ryu/i18n/react";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@ryu/ui/components/card";
import { Label } from "@ryu/ui/components/label";
import {
	NativeSelect,
	NativeSelectOption,
} from "@ryu/ui/components/native-select";
import { Progress } from "@ryu/ui/components/progress";
import { Spinner } from "@ryu/ui/components/spinner";
import { formatDateTime } from "@ryu/ui/lib/timezone.ts";
import type {
	ProviderUsageSnapshot,
	UsageProviderOption,
	UsageWindowTarget,
} from "@ryuhq/core-client/monitors";
import { unavailableUsageMessage } from "./monitors-usage-accounts.ts";
import { estimateUsagePacing } from "./usage-pacing.ts";

function usageWindowLabel(window: UsageWindowTarget): string {
	return window.model ? `${window.label} · ${window.model}` : window.label;
}

function paceMessage(window: UsageWindowTarget, tl: LiteralMessage): string {
	const label = usageWindowLabel(window);
	const estimate = estimateUsagePacing(window);
	switch (estimate.kind) {
		case "before-reset":
			return tl(
				"At this pace, you may reach the {label} limit around {limitAt}, before it resets {resetsAt}.",
				{
					label,
					limitAt: formatDateTime(estimate.limitAt, {
						dateStyle: "medium",
						timeStyle: "short",
					}),
					resetsAt: formatDateTime(estimate.resetsAt, {
						dateStyle: "medium",
						timeStyle: "short",
					}),
				}
			);
		case "reset-first":
			return tl(
				"At this pace, about {percent}% of the {label} window should be used by its reset {resetsAt}.",
				{
					percent: String(Math.round(estimate.projectedUseAtReset)),
					label,
					resetsAt: formatDateTime(estimate.resetsAt, {
						dateStyle: "medium",
						timeStyle: "short",
					}),
				}
			);
		case "at-limit":
			return tl("The {label} window is at its reported limit.", { label });
		case "no-usage":
			return tl("No usage has been recorded for the {label} window yet.", {
				label,
			});
		case "warming-up":
			return tl(
				"This {label} window just started; wait a few minutes for a useful pace estimate.",
				{ label }
			);
		case "unavailable":
			return tl(
				"This provider does not report enough timing data to estimate a pace for the {label} window.",
				{ label }
			);
		default:
			return tl("Usage pace is unavailable.");
	}
}

function PaceMessage({ window }: { window: UsageWindowTarget }) {
	const tl = useLiteralMessages();
	const message = paceMessage(window, tl);
	return (
		<p className="text-muted-foreground text-sm" role="status">
			{message}
		</p>
	);
}

export function UsagePacingPanel({
	providerOptions,
	providerCatalogLoading,
	providerId,
	usageError,
	usageLoading,
	usageSnapshot,
	onProviderChange,
}: {
	providerOptions: UsageProviderOption[];
	providerCatalogLoading: boolean;
	providerId: string | null;
	usageError?: string | null;
	usageLoading: boolean;
	usageSnapshot?: ProviderUsageSnapshot;
	onProviderChange?: (providerId: string | null) => void;
}) {
	const tl = useLiteralMessages();
	const title = useLocalizedText("Usage pace", { literal: true });
	const description = useLocalizedText(
		"Estimate when a provider quota may run out from the average usage since its current window began.",
		{ literal: true }
	);
	const providers = providerOptions.filter(
		(provider) => provider.kind === "subscription"
	);
	return (
		<Card className="mx-auto w-full max-w-3xl">
			<CardHeader>
				<CardTitle>{title}</CardTitle>
				<CardDescription>{description}</CardDescription>
			</CardHeader>
			<CardContent spacing="relaxed">
				<div className="max-w-sm space-y-1.5">
					<Label htmlFor="m-pacing-provider">Provider</Label>
					<NativeSelect
						className="w-full"
						id="m-pacing-provider"
						onChange={(event) => onProviderChange?.(event.target.value || null)}
						value={providerId ?? ""}
					>
						<NativeSelectOption value="">Choose a provider</NativeSelectOption>
						{providers.map((provider) => (
							<NativeSelectOption
								key={provider.providerId}
								value={provider.providerId}
							>
								{provider.label}
							</NativeSelectOption>
						))}
					</NativeSelect>
				</div>
				{providerCatalogLoading ? (
					<div className="flex items-center gap-2 text-muted-foreground text-sm">
						<Spinner className="size-4" /> Loading supported providers…
					</div>
				) : null}
				{!providerCatalogLoading && providers.length === 0 && !usageError ? (
					<p className="text-muted-foreground text-sm" role="status">
						No subscription usage readers are available on this node.
					</p>
				) : null}
				{usageError ? (
					<p className="text-sm text-status-destructive" role="alert">
						{usageError}
					</p>
				) : null}
				{usageLoading ? (
					<div className="flex items-center gap-2 text-muted-foreground text-sm">
						<Spinner className="size-4" /> Reading current provider usage…
					</div>
				) : null}
				{usageSnapshot?.available === false ? (
					<p className="text-sm text-status-warning" role="status">
						{unavailableUsageMessage(usageSnapshot.reason, tl)}
					</p>
				) : null}
				{usageSnapshot?.available && usageSnapshot.windows.length > 0 ? (
					<ul className="space-y-3">
						{usageSnapshot.windows.map((window) => (
							<li
								className="space-y-2 rounded-md border p-3"
								key={window.targetId}
							>
								<div className="flex flex-wrap items-center justify-between gap-2">
									<span className="font-medium text-sm">
										{usageWindowLabel(window)}
									</span>
									<span className="font-mono text-muted-foreground text-sm tabular-nums">
										{tl("{percent}% used", {
											percent: String(Math.round(window.usedPercent)),
										})}
									</span>
								</div>
								<Progress
									aria-label={tl("{label} usage", {
										label: usageWindowLabel(window),
									})}
									value={Math.min(100, Math.max(0, window.usedPercent))}
								/>
								<PaceMessage window={window} />
							</li>
						))}
					</ul>
				) : null}
				{usageSnapshot?.available && usageSnapshot.windows.length === 0 ? (
					<p className="text-muted-foreground text-sm" role="status">
						This provider does not currently report timed usage windows.
					</p>
				) : null}
				{providerId || usageLoading || providerCatalogLoading ? null : (
					<p className="text-muted-foreground text-sm">
						Choose a provider to see its current usage pace.
					</p>
				)}
			</CardContent>
		</Card>
	);
}
