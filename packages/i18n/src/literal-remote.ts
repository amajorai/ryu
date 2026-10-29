import {
	type CompanionI18nApi,
	companionI18nApi,
	createRemoteTranslator,
	REMOTE_CACHE_LIMIT,
	type RemoteMessage,
	type RemoteTranslator,
} from "./dom-localizer-host.ts";
import type { MessageValuesInput } from "./format.ts";

type HostValues = RemoteMessage["values"];

/** A whole-sentence literal `tl()` could not translate in the frame. */
export interface LiteralRemoteInput {
	/** The frame's English formatting of `source` with `values`. */
	english: string;
	hasLocalPack: (packId: string) => boolean;
	id: string;
	/** What the frame's runtime returned for `id` (the source when unknown). */
	localOutput: string;
	source: string;
	values: MessageValuesInput;
}

/**
 * Host translations for `useLiteralMessages()` inside a Companion frame,
 * which has no official catalog of its own. Answers arrive asynchronously, so
 * callers read them synchronously and subscribe to re-render on arrival.
 */
export interface LiteralRemote {
	/** The host's answer, or null while pending or when English stands. */
	resolve(input: LiteralRemoteInput): string | null;
	subscribe(listener: () => void): () => void;
	version(): number;
}

/** Attempt keys remembered so each literal is requested once per language. */
const ATTEMPT_LIMIT = REMOTE_CACHE_LIMIT * 4;

/** Host values cross the bridge as JSON scalars; anything else stays local. */
function hostValues(values: MessageValuesInput): HostValues | null {
	if (typeof values !== "object" || values === null || Array.isArray(values)) {
		return null;
	}
	const output: HostValues = {};
	for (const [name, value] of Object.entries(values).sort(([a], [b]) =>
		a.localeCompare(b)
	)) {
		if (value === undefined) {
			continue;
		}
		if (
			value === null ||
			typeof value === "string" ||
			typeof value === "number" ||
			typeof value === "boolean"
		) {
			output[name] = value;
			continue;
		}
		return null;
	}
	return output;
}

function bounded<T>(collection: Map<string, T> | Set<string>, limit: number) {
	while (collection.size > limit) {
		const oldest = collection.keys().next().value;
		if (oldest === undefined) {
			return;
		}
		collection.delete(oldest);
	}
}

export function createLiteralRemote(host: CompanionI18nApi): LiteralRemote & {
	dispose(): void;
} {
	const listeners = new Set<() => void>();
	const answers = new Map<string, string>();
	const attempts = new Set<string>();
	let answersLanguage: string | null = null;
	let version = 0;
	let notifyQueued = false;

	// Coalesce a burst of answers (one per literal on screen) into one render.
	const notify = () => {
		if (notifyQueued) {
			return;
		}
		notifyQueued = true;
		queueMicrotask(() => {
			notifyQueued = false;
			version += 1;
			for (const listener of Array.from(listeners)) {
				listener();
			}
		});
	};

	const remote: RemoteTranslator = createRemoteTranslator(host, notify);

	return {
		dispose() {
			listeners.clear();
			remote.dispose();
		},
		resolve(input) {
			const language = remote.language();
			if (language === null) {
				return null;
			}
			if (language !== answersLanguage) {
				answersLanguage = language;
				answers.clear();
			}
			const values = hostValues(input.values);
			if (values === null) {
				return null;
			}
			const entry = `${input.id}\u0000${input.source}\u0000${JSON.stringify(values)}`;
			const answer = answers.get(entry);
			if (answer !== undefined) {
				return answer;
			}
			const attempt = `${remote.key()}\u0000${entry}`;
			if (attempts.has(attempt)) {
				return null;
			}
			const request = remote.request(
				input.source,
				input.id,
				input.localOutput,
				input.hasLocalPack,
				{ fallback: input.english, values }
			);
			if (request === null) {
				return null;
			}
			attempts.add(attempt);
			bounded(attempts, ATTEMPT_LIMIT);
			void request.then((output) => {
				if (output === input.english || remote.language() !== language) {
					return;
				}
				answers.set(entry, output);
				bounded(answers, REMOTE_CACHE_LIMIT);
				notify();
			});
			return null;
		},
		subscribe(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		version: () => version,
	};
}

let shared: {
	host: CompanionI18nApi;
	remote: ReturnType<typeof createLiteralRemote>;
} | null = null;

/** The frame-wide literal remote, or null outside a Companion frame. */
export function companionLiteralRemote(): LiteralRemote | null {
	const host = companionI18nApi();
	if (!host) {
		return null;
	}
	if (shared?.host !== host) {
		shared?.remote.dispose();
		shared = { host, remote: createLiteralRemote(host) };
	}
	return shared.remote;
}

/** Drop the frame-wide remote (tests, or a host bridge being replaced). */
export function resetCompanionLiteralRemote(): void {
	shared?.remote.dispose();
	shared = null;
}
