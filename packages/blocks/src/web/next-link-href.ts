import type { UrlObject } from "node:url";

/** Preserve authored destinations through Next Link's URL-object contract. */
export function nextLinkHref(href: string): UrlObject {
	const hashIndex = href.indexOf("#");
	const hash = hashIndex === -1 ? undefined : href.slice(hashIndex);
	const destination = hashIndex === -1 ? href : href.slice(0, hashIndex);
	const queryIndex = destination.indexOf("?");
	return {
		pathname:
			queryIndex === -1 ? destination : destination.slice(0, queryIndex),
		search: queryIndex === -1 ? undefined : destination.slice(queryIndex),
		hash,
	};
}
