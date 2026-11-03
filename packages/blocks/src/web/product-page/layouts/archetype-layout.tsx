import { cn } from "@ryu/ui/lib/utils";
import { Fragment, type ReactNode } from "react";
import type { Product } from "../../data/products.tsx";
import {
	ARCHETYPE_SECTION_ORDER,
	ARCHETYPE_SIDE_BY_SIDE,
	getProductArchetype,
	PRODUCT_SIDE_BY_SIDE_TEST_ID,
} from "../archetypes.ts";
import type { ProductProfile, ProductSectionKey } from "../profile-types.ts";
import { getProductProfile } from "../profiles.ts";
import {
	ProductSectionNav,
	SECTION_ANCHOR_CLASS,
} from "../sections/section-nav.tsx";
import {
	ARCHETYPE_THEMES,
	BAND_CLASSES,
	RHYTHM_CLASSES,
	type SectionBand,
} from "./archetype-theme.ts";
import {
	groupSections,
	renderedKeys,
	sectionAnchorId,
	sectionNavItems,
	splitHead,
} from "./layout-plan.ts";
import { buildSectionSlots, type SectionSlots } from "./section-slots.tsx";

/** Anchored slots clear the sticky header and sub-nav when scrolled to. */
const anchorClass = SECTION_ANCHOR_CLASS;

function Slot({
	sectionKey,
	band,
	children,
}: {
	sectionKey: ProductSectionKey;
	band?: SectionBand;
	children: ReactNode;
}) {
	return (
		<div
			className={cn(anchorClass, band && BAND_CLASSES[band])}
			data-product-band={band}
			data-product-section={sectionKey}
			data-product-slot={band ? "band" : "plain"}
			id={sectionAnchorId(sectionKey)}
		>
			{children}
		</div>
	);
}

/**
 * Two sections in one band, side by side from lg up (code beside the ways to
 * call it). Each half keeps its own anchor; DOM order is the archetype order.
 */
function SideBySide({
	keys,
	slots,
	band = "muted",
}: {
	keys: readonly [ProductSectionKey, ProductSectionKey];
	slots: SectionSlots;
	band?: SectionBand;
}) {
	return (
		<div
			className={BAND_CLASSES[band]}
			data-product-band={band}
			data-product-slot="band"
			data-testid={PRODUCT_SIDE_BY_SIDE_TEST_ID}
		>
			<div className="mx-auto grid w-full max-w-6xl lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)] [&_.landing-section]:max-w-none">
				{keys.map((key) => (
					<div
						className={cn("min-w-0", anchorClass)}
						data-product-section={key}
						id={sectionAnchorId(key)}
						key={key}
					>
						{slots[key]}
					</div>
				))}
			</div>
		</div>
	);
}

/**
 * The page body for one product: hero and figure as they always were, then
 * the in-page sub-nav, then the archetype's sections in its order, with its
 * rhythm and bands (./archetype-theme.ts). `profile` defaults to the
 * registered one; `null` renders without a profile (tests, previews).
 */
export function ArchetypeLayout({
	product,
	profile: profileOverride,
	compareNames,
}: {
	product: Product;
	profile?: ProductProfile | null;
	compareNames?: Readonly<Record<string, string>>;
}) {
	const profile =
		profileOverride === undefined
			? getProductProfile(product.slug)
			: (profileOverride ?? undefined);
	const archetype = getProductArchetype(product.slug);
	const theme = ARCHETYPE_THEMES[archetype];
	const slots = buildSectionSlots({
		archetype,
		compareNames,
		product,
		profile,
		theme,
	});
	const keys = renderedKeys(
		ARCHETYPE_SECTION_ORDER[archetype],
		(key) => slots[key] !== null && slots[key] !== undefined
	);
	const { head, body } = splitHead(keys);
	const groups = groupSections(body, ARCHETYPE_SIDE_BY_SIDE[archetype]);

	return (
		<>
			{head.map((key) => (
				<Fragment key={key}>{slots[key]}</Fragment>
			))}
			<ProductSectionNav
				items={sectionNavItems(body)}
				productName={product.name}
			/>
			<div
				className={RHYTHM_CLASSES[theme.rhythm]}
				data-product-archetype={archetype}
				data-product-rhythm={theme.rhythm}
			>
				{groups.map((group) =>
					group.kind === "pair" ? (
						<SideBySide
							band={theme.sideBySideBand}
							key={group.keys.join("+")}
							keys={group.keys}
							slots={slots}
						/>
					) : (
						<Slot
							band={theme.bands[group.key]}
							key={group.key}
							sectionKey={group.key}
						>
							{slots[group.key]}
						</Slot>
					)
				)}
			</div>
		</>
	);
}
