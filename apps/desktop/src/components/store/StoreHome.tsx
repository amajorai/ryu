// apps/desktop/src/components/store/StoreHome.tsx
//
// The Store's "Home" section — a full-bleed app-store landing feed: a featured
// hero rail up top, then one horizontal row per realm. Browse-by-category and
// the store-wide search both live in the shell's nav rail (StoreNavRail), so
// this surface is feed-only. It is a ROUTER, not an installer: every card/row
// hands a click back to the shell to open that realm's section.

import { ArrowRight01Icon, SparklesIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Spinner } from "@ryu/ui/components/spinner";
import { cn } from "@ryu/ui/lib/utils";
import {
	type HomeCard,
	type HomeFeaturedItem,
	type HomeRow,
	useStoreHome,
} from "@/src/hooks/useStoreHome.ts";
import type { StoreSearchRealm } from "@/src/hooks/useStoreSearch.ts";

export default function StoreHome({
	onOpenRealm,
}: {
	onOpenRealm: (realm: StoreSearchRealm, query: string) => void;
}) {
	const { featured, rows, loading } = useStoreHome();

	return (
		<div className="scroll-fade-effect-y h-full overflow-auto">
			<div className="mx-auto flex max-w-5xl flex-col gap-9 p-6 pb-12">
				{featured.length > 0 ? (
					<FeaturedRail items={featured} onOpenRealm={onOpenRealm} />
				) : null}

				{loading && rows.length === 0 ? (
					<div className="flex items-center justify-center py-10 text-muted-foreground">
						<Spinner className="size-5" />
					</div>
				) : (
					rows.map((row) => (
						<HomeRowStrip
							key={row.realm}
							onOpen={() => onOpenRealm(row.realm, "")}
							row={row}
						/>
					))
				)}
			</div>
		</div>
	);
}

function FeaturedRail({
	items,
	onOpenRealm,
}: {
	items: HomeFeaturedItem[];
	onOpenRealm: (realm: StoreSearchRealm, query: string) => void;
}) {
	return (
		<section>
			<div className="mb-3 flex items-center gap-2">
				<HugeiconsIcon className="size-4 text-amber-500" icon={SparklesIcon} />
				<h2 className="font-semibold text-lg tracking-tight">Featured</h2>
			</div>
			<div className="-mx-1 flex gap-3 overflow-x-auto px-1 pb-2">
				{items.map((item) => (
					<button
						className="flex w-72 shrink-0 flex-col justify-between gap-3 rounded-2xl border border-amber-500/20 bg-gradient-to-br from-amber-500/10 to-card p-5 text-left transition-colors hover:border-amber-500/50"
						key={`${item.card.kind}:${item.card.id}`}
						onClick={() => onOpenRealm(item.realm, item.card.name)}
						type="button"
					>
						<div className="flex items-center gap-3">
							<CardLogo iconUrl={item.card.iconUrl} name={item.card.name} />
							<div className="min-w-0">
								<span className="block truncate font-semibold text-sm">
									{item.card.name}
								</span>
								<span className="text-[10px] text-amber-600 uppercase tracking-wide dark:text-amber-400">
									Staff pick · {item.card.kind}
								</span>
							</div>
						</div>
						{item.card.description ? (
							<p className="line-clamp-3 text-muted-foreground text-xs">
								{item.card.description}
							</p>
						) : null}
					</button>
				))}
			</div>
		</section>
	);
}

function HomeRowStrip({ row, onOpen }: { row: HomeRow; onOpen: () => void }) {
	return (
		<section>
			<button
				className="group mb-3 flex items-center gap-2 text-foreground transition-colors"
				onClick={onOpen}
				type="button"
			>
				<span className="font-semibold text-lg tracking-tight">
					{row.label}
				</span>
				<span className="flex items-center gap-0.5 text-muted-foreground text-xs transition-colors group-hover:text-foreground">
					See all
					<HugeiconsIcon className="size-3.5" icon={ArrowRight01Icon} />
				</span>
			</button>
			<div className="-mx-1 flex gap-3 overflow-x-auto px-1 pb-2">
				{row.items.map((item) => (
					<HomeItemCard item={item} key={item.id} onOpen={onOpen} />
				))}
			</div>
		</section>
	);
}

function HomeItemCard({
	item,
	onOpen,
}: {
	item: HomeCard;
	onOpen: () => void;
}) {
	return (
		<button
			className="flex w-56 shrink-0 flex-col gap-2 rounded-xl border border-border bg-card p-4 text-left transition-colors hover:border-foreground/30"
			onClick={onOpen}
			type="button"
		>
			<div className="flex items-center gap-2.5">
				<CardLogo iconUrl={item.iconUrl} name={item.name} />
				<span className="min-w-0 flex-1 truncate font-medium text-sm">
					{item.name}
				</span>
			</div>
			{item.description ? (
				<p className="line-clamp-2 text-muted-foreground text-xs">
					{item.description}
				</p>
			) : null}
			{item.tag ? (
				<span className="mt-auto inline-flex w-fit rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground uppercase tracking-wide">
					{item.tag}
				</span>
			) : null}
		</button>
	);
}

function CardLogo({ iconUrl, name }: { iconUrl: string | null; name: string }) {
	if (iconUrl) {
		return (
			<img
				alt={`${name} logo`}
				className={cn(
					"size-9 shrink-0 rounded-lg border border-border object-cover"
				)}
				loading="lazy"
				src={iconUrl}
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
