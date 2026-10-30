"use client";

import {
	Alert02Icon,
	CheckmarkBadge04Icon,
	DollarCircleIcon,
	ShieldKeyIcon,
	StarIcon,
	Tag01Icon,
	UnavailableIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages, useOptionalI18n } from "@ryu/i18n/react";
import AppIconArtwork, {
	composerIconFor,
} from "@ryu/ui/components/app-icon-artwork.tsx";
import { Badge } from "@ryu/ui/components/badge";
import { Button } from "@ryu/ui/components/button";
import { MarketplaceAccessBadge } from "@ryu/ui/components/marketplace-access-badge";
import {
	APP_ICON_TILE_CARD,
	APP_ICON_TILE_CARD_GLYPH,
	APP_ICON_TILE_CARD_SURFACE,
} from "@ryu/ui/lib/app-icon-tile";
import { formatCount } from "@ryu/ui/lib/number-format.ts";
import { safeMediaUrl } from "@ryu/ui/lib/safe-media-url.ts";
import { cn } from "@ryu/ui/lib/utils";
import type {
	MarketplaceCardData,
	MarketplaceVerification,
} from "./marketplace-types.ts";

const noop = () => {
	// Default no-op handler for the presentational layer.
};

/**
 * Manifest provenance badge (#450). Surfaces the signature verdict so a user can
 * tell a Ryu-signed item from one with unproven provenance BEFORE installing.
 */
export function TrustBadge({ status }: { status: MarketplaceVerification }) {
	if (status === "verified") {
		return (
			<span className="inline-flex items-center gap-1 text-muted-foreground text-xs">
				<HugeiconsIcon
					className="size-3.5 text-status-success"
					icon={ShieldKeyIcon}
				/>
				Verified
			</span>
		);
	}
	if (status === "unsigned") {
		return (
			<span className="inline-flex items-center gap-1 text-status-warning text-xs">
				<HugeiconsIcon className="size-3.5" icon={Alert02Icon} />
				Unsigned
			</span>
		);
	}
	if (status === "invalid") {
		return (
			<Badge variant="destructive">
				<HugeiconsIcon className="size-3.5" icon={UnavailableIcon} />
				Signature invalid
			</Badge>
		);
	}
	return null;
}

/** Item logo, or an initial-letter placeholder when no icon URL is set.
 *
 *  This paints the SAME square the free catalog's `AppIcon` paints — it just cannot
 *  be that component: `@ryu/marketplace` (where `AppIcon` lives) depends on this
 *  package, so importing it here would invert the dependency. The tile classes come
 *  from the one file both sides read ({@link APP_ICON_TILE_CARD}) so the paid strip
 *  card and the catalog card beside it cannot drift again — this one used to carry
 *  a `border` that the catalog card never had, which is why the two read as
 *  different components in the same list. */
export function MarketplaceCardLogo({
	id,
	iconUrl,
	name,
}: {
	iconUrl?: string | null;
	name: string;
	id: string;
}) {
	const tl = useLiteralMessages();
	const safeIconUrl = safeMediaUrl(iconUrl);
	if (composerIconFor(id)) {
		return <AppIconArtwork className="size-10" id={id} />;
	}
	return (
		<span
			className={cn(
				APP_ICON_TILE_CARD,
				APP_ICON_TILE_CARD_SURFACE,
				APP_ICON_TILE_CARD_GLYPH,
				"size-10"
			)}
		>
			{safeIconUrl ? (
				<img
					alt={tl("{name} logo", { name })}
					className="size-full object-cover"
					loading="lazy"
					src={safeIconUrl}
				/>
			) : (
				<span aria-hidden="true" className="font-medium text-sm uppercase">
					{name.trim().charAt(0) || "?"}
				</span>
			)}
		</span>
	);
}

/** Compact "★ 4.5 (12)" rating row; renders only when there are reviews. */
export function MarketplaceCardRating({
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
		<span className="mt-0.5 inline-flex items-center gap-1 text-muted-foreground text-xs">
			<HugeiconsIcon
				aria-hidden="true"
				className="size-3.5 text-status-warning"
				icon={StarIcon}
			/>
			<span className="font-medium text-foreground tabular-nums">
				{(Math.round((average ?? 0) * 10) / 10).toFixed(1)}
			</span>
			<span className="tabular-nums">({count})</span>
		</span>
	);
}

