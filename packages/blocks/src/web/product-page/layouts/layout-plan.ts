import { PRODUCT_SECTION_NAV } from "../archetypes.ts";
import type { ProductSectionKey } from "../profile-types.ts";

/** Sections drawn above the sub-nav, outside the archetype body. */
export const HEAD_SECTION_KEYS: readonly ProductSectionKey[] = [
	"hero",
	"figure",
];

export type LayoutGroup =
	| { readonly kind: "single"; readonly key: ProductSectionKey }
	| {
			readonly kind: "pair";
			readonly keys: readonly [ProductSectionKey, ProductSectionKey];
	  };

/** The keys of `order` whose slot rendered something, in order. */
export function renderedKeys(
	order: readonly ProductSectionKey[],
	isRendered: (key: ProductSectionKey) => boolean
): ProductSectionKey[] {
	return order.filter(isRendered);
}

/**
 * Splits rendered keys into the head and the body. The head is the leading run
 * of head keys only: an archetype that lists its figure after a signature
 * section (code, catalog, status) draws that section under the sub-nav first
 * and the figure later, in the body.
 */
export function splitHead(keys: readonly ProductSectionKey[]): {
	head: ProductSectionKey[];
	body: ProductSectionKey[];
} {
	let length = 0;
	while (
		length < keys.length &&
		HEAD_SECTION_KEYS.includes(keys[length] as ProductSectionKey)
	) {
		length++;
	}
	return { head: keys.slice(0, length), body: keys.slice(length) };
}

/** The anchor id a section's slot carries, if it has a sub-nav entry. */
export function sectionAnchorId(key: ProductSectionKey): string | undefined {
	return PRODUCT_SECTION_NAV[key]?.id;
}

/**
 * Sub-nav entries for the rendered body, in page order. An id appears once
 * (features and explorer share "features").
 */
export function sectionNavItems(
	keys: readonly ProductSectionKey[]
): { id: string; label: string }[] {
	const seen = new Set<string>();
	const items: { id: string; label: string }[] = [];
	for (const key of keys) {
		const entry = PRODUCT_SECTION_NAV[key];
		if (!entry || seen.has(entry.id)) {
			continue;
		}
		seen.add(entry.id);
		items.push({ id: entry.id, label: entry.label });
	}
	return items;
}

/**
 * Groups the body into single sections and, when both halves of the
 * archetype's side-by-side pair rendered and sit next to each other, one pair.
 * DOM order never changes.
 */
export function groupSections(
	keys: readonly ProductSectionKey[],
	pair?: readonly [ProductSectionKey, ProductSectionKey]
): LayoutGroup[] {
	const groups: LayoutGroup[] = [];
	for (let index = 0; index < keys.length; index++) {
		const key = keys[index] as ProductSectionKey;
		const next = keys[index + 1];
		if (pair && key === pair[0] && next === pair[1]) {
			groups.push({ kind: "pair", keys: [key, next] });
			index++;
			continue;
		}
		groups.push({ kind: "single", key });
	}
	return groups;
}
