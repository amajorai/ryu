import { cn } from "@ryu/ui/lib/utils";
import { ArrowUpRight } from "lucide-react";
import Link from "next/link";
import { isStageProductSlug } from "./backgrounds/stage-routes.ts";
import {
	PRODUCT_REALMS,
	type ProductNavItem,
	type ProductRealm,
	productMenuItemsFor,
	productNavKey,
} from "./data/product-realms.ts";
import { nextLinkHref } from "./next-link-href.ts";
import {
	CATALOG_SCENE_NAMES,
	isCatalogSceneId,
	ProductCatalogScene,
} from "./product-catalog-scenes.tsx";
import { ProductFigureDrawing } from "./product-figure.tsx";
import { PRODUCT_FIGURE_BY_SLUG } from "./product-figure-by-slug.ts";
import { ProductRealmScene } from "./product-realm-scenes.tsx";
import styles from "./product-realm-selector.module.css";
import { SectionTitle } from "./section-title.tsx";

/**
 * The card groups, top to bottom in priority order, each under its own heading:
 * get started (Bot, Desktop) and run it (Agent, Gateway), build on it, then the
 * platform underneath. A released product missing from every list joins the
 * last group.
 */
const CARD_GROUPS: readonly { ids: readonly string[]; title: string }[] = [
	{ title: "Get started", ids: ["bot", "desktop", "console", "gateway"] },
	{
		title: "Build",
		ids: ["agents", "skills", "marketplace", "sdk", "workflows"],
	},
	{ title: "Platform", ids: ["core", "cloud"] },
];

const CARD_PRIORITY: readonly string[] = CARD_GROUPS.flatMap(
	(group) => group.ids
);
const NO_HIDDEN_PRODUCTS: readonly string[] = [];

interface ProductCardData {
	/** The menu's one-line summary; read to assistive tech, as the scene is decorative. */
	description: string;
	href: string;
	id: string;
	label: string;
	realm?: ProductRealm;
}

function cardFor(item: ProductNavItem): ProductCardData | null {
	const id = productNavKey(item);
	const realm = PRODUCT_REALMS.find((candidate) => candidate.id === item.id);
	if (realm) {
		return {
			description: item.description,
			href: realm.href,
			id,
			label: realm.label,
			realm,
		};
	}
	if (isCatalogSceneId(id)) {
		return {
			description: item.description,
			href: item.href,
			id,
			label: CATALOG_SCENE_NAMES[id],
		};
	}
	return null;
}

/**
 * The released products the header menu lists, as cards, in `CARD_PRIORITY`
 * order. `hiddenProductIds` (closed
 * services and unlaunched products) drops cards the same way it drops menu
 * items.
 */
export function homeProductCards(
	hiddenProductIds: readonly string[] = NO_HIDDEN_PRODUCTS
): ProductCardData[] {
	const cards = productMenuItemsFor(hiddenProductIds).flatMap((item) => {
		const card = cardFor(item);
		return card ? [card] : [];
	});
	const ranked = CARD_PRIORITY.flatMap((id) =>
		cards.filter((card) => card.id === id)
	);
	const rest = cards.filter((card) => !CARD_PRIORITY.includes(card.id));
	return [...ranked, ...rest];
}

type CardSize = "big" | "wide" | "small" | "tall" | "single";

/** Wide-screen grid placement per card size (a 12-column grid, rows of equal height). */
const SIZE_CLASS: Record<CardSize, string> = {
	big: "xl:col-span-6 xl:row-span-2",
	wide: "xl:col-span-6",
	small: "xl:col-span-3",
	tall: "xl:col-span-4 xl:row-span-2",
	single: "xl:col-span-4",
};

const EVEN_SPAN: Record<number, string> = {
	1: "xl:col-span-12",
	2: "xl:col-span-6",
	3: "xl:col-span-4",
};

interface CardPlacement {
	className: string;
	size: CardSize;
}

/**
 * One group's wide-screen bento. A lead group opens with a block of one big
 * card (two rows) beside a wide card over two small ones; the rest come in
 * blocks of four, two tall cards with two single ones stacked between them. A remainder
 * of two splits a row unevenly and one or three share it evenly, so every row
 * ends flush. The grid flows dense, so the stacked cards fill the gaps.
 */
export function bentoPlacements(
	total: number,
	{ lead = true }: { lead?: boolean } = {}
): CardPlacement[] {
	const leadSizes: CardSize[] =
		lead && total >= 4 ? ["big", "wide", "small", "small"] : [];
	const placements: CardPlacement[] = leadSizes.map((size) => ({
		size,
		className: SIZE_CLASS[size],
	}));
	let rest = total - leadSizes.length;
	while (rest >= 4) {
		for (const size of ["tall", "single", "tall", "single"] as const) {
			placements.push({ size, className: SIZE_CLASS[size] });
		}
		rest -= 4;
	}
	if (rest === 2) {
		placements.push(
			{ size: "single", className: "xl:col-span-7" },
			{ size: "single", className: "xl:col-span-5" }
		);
	} else {
		for (let index = 0; index < rest; index += 1) {
			placements.push({
				size: "single",
				className: EVEN_SPAN[rest] ?? "xl:col-span-4",
			});
		}
	}
	return placements;
}

/**
 * The card's one link. It covers the whole card (above the decorative scene,
 * below the hover border) so every point of the card opens the product; the
 * label and "Explore" cue stay pinned to the bottom edge.
 */
