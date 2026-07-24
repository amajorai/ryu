// apps/desktop/src/components/store/StoreHome.tsx
//
// The Store's "Home" section — an app-store landing feed centered in the same
// max-width column as every other catalog tab, so its header lines up with them.
// A giant dithered featured carousel sits up top; below it, one 2-column grid per
// realm using the SAME card the catalog tabs render (StoreCatalogCard). It is a
// ROUTER, not an installer: every card hands a click back to the shell to open
// that realm's own section, where the real detail + install flow lives.

import { ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import StoreCatalogCard from "@ryu/marketplace/catalog/chrome/store-catalog-card";
import { StoreCardGrid } from "@ryu/marketplace/catalog/chrome/store-catalog-layout";
import {
	Carousel,
	type CarouselApi,
	CarouselContent,
	CarouselItem,
} from "@ryu/ui/components/carousel";
import {
	DitherGradient,
	type GradientDirection,
} from "@ryu/ui/components/dither-kit/gradient";
import type { DitherColor } from "@ryu/ui/components/dither-kit/palette";
import { Spinner } from "@ryu/ui/components/spinner";
import { cn } from "@ryu/ui/lib/utils";
import { useEffect, useState } from "react";
import {
	type HomeCard,
	type HomeFeaturedItem,
	type HomeRow,
	useStoreHome,
} from "@/src/hooks/useStoreHome.ts";
import type { StoreSearchRealm } from "@/src/hooks/useStoreSearch.ts";

/** The six vivid dither hues (grey is the no-data fill, skipped here). A featured
 *  slide picks one deterministically from its id, so the carousel is colourful but
 *  stable across renders. */
const FEATURED_COLORS: readonly DitherColor[] = [
	"blue",
	"purple",
	"pink",
	"orange",
	"green",
	"red",
];
const FEATURED_DIRECTIONS: readonly GradientDirection[] = [
	"up",
	"down",
	"left",
	"right",
];

/** Stable 32-bit-ish hash of a string, so the same id always paints the same
 *  colour/direction (no Math.random → no reshuffle on every render). */
function hashSeed(seed: string): number {
	let h = 0;
	for (let i = 0; i < seed.length; i++) {
		h = (h * 31 + seed.charCodeAt(i)) | 0;
	}
	return Math.abs(h);
}

/** First letter of a name as a fallback glyph, matching the catalog card's icon
 *  square treatment (a muted rounded square with the initial). */
function initialGlyph(name: string) {
	return (
		<span className="font-medium text-muted-foreground text-sm uppercase">
			{name.trim().charAt(0) || "?"}
		</span>
	);
}

export default function StoreHome({
	onOpenRealm,
}: {
	onOpenRealm: (realm: StoreSearchRealm, query: string) => void;
}) {
	const { featured, rows, loading } = useStoreHome();

	return (
		<div className="scroll-fade-effect-y h-full overflow-auto">
			<div className="mx-auto flex w-full max-w-4xl flex-col gap-8 px-4 pt-4 pb-12">
				<p className="font-semibold text-lg">Home</p>

				{featured.length > 0 ? (
					<FeaturedCarousel items={featured} onOpenRealm={onOpenRealm} />
				) : null}

				{loading && rows.length === 0 ? (
					<div className="flex items-center justify-center py-10 text-muted-foreground">
						<Spinner className="size-5" />
					</div>
				) : (
					rows.map((row) => (
						<HomeSection
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

/** Auto-advance interval; the active dot's fill doubles as the "time left" bar. */
const SLIDE_MS = 5000;

function FeaturedCarousel({
	items,
	onOpenRealm,
}: {
	items: HomeFeaturedItem[];
	onOpenRealm: (realm: StoreSearchRealm, query: string) => void;
}) {
	const [api, setApi] = useState<CarouselApi>();
	const [selected, setSelected] = useState(0);
	const [count, setCount] = useState(0);
	const [paused, setPaused] = useState(false);

	useEffect(() => {
		if (!api) {
			return;
		}
		const sync = () => {
			setCount(api.scrollSnapList().length);
			setSelected(api.selectedScrollSnap());
		};
		sync();
		api.on("select", sync);
		api.on("reInit", sync);
		return () => {
			api.off("select", sync);
			api.off("reInit", sync);
		};
	}, [api]);

	// Manual autoplay — no embla-autoplay dep. Advance one slide per SLIDE_MS,
	// re-armed whenever the slide changes (a manual scroll resets the timer) and
	// paused while the pointer hovers the hero.
	useEffect(() => {
		if (!api || count <= 1 || paused) {
			return;
		}
		const id = setTimeout(() => api.scrollNext(), SLIDE_MS);
		return () => clearTimeout(id);
	}, [api, count, selected, paused]);

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: hover only pauses autoplay; all controls remain keyboard-reachable
		<div
			onMouseEnter={() => setPaused(true)}
			onMouseLeave={() => setPaused(false)}
		>
			<Carousel className="w-full" opts={{ loop: true }} setApi={setApi}>
				<CarouselContent>
					{items.map((item) => {
						const seed = hashSeed(`${item.card.kind}:${item.card.id}`);
						return (
							<CarouselItem key={`${item.card.kind}:${item.card.id}`}>
								<FeaturedSlide
									color={FEATURED_COLORS[seed % FEATURED_COLORS.length]}
									direction={
										FEATURED_DIRECTIONS[seed % FEATURED_DIRECTIONS.length]
									}
									item={item}
									onClick={() => onOpenRealm(item.realm, item.card.name)}
								/>
							</CarouselItem>
						);
					})}
				</CarouselContent>
			</Carousel>

			{count > 1 ? (
				<div className="mt-3 flex items-center justify-center gap-1.5">
					{Array.from({ length: count }, (_, i) => i).map((i) => (
						<button
							aria-label={`Go to slide ${i + 1}`}
							className={cn(
								"h-1.5 overflow-hidden rounded-full transition-all",
								i === selected
									? "w-6 bg-muted"
									: "w-1.5 bg-muted-foreground/30 hover:bg-muted-foreground/50"
							)}
							key={i}
							onClick={() => api?.scrollTo(i)}
							type="button"
						>
							{i === selected ? (
								<span
									className="block h-full origin-left rounded-full bg-foreground"
									key={selected}
									style={{
										animation: `ryu-carousel-progress ${SLIDE_MS}ms linear forwards`,
										animationPlayState: paused ? "paused" : "running",
									}}
								/>
							) : null}
						</button>
					))}
				</div>
			) : null}
		</div>
	);
}

function FeaturedSlide({
	item,
	color,
	direction,
	onClick,
}: {
	item: HomeFeaturedItem;
	color: DitherColor;
	direction: GradientDirection;
	onClick: () => void;
}) {
	const { card } = item;
	return (
		<button
			className="group relative flex min-h-[13rem] w-full flex-col justify-end overflow-hidden rounded-3xl border border-border/60 bg-card p-6 text-left transition-transform"
			onClick={onClick}
			type="button"
		>
			<DitherGradient
				className="absolute inset-0"
				direction={direction}
				from={color}
				opacity={0.9}
				to="transparent"
			/>
			<div className="relative flex items-end gap-4">
				<FeaturedLogo iconUrl={card.iconUrl ?? null} name={card.name} />
				<div className="min-w-0 flex-1">
					<span className="block font-medium text-[11px] text-white/80 uppercase tracking-wide">
						Staff pick · {card.kind}
					</span>
					<span className="mt-0.5 block truncate font-semibold text-white text-xl">
						{card.name}
					</span>
					{card.description ? (
						<p className="mt-1 line-clamp-2 max-w-xl text-sm text-white/80">
							{card.description}
						</p>
					) : null}
				</div>
				<HugeiconsIcon
					className="mb-1 size-5 shrink-0 text-white/70 transition-transform group-hover:translate-x-0.5"
					icon={ArrowRight01Icon}
				/>
			</div>
		</button>
	);
}

function FeaturedLogo({
	iconUrl,
	name,
}: {
	iconUrl: string | null;
	name: string;
}) {
	if (iconUrl) {
		return (
			<img
				alt={`${name} logo`}
				className={cn(
					"size-14 shrink-0 rounded-2xl border border-white/20 object-cover"
				)}
				loading="lazy"
				src={iconUrl}
			/>
		);
	}
	return (
		<span
			aria-hidden="true"
			className="flex size-14 shrink-0 items-center justify-center rounded-2xl border border-white/20 bg-white/15 font-semibold text-2xl text-white uppercase backdrop-blur-sm"
		>
			{name.trim().charAt(0) || "?"}
		</span>
	);
}

function HomeSection({ row, onOpen }: { row: HomeRow; onOpen: () => void }) {
	return (
		<section>
			<button
				className="group mb-2 flex items-center gap-2 text-foreground"
				onClick={onOpen}
				type="button"
			>
				<span className="font-semibold text-base tracking-tight">
					{row.label}
				</span>
				<span className="flex items-center gap-0.5 text-muted-foreground text-xs transition-colors group-hover:text-foreground">
					See all
					<HugeiconsIcon className="size-3.5" icon={ArrowRight01Icon} />
				</span>
			</button>
			<StoreCardGrid>
				{row.items.slice(0, 6).map((item: HomeCard) => (
					<StoreCatalogCard
						description={item.description}
						icon={initialGlyph(item.name)}
						iconUrl={item.iconUrl}
						key={item.id}
						name={item.name}
						onClick={onOpen}
						seedId={item.id}
					/>
				))}
			</StoreCardGrid>
		</section>
	);
}
