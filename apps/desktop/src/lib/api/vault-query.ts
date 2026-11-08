// Query strings for Core vault routes: only defined, non-empty values are sent.

/** `?a=1&b=2` from defined values only, or `""` when nothing is set. */
export function vaultQueryString(
	params: Record<string, string | number | boolean | undefined>
): string {
	const search = new URLSearchParams();
	for (const [key, value] of Object.entries(params)) {
		if (value !== undefined && value !== "") {
			search.set(key, String(value));
		}
	}
	const text = search.toString();
	return text ? `?${text}` : "";
}
