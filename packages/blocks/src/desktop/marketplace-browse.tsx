"use client";

import {
	Alert02Icon,
	Refresh01Icon,
	Search01Icon,
	Store01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages, useOptionalI18n } from "@ryu/i18n/react";
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
import { Spinner } from "@ryu/ui/components/spinner";
import type { ReactNode } from "react";
import { MarketplaceItemCard } from "./marketplace-item-card.tsx";
import type {
	MarketplaceCardData,
	MarketplaceItemKind,
	MarketplaceKindOption,
} from "./marketplace-types.ts";
import {
	STORE_LOAD_ERROR_SENTENCE,
	StoreErrorDetails,
} from "./store-error-details.tsx";

const noop = () => {
	// Default no-op handler for the presentational layer.
};

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
	const tl = useLiteralMessages();
	let body: ReactNode;
	if (loading && cards.length === 0) {
		body = (
			<div className="flex items-center justify-center p-10 text-muted-foreground">
				<Spinner className="size-5" />
			</div>
		);
	} else if (error) {
		body = (
			<Empty>
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
					<EmptyDescription>{STORE_LOAD_ERROR_SENTENCE}</EmptyDescription>
				</EmptyHeader>
				<EmptyContent>
					<Button onClick={onRefresh} size="sm" variant="outline">
						{i18n?.t("common.try-again", undefined, "Try again") ?? "Try again"}
					</Button>
					<StoreErrorDetails message={error} />
				</EmptyContent>
			</Empty>
		);
	} else if (cards.length === 0) {
		body = (
			<Empty>
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
							tl(
								"No published {activeKind} items match. Try another category or search.",
								{ activeKind }
							)}
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
						aria-label="Search the marketplace"
						className="h-9"
						leadingAdornment="default"
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
