"use client";

// Presentational layer of the desktop Marketplace money layer. The live app now
// folds this into the Customize (Store) shell: the item card + browse grid drive
// the inline "From the Marketplace" strips in each catalog section
// (`apps/desktop/src/components/store/MarketplaceStrip.tsx`), and `MarketplaceHeader`
// drives the store's Account section tabs (`components/store/AccountSection.tsx`).
// The storyboard renders the same components with mock data and no-op handlers.
// One source of truth, so editing this block changes the real desktop too.
//
// Scope note: this block extracts the browse grid + item card (the
// money-affordance surface) — the part the storyboard exercises. The Licenses /
// Sell tabs and the storyboard's "detail" variant have no shared structure and
// stay as faithful reconstructions (see the storyboard screen).

import {
	Alert02Icon,
	CheckmarkBadge04Icon,
	DollarCircleIcon,
	Refresh01Icon,
	Search01Icon,
	ShieldKeyIcon,
	StarIcon,
	Store01Icon,
	Tag01Icon,
	UnavailableIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useOptionalI18n } from "@ryu/i18n/react";
import { Badge } from "@ryu/ui/components/badge";
import { Button } from "@ryu/ui/components/button";
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@ryu/ui/components/empty";
import { Input } from "@ryu/ui/components/input";
import { MarketplaceAccessBadge } from "@ryu/ui/components/marketplace-access-badge";
import { Spinner } from "@ryu/ui/components/spinner";
import {
	APP_ICON_TILE_CARD,
	APP_ICON_TILE_CARD_GLYPH,
	APP_ICON_TILE_CARD_SURFACE,
} from "@ryu/ui/lib/app-icon-tile";
import { cn } from "@ryu/ui/lib/utils";
import type { ReactNode } from "react";

/** Mirrors the control plane's `MarketplaceKind`. `agent` is a user-published
 *  agent definition — a configuration, not code. */
export type MarketplaceItemKind =
	| "app"
	| "plugin"
	| "skill"
	| "model"
	| "mcp"
	| "agent"
	| "stack_template"
	| "workflow"
	| "theme"
	| "language_pack"
	| "space"
	| "profile"
	| "output_style"
	| "bundle";

export type MarketplaceVerification =
	| "verified"
	| "unsigned"
	| "invalid"
	| "unknown";

/** Presentational card shape. Mirrors the app's `MarketplaceCard` but pre-resolves
 *  the price string so this layer carries no money-formatting logic. `priceLabel`
 *  is null for free items. A price is commerce metadata, not a runtime access
 *  decision; every catalog item keeps the same add/open affordance. */
export interface MarketplaceCardData {
	/** True when the installed language pack is the selected runtime pack. */
	active?: boolean;
	author: string | null;
	/** True while a checkout for this card is in flight. */
	buying?: boolean;
	/** Store-taxonomy category (carried for callers; not part of the card chrome). */
	category?: string | null;
	description: string | null;
	/** Resolvable logo URL; falls back to the item's initial when null/absent. */
	iconUrl?: string | null;
	id: string;
	/** True when a language pack is present on the active node. */
	installed?: boolean;
	/** True while a language pack install/enable request is running. */
	installing?: boolean;
	kind: MarketplaceItemKind;
	languagePack?: {
		baseLocale: string;
		direction: "ltr" | "rtl";
		locale: string;
		messageCount: number;
	} | null;
	/** The listing is covered by the A Major Pass eligibility pool. */
	membershipIncluded?: boolean;
	name: string;
	/** Install or enable a language pack. */
	onInstall?: () => void;
	/** Whether the active org already owns this paid item. */
	owned: boolean;
	/** Pre-formatted price (e.g. "$4" or "$9/mo"), or null when the item is free. */
	priceLabel: string | null;
	/** Mean review rating; the compact star row renders when `ratingCount > 0`. */
	ratingAverage?: number;
	/** Number of reviews behind the average. */
	ratingCount?: number;
	verification: MarketplaceVerification;
	version: string;
}

