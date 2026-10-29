// apps/desktop/src/contributions/contributed-target.ts
//
// The ONE place a contributed route template (`sidebar_sections[].spec.itemTarget`,
// `sidebar_buttons[].target`) is turned into an `openTab` call.
//
// Why it exists: a tab is `(path, options)`, and some destinations live entirely in
// the options half. A conversation is the case that matters — the shell opens one
// with `openTab("/chat", { conversationId })`, and `builtins.ts` registers only the
// exact route `/chat`, so there is NO path a manifest can name that opens a specific
// thread. Without this, an app could list runs in the sidebar but clicking a row
// could only ever land on a blank composer.
//
// The mapping is a strict ALLOWLIST, and that is the security-relevant part. The
// `openTab` options bag also carries `initialPrompt` / `initialSubmit`; spreading
// parsed query parameters into it would let a manifest — text, not code, and
// therefore not something the sandbox review path scrutinises for behaviour — hand
// the user a row that SENDS a message to their agent on click. Only the keys listed
// in {@link CONTRIBUTED_TARGET_PARAMS} cross over; everything else is dropped, and
// the query string is stripped from the path either way (`openTab` keys tabs on the
// bare path, so a stray query would also defeat its reuse/dedup).

/** Options a contributed target may set, mapped from its query string. */
export interface ContributedTargetOptions {
	conversationId?: string;
}

/** A rendered contributed target, split into what `openTab` takes. */
export interface ContributedTarget {
	options: ContributedTargetOptions;
	path: string;
}

/**
 * The allowlisted query parameters, mapped to their `openTab` option. Adding a
 * key here widens what a manifest can drive — weigh it against the note above.
 */
const CONTRIBUTED_TARGET_PARAMS = new Map<
	string,
	keyof ContributedTargetOptions
>([["conversationId", "conversationId"]]);

/**
 * Split an already-templated contributed target into the `(path, options)` pair
 * `openTab` takes. Total: a target with no query, or one carrying only unknown
 * parameters, yields its bare path and empty options — never throws, so a
 * malformed manifest degrades to plain navigation.
 */
export function parseContributedTarget(target: string): ContributedTarget {
	const [path, query] = target.split("?");
	const bare = path ?? target;
	if (!query) {
		return { path: bare, options: {} };
	}
	const options: ContributedTargetOptions = {};
	// URLSearchParams decodes the percent-encoding `renderTemplate({uriEncode})`
	// applied when it substituted the row's value.
	for (const [key, value] of new URLSearchParams(query)) {
		const option = CONTRIBUTED_TARGET_PARAMS.get(key);
		if (option && value) {
			options[option] = value;
		}
	}
	return { path: bare, options };
}
