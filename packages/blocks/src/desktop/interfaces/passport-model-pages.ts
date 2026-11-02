import type {
	Passport,
	PassportPage,
	PassportSpread,
	PassportStamp,
} from "./passport-model.ts";

/** Openings of the booklet: the closed cover, then pages two at a time. */
export function bookletSpreads(pageCount: number): PassportSpread[] {
	const spreads: PassportSpread[] = [{ left: null, right: 0 }];
	for (let page = 1; page < pageCount; page += 2) {
		spreads.push({
			left: page,
			right: page + 1 < pageCount ? page + 1 : null,
		});
	}
	return spreads;
}

/** One page per view, for narrow windows. */
export function singleSpreads(pageCount: number): PassportSpread[] {
	return Array.from({ length: pageCount }, (_, page) => ({
		left: null,
		right: page,
	}));
}

export function spreadOfPage(
	spreads: readonly PassportSpread[],
	page: number
): number {
	const index = spreads.findIndex(
		(spread) => spread.left === page || spread.right === page
	);
	return Math.max(0, index);
}

/** The first page of a country (null: the unassigned pages), or -1. */
export function countryPage(
	pages: readonly PassportPage[],
	countryId: string | null
): number {
	return pages.findIndex(
		(page) => page.kind === "visa" && page.first && page.countryId === countryId
	);
}

/**
 * Where the booklet opens: the first visa page with a stamp on it (the
 * passport is for its stamps), else the first visa page, else the cover.
 */
export function openingPage(pages: readonly PassportPage[]): number {
	const stamped = pages.findIndex(
		(page) => page.kind === "visa" && page.stamps.length > 0
	);
	if (stamped > 0) {
		return stamped;
	}
	const visa = pages.findIndex((page) => page.kind === "visa");
	return Math.max(0, visa);
}

/** The page a thread's stamp is on, or -1. */
export function stampPage(
	pages: readonly PassportPage[],
	threadId: string
): number {
	return pages.findIndex(
		(page) =>
			page.kind === "visa" &&
			page.stamps.some((stamp) => stamp.thread.id === threadId)
	);
}

export function findStamp(
	passport: Passport,
	threadId: string | null
): PassportStamp | null {
	if (!threadId) {
		return null;
	}
	for (const country of passport.countries) {
		const found = country.stamps.find((stamp) => stamp.thread.id === threadId);
		if (found) {
			return found;
		}
	}
	return (
		passport.unassigned.find((stamp) => stamp.thread.id === threadId) ?? null
	);
}