export interface MarketplaceKindOption {
	label: string;
	value: MarketplaceItemKind;
}

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
			<Badge className="gap-1" variant="secondary">
				<HugeiconsIcon
					className="size-3 text-emerald-500"
					icon={ShieldKeyIcon}
				/>
				Verified
			</Badge>
		);
	}
	if (status === "unsigned") {
		return (
			<Badge className="gap-1" variant="outline">
				<HugeiconsIcon className="size-3 text-amber-500" icon={Alert02Icon} />
				Unsigned
			</Badge>
		);
	}
	if (status === "invalid") {
		return (
			<Badge className="gap-1" variant="destructive">
				<HugeiconsIcon className="size-3" icon={UnavailableIcon} />
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
function MarketplaceCardLogo({
	iconUrl,
	name,
}: {
	iconUrl?: string | null;
	name: string;
}) {
	return (
		<span
			className={cn(
				APP_ICON_TILE_CARD,
				APP_ICON_TILE_CARD_SURFACE,
				APP_ICON_TILE_CARD_GLYPH,
				"size-10"
			)}
		>
			{iconUrl ? (
				<img
					alt={`${name} logo`}
					className="size-full object-cover"
					loading="lazy"
					src={iconUrl}
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
function MarketplaceCardRating({
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
				className="size-3 text-amber-400"
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
	const isPaid = card.priceLabel !== null;
	const isLanguagePack =
		card.kind === "language_pack" && Boolean(card.onInstall);

	const heading = (
		<div className="flex min-w-0 items-center gap-3 text-left">
			<MarketplaceCardLogo iconUrl={card.iconUrl} name={card.name} />
			<div className="min-w-0">
				<h3 className="truncate font-medium text-sm">{card.name}</h3>
				{card.author ? (
					<p className="truncate text-muted-foreground text-xs">
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

	return (
		<div className="flex flex-col gap-3 rounded-lg border bg-card p-4">
			<div className="flex items-start justify-between gap-2">
				{onOpenDetail ? (
					<button
						className="min-w-0 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
						onClick={onOpenDetail}
						type="button"
					>
						{heading}
					</button>
				) : (
					heading
				)}
				<div className="flex shrink-0 flex-col items-end gap-1">
					{isPaid ? (
						<Badge className="gap-1" variant="secondary">
							<HugeiconsIcon className="size-3" icon={Tag01Icon} />
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
			{card.languagePack ? (
				<p className="text-[11px] text-muted-foreground">
					{card.languagePack.locale} ·{" "}
					{card.languagePack.direction === "rtl"
						? (i18n?.t("language.direction_rtl") ?? "Right to left")
						: (i18n?.t("language.direction_ltr") ?? "Left to right")}{" "}
					·{" "}
					{i18n?.t("language.translation_count", {
						count: card.languagePack.messageCount,
					}) ?? `${card.languagePack.messageCount} translated strings`}
				</p>
			) : null}

			<div className="mt-auto flex items-center justify-between gap-2">
				<Badge className="text-[10px]" variant="outline">
					v{card.version}
				</Badge>
				{isLanguagePack ? (
					card.active ? (
						<Badge className="gap-1" variant="secondary">
							<HugeiconsIcon
								className="size-3.5 text-emerald-500"
								icon={CheckmarkBadge04Icon}
							/>
							{i18n?.t("common.active") ?? "Active"}
						</Badge>
					) : (
						<Button
							loading={card.installing}
							onClick={card.onInstall}
							size="sm"
						>
							{card.installed
								? (i18n?.t("common.enable") ?? "Enable")
								: (i18n?.t("common.install") ?? "Install")}
						</Button>
					)
				) : isPaid ? (
					card.owned ? (
						<Badge className="gap-1" variant="secondary">
							<HugeiconsIcon
								className="size-3.5 text-emerald-500"
								icon={CheckmarkBadge04Icon}
							/>
							{i18n?.t("common.owned") ?? "Owned"}
						</Badge>
					) : (
						<Button loading={card.buying} onClick={onBuy} size="sm">
							{!card.buying && (
								<HugeiconsIcon
									className="mr-2 size-3.5"
									icon={DollarCircleIcon}
								/>
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

/** The Browse tab body: kind filter, search, and the result grid / states. */
export function MarketplaceBrowseView({
	kinds,
	activeKind,
	onSelectKind = noop,
	query,
	onQueryChange = noop,
	loading,
	error,
	cards,
	onBuy = noop,
	onRefresh = noop,
	onOpenDetail,
}: {
	kinds: MarketplaceKindOption[];
	activeKind: MarketplaceItemKind;
	onSelectKind?: (kind: MarketplaceItemKind) => void;
	query: string;
	onQueryChange?: (value: string) => void;
	loading: boolean;
	error: string | null;
	cards: MarketplaceCardData[];
	onBuy?: (card: MarketplaceCardData) => void;
	onRefresh?: () => void;
	/** When provided, cards become clickable and invoke this with the card. */
	onOpenDetail?: (card: MarketplaceCardData) => void;
}) {
	const i18n = useOptionalI18n();
	let body: ReactNode;
	if (loading && cards.length === 0) {
		body = (
			<div className="flex items-center justify-center p-10 text-muted-foreground">
				<Spinner className="size-5" />
			</div>
		);
	} else if (error) {
		body = (
			<Empty className="py-12">
				<EmptyHeader>
					<EmptyMedia variant="icon">
						<HugeiconsIcon icon={Alert02Icon} />
					</EmptyMedia>
					<EmptyTitle>
						{i18n?.t(
							"marketplace.load-error",
							undefined,
							"Couldn't load the marketplace"
						) ?? "Couldn't load the marketplace"}
					</EmptyTitle>
					<EmptyDescription>{error}</EmptyDescription>
				</EmptyHeader>
				<EmptyContent>
					<Button onClick={onRefresh} size="sm" variant="ghost">
						{i18n?.t("common.try-again", undefined, "Try again") ?? "Try again"}
					</Button>
				</EmptyContent>
			</Empty>
		);
	} else if (cards.length === 0) {
		body = (
			<Empty className="py-12">
				<EmptyHeader>
					<EmptyMedia variant="icon">
						<HugeiconsIcon icon={Store01Icon} />
					</EmptyMedia>
					<EmptyTitle>
						{i18n?.t(
							"marketplace.nothing-here",
							undefined,
							"Nothing here yet"
						) ?? "Nothing here yet"}
					</EmptyTitle>
					<EmptyDescription>
						{i18n?.t(
							"marketplace.no-kind-match",
							{ kind: activeKind },
							`No published ${activeKind} items match. Try another category or search.`
						) ??
							`No published ${activeKind} items match. Try another category or search.`}
					</EmptyDescription>
				</EmptyHeader>
				<EmptyContent>
					<Button
						onClick={() => (query.trim() ? onQueryChange("") : onRefresh())}
						size="sm"
						variant="ghost"
					>
						{query.trim()
							? (i18n?.t("common.clear-search", undefined, "Clear search") ??
								"Clear search")
							: (i18n?.t(
									"marketplace.refresh",
									undefined,
									"Refresh marketplace"
								) ?? "Refresh marketplace")}
					</Button>
				</EmptyContent>
			</Empty>
		);
	} else {
		body = (
			<div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
				{cards.map((card) => (
					<MarketplaceItemCard
						card={card}
						key={`${card.kind}:${card.id}`}
						onBuy={() => onBuy(card)}
						onOpenDetail={onOpenDetail ? () => onOpenDetail(card) : undefined}
					/>
				))}
			</div>
		);
	}

	return (
		<div className="flex flex-col gap-4 p-4">
			<div className="flex flex-wrap items-center justify-between gap-3">
				<div className="flex flex-wrap items-center gap-1">
					{kinds.map((k) => (
						<Button
							key={k.value}
							onClick={() => onSelectKind(k.value)}
							size="sm"
							variant={activeKind === k.value ? "secondary" : "ghost"}
						>
							{k.label}
						</Button>
					))}
				</div>
				<div className="relative w-full max-w-sm">
					<HugeiconsIcon
						className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
						icon={Search01Icon}
					/>
					<Input
						className="h-9 pl-9 text-sm"
						onChange={(e) => onQueryChange(e.target.value)}
						placeholder="Search the marketplace…"
						value={query}
					/>
				</div>
			</div>

			{body}

			<div className="flex justify-end">
				<Button onClick={onRefresh} size="sm" variant="ghost">
					<HugeiconsIcon className="mr-2 size-3.5" icon={Refresh01Icon} />
					{i18n?.t("common.refresh", undefined, "Refresh") ?? "Refresh"}
				</Button>
			</div>
		</div>
	);
}

/** Header tab bar shared by the Marketplace page (Browse / Licenses / Sell). */
export function MarketplaceHeader({
	tabs,
	activeTab,
	onSelectTab = noop,
}: {
	tabs: { value: string; label: string }[];
	activeTab: string;
	onSelectTab?: (value: string) => void;
}) {
	const i18n = useOptionalI18n();
	return (
		<div className="flex shrink-0 items-center gap-1 border-b px-4 py-3">
			<HugeiconsIcon
				className="mr-2 size-5 text-muted-foreground"
				icon={Store01Icon}
			/>
			<h1 className="mr-4 font-semibold text-base">
				{i18n?.t("common.marketplace") ?? "Marketplace"}
			</h1>
			{tabs.map((t) => (
				<Button
					key={t.value}
					onClick={() => onSelectTab(t.value)}
					size="sm"
					variant={activeTab === t.value ? "secondary" : "ghost"}
				>
					{t.label}
				</Button>
			))}
		</div>
	);
}