export function MarketplaceItemCard({
	card,
	onBuy = noop,
	onOpenDetail,
}: {
	card: MarketplaceCardData;
	onBuy?: () => void;
	/** When provided, the card's logo/title becomes a button that opens detail. */
	onOpenDetail?: () => void;
}) {
	const i18n = useOptionalI18n();
	const tl = useLiteralMessages();
	const isPaid = card.priceLabel !== null;
	const isLanguagePack =
		card.kind === "language_pack" && Boolean(card.onInstall);
	const isBundle = card.kind === "bundle" && Boolean(card.onInstall) && !isPaid;

	// One meta line under the description: the language pack's locale, else the
	// bundle size, else community usage.
	const cardMeta = card.languagePack
		? [
				card.languagePack.locale,
				card.languagePack.direction === "rtl"
					? (i18n?.t("language.direction_rtl") ?? "Right to left")
					: (i18n?.t("language.direction_ltr") ?? "Left to right"),
				i18n?.t("language.translation_count", {
					count: card.languagePack.messageCount,
				}) ??
					tl("{messageCount} translated strings", {
						messageCount: String(card.languagePack.messageCount),
					}),
			].join(" · ")
		: isBundle
			? tl("{count} items · one-click install", {
					count: String(card.bundleMemberCount ?? 0),
				})
			: card.communityStats &&
					(card.communityStats.downloads > 0 || card.communityStats.runs > 0)
				? tl("Community · {installs} installs · {runs} runs", {
						installs: formatCount(card.communityStats.downloads),
						runs: formatCount(card.communityStats.runs),
					})
				: null;

	const headingContent = (
		<div className="flex min-w-0 items-center gap-3 text-left">
			<MarketplaceCardLogo
				iconUrl={card.iconUrl}
				id={card.id}
				name={card.name}
			/>
			<div className="min-w-0">
				<h3 className="truncate font-medium text-sm" title={card.name}>
					{card.name}
				</h3>
				{card.author ? (
					<p
						className="truncate text-muted-foreground text-xs"
						title={card.author}
					>
						{card.author}
					</p>
				) : null}
				<MarketplaceCardRating
					average={card.ratingAverage}
					count={card.ratingCount}
				/>
			</div>
		</div>
	);
	const heading = (
		<div className="flex min-w-0 items-center gap-2">
			{onOpenDetail ? (
				<button
					className="min-w-0 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
					onClick={onOpenDetail}
					type="button"
				>
					{headingContent}
				</button>
			) : (
				headingContent
			)}
			{card.like ? (
				<span className="relative z-10 shrink-0">{card.like}</span>
			) : null}
		</div>
	);

	return (
		<div className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4">
			<div className="flex items-start justify-between gap-2">
				{heading}
				<div className="flex shrink-0 flex-col items-end gap-1">
					{isPaid ? (
						<Badge variant="secondary">
							<HugeiconsIcon className="size-3.5" icon={Tag01Icon} />
							{card.priceLabel}
						</Badge>
					) : null}
					<TrustBadge status={card.verification} />
					<MarketplaceAccessBadge
						membershipIncluded={card.membershipIncluded}
					/>
				</div>
			</div>

			{card.description ? (
				<p className="line-clamp-2 text-muted-foreground text-xs">
					{card.description}
				</p>
			) : null}
			{cardMeta ? (
				<p className="truncate text-muted-foreground text-xs">{cardMeta}</p>
			) : null}

			<div className="mt-auto flex items-center justify-between gap-2">
				<span className="text-muted-foreground/70 text-xs tabular-nums">
					v{card.version}
				</span>
				{isBundle ? (
					<Button
						loading={card.installing}
						onClick={card.onInstall}
						size="sm"
						variant="outline"
					>
						Install bundle
					</Button>
				) : isLanguagePack ? (
					card.active ? (
						<Badge variant="secondary">
							<HugeiconsIcon
								className="size-3.5 text-status-success"
								icon={CheckmarkBadge04Icon}
							/>
							{i18n?.t("common.active") ?? "Active"}
						</Badge>
					) : (
						<Button
							loading={card.installing}
							onClick={card.onInstall}
							size="sm"
							variant="outline"
						>
							{card.installed
								? (i18n?.t("common.enable") ?? "Enable")
								: (i18n?.t("common.install") ?? "Install")}
						</Button>
					)
				) : isPaid ? (
					card.owned ? (
						<Badge variant="secondary">
							<HugeiconsIcon
								className="size-3.5 text-status-success"
								icon={CheckmarkBadge04Icon}
							/>
							{i18n?.t("common.owned") ?? "Owned"}
						</Badge>
					) : (
						<Button
							loading={card.buying}
							onClick={onBuy}
							size="sm"
							variant="outline"
						>
							{!card.buying && (
								<HugeiconsIcon className="size-3.5" icon={DollarCircleIcon} />
							)}
							{i18n?.t("common.buy") ?? "Buy"}
						</Button>
					)
				) : (
					<span className="text-muted-foreground text-xs">
						{i18n?.t("common.free") ?? "Free"}
					</span>
				)}
			</div>
		</div>
	);
}