function ProductExploreLink({ card }: { card: ProductCardData }) {
	const os = card.id === "os";
	return (
		<Link
			className={cn(
				`absolute inset-0 z-20 flex items-end justify-between gap-3 rounded-3xl px-5 pb-5 text-foreground ${styles.explore} focus-visible:outline-2 focus-visible:outline-ring`,
				os && "text-white"
			)}
			data-testid={`realm-card-${card.id}`}
			href={nextLinkHref(card.href)}
		>
			<span
				className={cn(
					"relative z-10 font-medium text-foreground text-sm",
					os && "text-white"
				)}
			>
				{card.label}
			</span>
			<span className="sr-only">{card.description}</span>
			<span
				className={cn(
					"inline-flex items-center gap-1 text-muted-foreground text-xs opacity-60 transition-opacity duration-500 group-focus-within:opacity-100 group-hover:opacity-100 motion-reduce:opacity-100 motion-reduce:transition-none",
					os && "text-white/80"
				)}
			>
				Explore
				<ArrowUpRight aria-hidden="true" className="size-3.5" />
			</span>
		</Link>
	);
}

/** The product page's slug (`/bot`, `/agent`, `/products/<slug>`) behind a card. */
function cardSlug(card: ProductCardData): string {
	return card.href.split("/").filter(Boolean).at(-1) ?? card.id;
}

/**
 * The card's drawing: the product page's own Anatomy figure, fitted inside the
 * card above its label, on paper matched to the card so the figure's occluding
 * faces blend in. Products without a figure keep their flat scene.
 */
function ProductCardScene({ card }: { card: ProductCardData }) {
	const slug = cardSlug(card);
	if (isStageProductSlug(slug)) {
		return (
			<div
				className={`absolute inset-x-0 top-0 bottom-12 flex items-center justify-center px-6 pt-5 ${styles.figure}`}
				data-testid={`realm-visual-${card.id}`}
			>
				<ProductFigureDrawing figure={PRODUCT_FIGURE_BY_SLUG[slug]} />
			</div>
		);
	}
	if (card.realm) {
		return <ProductRealmScene id={card.realm.id} />;
	}
	return isCatalogSceneId(card.id) ? (
		<ProductCatalogScene id={card.id} />
	) : null;
}

function ProductCard({
	card,
	className,
	size,
}: {
	card: ProductCardData;
	className?: string;
	size: CardSize;
}) {
	return (
		// The scenes are illustrations, not copy: no text selection or I-beam
		// cursor when a hover or drag crosses their labels.
		<article
			className={cn(
				`group relative isolate min-w-0 cursor-default select-none overflow-hidden rounded-3xl bg-muted/60 text-foreground after:pointer-events-none after:absolute after:inset-0 after:z-30 ${styles.card} after:border after:border-foreground/55 after:opacity-0 after:transition-opacity after:duration-300 focus-within:after:opacity-100 hover:after:opacity-100 motion-reduce:after:transition-none [&_*]:shadow-none [&_*]:ring-0`,
				className
			)}
			data-card-size={size}
			data-testid={`product-card-${card.id}`}
		>
			<div className="pointer-events-none absolute inset-0">
				<ProductCardScene card={card} />
			</div>
			{card.id === "os" ? (
				// The OS scene is a full-bleed image: a dark fade keeps its white label legible.
				<div
					aria-hidden="true"
					className="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-14 bg-gradient-to-t from-black/70 to-transparent"
				/>
			) : null}
			<ProductExploreLink card={card} />
		</article>
	);
}

/** The released cards split into `CARD_GROUPS`, dropping groups left empty. */
export function homeProductGroups(
	hiddenProductIds: readonly string[] = NO_HIDDEN_PRODUCTS
): { cards: ProductCardData[]; title: string }[] {
	const cards = homeProductCards(hiddenProductIds);
	const last = CARD_GROUPS.length - 1;
	return CARD_GROUPS.map((group, index) => ({
		title: group.title,
		cards: cards.filter((card) =>
			index === last
				? !CARD_PRIORITY.includes(card.id) || group.ids.includes(card.id)
				: group.ids.includes(card.id)
		),
	})).filter((group) => group.cards.length > 0);
}

function ProductCardGroup({
	cards,
	lead,
	title,
}: {
	cards: ProductCardData[];
	lead: boolean;
	title: string;
}) {
	const placements = bentoPlacements(cards.length, { lead });
	return (
		<div aria-label={title} role="group">
			<SectionTitle className="mb-8 md:mb-10" title={title} />
			<div
				className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-flow-row-dense xl:auto-rows-[17rem] xl:grid-cols-12"
				data-testid="product-bento-grid"
			>
				{cards.map((card, index) => (
					<ProductCard
						card={card}
						className={cn(
							"min-h-[18rem] sm:col-span-1 xl:min-h-0",
							placements[index]?.className
						)}
						key={card.id}
						size={placements[index]?.size ?? "single"}
					/>
				))}
			</div>
		</div>
	);
}

export function ProductRealmSelector({
	hiddenProductIds = NO_HIDDEN_PRODUCTS,
}: {
	/** Product slugs the host has not rolled out (see `homeProductCards`). */
	hiddenProductIds?: readonly string[];
}) {
	return (
		<section
			aria-label="Products"
			className="border-border/60 border-t text-foreground"
			data-testid="product-paths"
		>
			<div className="mx-auto flex max-w-7xl flex-col gap-20 px-4 py-14 sm:px-6 md:gap-28 md:py-20 lg:px-8">
				{homeProductGroups(hiddenProductIds).map((group, index) => (
					<ProductCardGroup
						cards={group.cards}
						key={group.title}
						lead={index === 0}
						title={group.title}
					/>
				))}
			</div>
		</section>
	);
}
