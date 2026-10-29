import { cn } from "@ryu/ui/lib/utils";
import { ArrowUpRight } from "lucide-react";
import Link from "next/link";
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
import { ProductRealmScene } from "./product-realm-scenes.tsx";
import styles from "./product-realm-selector.module.css";

/** The launch products lead the grid; the other released products follow. */
const LEAD_PRODUCT_IDS: readonly string[] = ["gateway", "console", "bot"];
const NO_HIDDEN_PRODUCTS: readonly string[] = [];

interface ProductCardData {
	href: string;
	id: string;
	label: string;
	realm?: ProductRealm;
}

function cardFor(item: ProductNavItem): ProductCardData | null {
	const id = productNavKey(item);
	const realm = PRODUCT_REALMS.find((candidate) => candidate.id === item.id);
	if (realm) {
		return { href: realm.href, id, label: realm.label, realm };
	}
	if (isCatalogSceneId(id)) {
		return { href: item.href, id, label: CATALOG_SCENE_NAMES[id] };
	}
	return null;
}

/**
 * The released products the header menu lists, as cards: the three launch
 * products first, then the rest in menu order. `hiddenProductIds` (closed
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
	const lead = LEAD_PRODUCT_IDS.flatMap((id) =>
		cards.filter((card) => card.id === id)
	);
	const rest = cards.filter((card) => !LEAD_PRODUCT_IDS.includes(card.id));
	return [...lead, ...rest];
}

const XL_SPAN: Record<number, string> = {
	1: "xl:col-span-12",
	2: "xl:col-span-6",
	3: "xl:col-span-4",
	4: "xl:col-span-3",
};

/**
 * Wide-screen column classes: the lead cards share the first row evenly,
 * and the rest fill balanced rows of up to four so no row ends with a gap.
 */
function xlSpans(total: number, leadCount: number): string[] {
	const lead = Array.from(
		{ length: leadCount },
		() => XL_SPAN[leadCount] ?? ""
	);
	const rest = total - leadCount;
	const rows = Math.ceil(rest / 4);
	const spans: string[] = [];
	for (let row = 0; row < rows; row += 1) {
		const count = Math.floor(rest / rows) + (row < rest % rows ? 1 : 0);
		for (let index = 0; index < count; index += 1) {
			spans.push(XL_SPAN[count] ?? "");
		}
	}
	return [...lead, ...spans];
}

function ProductExploreLink({ card }: { card: ProductCardData }) {
	const os = card.id === "os";
	return (
		<Link
			className={cn(
				`absolute inset-x-0 bottom-0 z-20 flex items-end justify-between gap-3 px-5 pt-20 pb-5 text-foreground ${styles.explore} focus-visible:outline-2 focus-visible:outline-ring`,
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

function ProductCardScene({ card }: { card: ProductCardData }) {
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
}: {
	card: ProductCardData;
	className?: string;
}) {
	return (
		// The scenes are illustrations, not copy: no text selection or I-beam
		// cursor when a hover or drag crosses their labels.
		<article
			className={cn(
				`group relative isolate min-w-0 cursor-default select-none overflow-hidden rounded-3xl bg-muted/60 text-foreground after:pointer-events-none after:absolute after:inset-0 after:z-30 ${styles.card} after:border after:border-foreground/55 after:opacity-0 after:transition-opacity after:duration-300 focus-within:after:opacity-100 hover:after:opacity-100 motion-reduce:after:transition-none [&_*]:shadow-none [&_*]:ring-0`,
				className
			)}
			data-testid={`product-card-${card.id}`}
		>
			<div className="absolute inset-0">
				<ProductCardScene card={card} />
			</div>
			<div
				aria-hidden="true"
				className={
					card.id === "os"
						? "pointer-events-none absolute inset-x-0 bottom-0 z-10 h-14 bg-gradient-to-t from-black/70 to-transparent"
						: `pointer-events-none absolute inset-x-0 bottom-0 z-10 h-28 bg-gradient-to-t from-muted via-muted/85 to-transparent ${styles.scrim}`
				}
			/>
			<ProductExploreLink card={card} />
		</article>
	);
}

export function ProductRealmSelector({
	hiddenProductIds = NO_HIDDEN_PRODUCTS,
}: {
	/** Product slugs the host has not rolled out (see `homeProductCards`). */
	hiddenProductIds?: readonly string[];
}) {
	const cards = homeProductCards(hiddenProductIds);
	const leadCount = cards.filter((card) =>
		LEAD_PRODUCT_IDS.includes(card.id)
	).length;
	const spans = xlSpans(cards.length, leadCount);
	return (
		<section
			aria-label="Products"
			className="border-border/60 border-t text-foreground"
			data-testid="product-paths"
		>
			<div className="mx-auto max-w-7xl px-4 py-14 sm:px-6 md:py-20 lg:px-8">
				<div
					className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:auto-rows-[minmax(8rem,auto)] xl:grid-cols-12"
					data-testid="product-bento-grid"
				>
					{cards.map((card, index) => (
						<ProductCard
							card={card}
							className={cn("min-h-[18rem] sm:col-span-1", spans[index])}
							key={card.id}
						/>
					))}
				</div>
			</div>
		</section>
	);
}
