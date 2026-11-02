// The locale the mounted provider shows, readable outside React.
//
// Model files, formatters and code that runs before (or outside) a component
// tree, such as a toast raised from a module callback, have no `useI18n()`.
// The provider registers its runtime here on the client, so `activeLocale()`
// and `translate()` answer in the language the UI is showing. On the server,
// and before any provider mounts, they answer in English: a module-level
// runtime would leak one request's language into another's.

import { formatMessage, type MessageValuesInput } from "./format.ts";
import { messageIdForLiteral } from "./literal-catalog.ts";
import { DEFAULT_LOCALE, type LanguageDirection } from "./pack.ts";

/** What this module reads from the provider's runtime. */
export interface ActiveI18nRuntime {
	readonly direction: LanguageDirection;
	/** The regional tag dates and numbers format in, when it differs from `locale`. */
	readonly formatLocale?: string;
	readonly locale: string;
	translate(id: string, values?: MessageValuesInput, fallback?: string): string;
}

/** Mounted providers' runtimes, outermost first; the last one is active. */
const registered: ActiveI18nRuntime[] = [];
/** A runtime claimed while its provider rendered, not yet committed. */
let claimedInRender: ActiveI18nRuntime | null = null;
let broadcastLocale: string | null = null;
let broadcastQueued = false;
const listeners = new Set<(locale: string) => void>();

function current(): ActiveI18nRuntime | null {
	return registered.at(-1) ?? null;
}

/**
 * The locale the UI formats dates and numbers in, or `"en"` before a
 * provider mounts: the user's regional tag (`pt-PT`, `es-MX`) even while
 * messages come from the pack of that language (`pt-BR`, `es`). Never use it
 * as a catalog or pack key.
 */
export function activeLocale(): string {
	const runtime = current();
	return runtime?.formatLocale ?? runtime?.locale ?? DEFAULT_LOCALE;
}

/** The text direction the UI is showing, or `"ltr"` before a provider mounts. */
export function activeDirection(): LanguageDirection {
	return current()?.direction ?? "ltr";
}

/**
 * Call `listener` with the new locale whenever the shown locale changes.
 * Returns the unsubscribe function.
 */
export function subscribeLocale(
	listener: (locale: string) => void
): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

function broadcast(): void {
	const locale = activeLocale();
	if (locale === broadcastLocale) {
		return;
	}
	broadcastLocale = locale;
	for (const listener of [...listeners]) {
		try {
			listener(locale);
		} catch {
			// One failing listener must not keep the others on the old locale.
		}
	}
}

/**
 * Register a provider's runtime on the client (on mount, and again after
 * each locale change so listeners hear it). Providers register only when
 * they are outermost; if several roots do, the most recently registered is
 * active, and registering again keeps its place.
 */
export function registerActiveI18nRuntime(runtime: ActiveI18nRuntime): void {
	if (claimedInRender === runtime) {
		claimedInRender = null;
	}
	if (!registered.includes(runtime)) {
		registered.push(runtime);
	}
	broadcast();
}

/**
 * Make a provider's runtime active while that provider first renders on the
 * client, so its children format in its locale in the same commit instead of
 * in English until the provider's effects run. It does not notify listeners
 * (that would update other components mid-render); the commit's
 * `registerActiveI18nRuntime` does. A claim the commit never confirms (a
 * render React threw away) is dropped by the next claim.
 */
export function claimActiveI18nRuntimeForRender(
	runtime: ActiveI18nRuntime
): void {
	if (registered.includes(runtime)) {
		return;
	}
	if (claimedInRender !== null) {
		const index = registered.indexOf(claimedInRender);
		if (index >= 0) {
			registered.splice(index, 1);
		}
	}
	claimedInRender = runtime;
	registered.push(runtime);
}

/**
 * Forget a provider's runtime when it unmounts. Listeners hear the resulting
 * locale after the current task, so a provider replaced in the same commit
 * does not flash English at them.
 */
export function unregisterActiveI18nRuntime(runtime: ActiveI18nRuntime): void {
	if (claimedInRender === runtime) {
		claimedInRender = null;
	}
	const index = registered.indexOf(runtime);
	if (index < 0) {
		return;
	}
	registered.splice(index, 1);
	if (!broadcastQueued) {
		broadcastQueued = true;
		queueMicrotask(() => {
			broadcastQueued = false;
			broadcast();
		});
	}
}

/**
 * Translate an English literal outside React, exactly as `useLiteralMessages()`
 * does inside it: through the active runtime's packs and literal catalog,
 * with `values` formatted into the result. Before a provider mounts (and on
 * the server) it formats the English source.
 */
export function translate(
	source: string,
	values: MessageValuesInput = {}
): string {
	const runtime = current();
	if (!runtime) {
		return formatMessage(source, values, DEFAULT_LOCALE);
	}
	const translated = runtime.translate(
		messageIdForLiteral(source),
		values,
		source
	);
	// The runtime returns unknown literal copy verbatim; format it here.
	return translated === source
		? formatMessage(source, values, runtime.formatLocale ?? runtime.locale)
		: translated;
}
