"use client";
import { StarIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages, useOptionalI18n } from "@ryu/i18n/react";
import { Badge } from "@ryu/ui/components/badge.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import { Spinner } from "@ryu/ui/components/spinner.tsx";
import { formatCount } from "@ryu/ui/lib/number-format.ts";
import { safeMediaUrl } from "@ryu/ui/lib/safe-media-url.ts";
import type { ReactNode } from "react";

export const noop = () => {
	// Default no-op handler for the presentational layer.
};

export type StoreItemState =
	| "available"
	| "installing"
	| "installed"
	| "failed";

/** The install / lifecycle action cluster for a generic catalog card. */
export function StoreItemAction({
	state,
	progressLabel,
	onInstall = noop,
	onUninstall = noop,
	onRetry = noop,
}: {
	state: StoreItemState;
	/** Optional progress text shown while installing (e.g. "Adding 48%"). */
	progressLabel?: string;
	onInstall?: () => void;
	onUninstall?: () => void;
	onRetry?: () => void;
}) {
	const i18n = useOptionalI18n();
	if (state === "installing") {
		return (
			<span className="flex items-center gap-2 text-muted-foreground text-xs">
				<Spinner className="size-3.5" />{" "}
				{progressLabel ??
					i18n?.t("marketplace.adding", undefined, "Adding…") ??
					"Adding…"}
			</span>
		);
	}
	if (state === "installed") {
		return (
			<div className="flex items-center gap-2">
				<Badge variant="secondary">
					{i18n?.t("common.added", undefined, "Added") ?? "Added"}
				</Badge>
				<Button onClick={onUninstall} size="sm" variant="ghost">
					{i18n?.t("common.remove") ?? "Remove"}
				</Button>
			</div>
		);
	}
	if (state === "failed") {
		return (
			<div className="flex items-center gap-2">
				<Badge variant="destructive">
					{i18n?.t("common.failed", undefined, "Failed") ?? "Failed"}
				</Badge>
				<Button onClick={onRetry} size="sm" variant="ghost">
					{i18n?.t("common.retry") ?? "Retry"}
				</Button>
			</div>
		);
	}
	return (
		<Button
			className="self-start"
			onClick={onInstall}
			size="sm"
			variant="ghost"
		>
			{i18n?.t("common.add") ?? "Add"}
		</Button>
	);
}

export interface StoreCatalogCardData {
	/** Store-taxonomy category (unused by the card chrome, carried for callers). */
	category?: string | null;
	description: string;
	/** Resolvable logo URL; falls back to the item's initial when null/absent. */
	iconUrl?: string | null;
	name: string;
	progressLabel?: string;
	/** Mean review rating; the compact star row renders when `ratingCount > 0`. */
	ratingAverage?: number;
	/** Number of reviews behind the average. */
	ratingCount?: number;
	state: StoreItemState;
	/** Short category/kind chip rendered top-right. */
	tag?: string;
}

/** Item logo, or an initial-letter placeholder when no icon URL is set. */
function StoreCardLogo({
	iconUrl,
	name,
}: {
	iconUrl?: string | null;
	name: string;
}) {
	const tl = useLiteralMessages();
	const safeIconUrl = safeMediaUrl(iconUrl);
	if (safeIconUrl) {
		return (
			<img
				alt={tl("{name} logo", { name })}
				className="size-9 shrink-0 rounded-lg border border-border object-cover"
				loading="lazy"
				src={safeIconUrl}
			/>
		);
	}
	return (
		<span
			aria-hidden="true"
			className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border bg-muted font-medium text-muted-foreground text-sm uppercase"
		>
			{name.trim().charAt(0) || "?"}
		</span>
	);
}

/** Compact "★ 4.5 (12)" rating row; renders only when there are reviews. */
export function StoreCardRating({
	average,
	count,
}: {
	average?: number;
	count?: number;
}) {
	if (!count || count <= 0) {
		return null;
	}
	return (
		<span className="inline-flex items-center gap-1 text-muted-foreground text-xs">
			<HugeiconsIcon
				aria-hidden="true"
				className="size-3.5 text-status-warning"
				icon={StarIcon}
			/>
			<span className="font-medium text-foreground tabular-nums">
				{(Math.round((average ?? 0) * 10) / 10).toFixed(1)}
			</span>
			<span className="tabular-nums">({formatCount(count) ?? "—"})</span>
		</span>
	);
}

/** A generic catalog card: logo, name, kind chip, rating, description, action. */
export function StoreCatalogCard({
	item,
	onInstall = noop,
	onUninstall = noop,
	onRetry = noop,
}: {
	item: StoreCatalogCardData;
	onInstall?: () => void;
	onUninstall?: () => void;
	onRetry?: () => void;
}) {
	return (
		<div className="flex flex-col gap-2 rounded-xl border border-border bg-card p-4">
			<div className="flex items-start justify-between gap-2">
				<div className="flex min-w-0 items-center gap-2.5">
					<StoreCardLogo iconUrl={item.iconUrl} name={item.name} />
					<div className="min-w-0">
						<span className="block truncate font-medium" title={item.name}>
							{item.name}
						</span>
						<StoreCardRating
							average={item.ratingAverage}
							count={item.ratingCount}
						/>
					</div>
				</div>
				{item.tag ? <Badge variant="outline">{item.tag}</Badge> : null}
			</div>
			<p className="flex-1 text-muted-foreground text-sm">{item.description}</p>
			<StoreItemAction
				onInstall={onInstall}
				onRetry={onRetry}
				onUninstall={onUninstall}
				progressLabel={item.progressLabel}
				state={item.state}
			/>
		</div>
	);
}

/** Two-column responsive grid for catalog cards. */
export function StoreCardGrid({ children }: { children: ReactNode }) {
	return <div className="grid grid-cols-2 gap-3">{children}</div>;
}

/** Skeleton card grid for the loading state. */
export function StoreLoadingGrid({ count = 4 }: { count?: number }) {
	return (
		<div className="scroll-fade grid flex-1 grid-cols-2 gap-3 overflow-auto p-4">
			{Array.from({ length: count }, (_, i) => i).map((i) => (
				<div
					className="space-y-3 rounded-xl border border-border bg-card p-4"
					key={i}
				>
					<div className="h-4 w-1/2 rounded-lg bg-muted motion-safe:animate-pulse" />
					<div className="h-3 w-3/4 rounded-lg bg-muted/60 motion-safe:animate-pulse" />
					<div className="h-7 w-20 rounded-lg bg-muted/60 motion-safe:animate-pulse" />
				</div>
			))}
		</div>
	);
}
