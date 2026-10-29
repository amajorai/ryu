import type { I18nHostSnapshot, I18nHostTranslateInput } from "./runtime.ts";

/** The read-only translator a sandboxed Companion frame receives from its host. */
export interface CompanionI18nApi {
	get(): Promise<I18nHostSnapshot>;
	subscribe(options: { onChange: (snapshot: I18nHostSnapshot) => void }): {
		dispose(): void;
	};
	translate(input: I18nHostTranslateInput): Promise<string>;
}

function isCompanionI18nApi(value: unknown): value is CompanionI18nApi {
	return (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		typeof Reflect.get(value, "get") === "function" &&
		typeof Reflect.get(value, "subscribe") === "function" &&
		typeof Reflect.get(value, "translate") === "function"
	);
}

/**
 * The trusted host's `window.ryu.i18n` when running inside a Companion frame
 * and it exposes all three callable services, else null. The host object
 * itself is returned, so its identity and method receivers are preserved. A
 * malformed `ryu` or `i18n` value means no host.
 */
export function companionI18nApi(): CompanionI18nApi | null {
	if (globalThis.window === undefined) {
		return null;
	}
	const ryu: unknown = Reflect.get(window, "ryu");
	if (typeof ryu !== "object" || ryu === null || Array.isArray(ryu)) {
		return null;
	}
	const api: unknown = Reflect.get(ryu, "i18n");
	return isCompanionI18nApi(api) ? api : null;
}

function isEnglishLocale(locale: string): boolean {
	return /^en(?:-|$)/iu.test(locale);
}

/** Asks the Companion host to translate literals the frame cannot. */
export interface RemoteTranslator {
	dispose(): void;
	/** Changes whenever the host's language changes or a retry is due. */
	key(): string;
	/** The host's language (pack and locale), or null before it is known. */
	language(): string | null;
	/**
	 * The host's translation of `source`, or null when the frame's own output
	 * stands. `localOutput` is what the frame produced locally; text the frame
	 * left untranslated is sent whenever the host shows a non-English locale.
	 * `values` fill an ICU message on the host; `fallback` (the frame's own
	 * English formatting) is what an untranslated answer resolves to.
	 */
	request(
		source: string,
		id: string,
		localOutput: string,
		hasLocalPack: (packId: string) => boolean,
		message?: RemoteMessage
	): Promise<string> | null;
}

/** ICU values a host translation fills, and the frame's English output. */
export interface RemoteMessage {
	fallback: string;
	values: NonNullable<I18nHostTranslateInput["values"]>;
}

/** Most host answers a frame keeps; the oldest are dropped first. */
export const REMOTE_CACHE_LIMIT = 500;

/** Host publishes after which an unchanged answer is no longer retried. */
const MAX_RETRIES = 1;

/**
 * Track the host's language and cache its answers per key, keeping at most
 * {@link REMOTE_CACHE_LIMIT} of them. A literal the host could not translate
 * yet (its catalog may still be loading) is retried once after the host next
 * publishes, so the frame catches up without polling; after that the source
 * stands until the language changes, so changing data (counters, logs) never
 * produces repeated round trips. Companion data that must never be
 * translated belongs under `data-ryu-i18n="off"`.
 */
export function createRemoteTranslator(
	host: CompanionI18nApi,
	onChange: () => void
): RemoteTranslator {
	let disposed = false;
	let version = 0;
	let snapshotKey: string | null = null;
	let packId: string | null = null;
	let locale: string | null = null;
	// Map iteration order is insertion order, which makes it a cheap LRU.
	const cache = new Map<string, Promise<string>>();
	const unchanged = new Set<string>();
	const retries = new Map<string, number>();

	const remember = (key: string, request: Promise<string>) => {
		cache.delete(key);
		cache.set(key, request);
		while (cache.size > REMOTE_CACHE_LIMIT) {
			const oldest = cache.keys().next().value;
			if (oldest === undefined) {
				break;
			}
			cache.delete(oldest);
			unchanged.delete(oldest);
			retries.delete(oldest);
		}
	};

	const applySnapshot = (snapshot: I18nHostSnapshot) => {
		if (disposed) {
			return;
		}
		const key = `${snapshot.packId ?? ""}\u0000${snapshot.packVersion ?? ""}\u0000${snapshot.locale}`;
		if (key === snapshotKey) {
			// Same language, but the host published (for example once its
			// catalog arrived): retry, once, only what it could not translate.
			let retried = false;
			for (const entry of unchanged) {
				const attempts = retries.get(entry) ?? 0;
				if (attempts < MAX_RETRIES) {
					retries.delete(entry);
					retries.set(entry, attempts + 1);
					cache.delete(entry);
					retried = true;
				}
			}
			unchanged.clear();
			// A retried key that is never requested again leaves its count.
			for (const stale of retries.keys()) {
				if (retries.size <= REMOTE_CACHE_LIMIT) {
					break;
				}
				retries.delete(stale);
			}
			if (!retried) {
				return;
			}
		} else {
			snapshotKey = key;
			cache.clear();
			unchanged.clear();
			retries.clear();
			packId = snapshot.packId;
			locale = snapshot.locale;
		}
		version += 1;
		onChange();
	};

	const requestedVersion = version;
	void host
		.get()
		.then((snapshot) => {
			if (version === requestedVersion) {
				applySnapshot(snapshot);
			}
		})
		.catch(() => undefined);
	let disposeSubscription: () => void = () => undefined;
	try {
		const subscription = host.subscribe({ onChange: applySnapshot });
		disposeSubscription = () => subscription.dispose();
	} catch {
		// A frame can be torn down while the host port is closing.
	}

	return {
		dispose() {
			disposed = true;
			disposeSubscription();
		},
		key: () => `${version}\u0000${packId ?? ""}\u0000${locale ?? ""}`,
		language: () => (locale === null ? null : `${packId ?? ""}\u0000${locale}`),
		request(source, id, localOutput, hasLocalPack, message) {
			if (locale === null) {
				return null;
			}
			const hostAuthority = packId !== null && !hasLocalPack(packId);
			const untranslated = localOutput === source && !isEnglishLocale(locale);
			if (!(hostAuthority || untranslated)) {
				return null;
			}
			const values = message?.values;
			const fallback = message?.fallback ?? source;
			const valuesKey = values ? JSON.stringify(values) : "";
			const key = `${packId ?? ""}\u0000${locale}\u0000${id}\u0000${source}\u0000${valuesKey}`;
			const cached = cache.get(key);
			if (cached) {
				remember(key, cached);
				return cached;
			}
			const request = host
				.translate(
					values
						? { defaultMessage: source, id, values }
						: { defaultMessage: source, id }
				)
				.then((value) =>
					value.trim().length > 0 && value !== source ? value : fallback
				)
				.catch(() => fallback)
				.then((output) => {
					if (output === fallback && cache.get(key) === request) {
						unchanged.add(key);
					}
					return output;
				});
			remember(key, request);
			return request;
		},
	};
}
