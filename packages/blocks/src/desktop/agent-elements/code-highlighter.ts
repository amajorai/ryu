import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";
// Shiki highlighter plugin for Streamdown code blocks. Replaces `@streamdown/code`,
// whose defaults cost the chat most of its streaming frame budget:
//
// - It used Shiki's JavaScript regex engine. On JavaScriptCore (the macOS and
//   Linux webviews) that engine took ~6.7s for a 400-line TypeScript block where
//   Oniguruma takes ~0.6s; on V8 both take ~0.55s. Oniguruma is used first, with
//   the JavaScript engine kept as a fallback if the WASM module cannot load.
// - It re-tokenized the whole block for every streamed chunk, so a growing block
//   cost O(n²) and took ~44% of main-thread time while streaming code. While a
//   reply streams, this plugin keeps a checkpoint (the tokens and grammar state at
//   the last finished line) and tokenizes only the lines after it, synchronously:
//   ~0.4ms per new line instead of ~115ms for a 300-line block. The result is the
//   same as a full pass, because the tokenizer resumes from the exact state.
// - Finished content, and streams whose tokenizer is still loading, go through a
//   queue that runs one pass per macrotask so frames paint between them. Results
//   live in a bounded LRU instead of a cache that kept every pass forever.
import type {
	GrammarState,
	GrammarStateMapKey,
	Highlighter,
	TokensResult,
} from "shiki";
import type {
	CodeHighlighterPlugin,
	HighlightOptions,
	ThemeInput,
} from "streamdown";

type HighlightResult = TokensResult;
type TokenLines = HighlightResult["tokens"];
type ResultBase = Omit<HighlightResult, "tokens">;

type HighlightCallback = (result: HighlightResult) => void;

type TokenizeOptions = Parameters<Highlighter["codeToTokens"]>[1];

interface Tokenizer
	extends Pick<Highlighter, "codeToTokens" | "getLoadedLanguages"> {
	/** The actual SDK token/HAST overload; this adapter forwards its single raw argument. */
	getLastGrammarState: (tokens: GrammarStateMapKey) => GrammarState | undefined;
	/** Slow cold JavaScript compilation stays off the synchronous stream path. */
	queuedOnly?: boolean;
}

interface HighlightJob {
	callbacks: Set<HighlightCallback>;
	code: string;
	key: string;
	language: string;
	streaming: boolean;
	themeNames: [string, string];
	themes: [ThemeInput, ThemeInput];
}

/** Tokens and grammar state for a block's code up to its last finished line. */
interface Checkpoint {
	base: ResultBase;
	/** The code covered, ending with a newline. */
	prefix: string;
	state: GrammarState | undefined;
	tokens: TokenLines;
}

const DEFAULT_THEMES: [ThemeInput, ThemeInput] = [
	"github-light",
	"github-dark",
];
const RESULT_CACHE_LIMIT = 200;
const CHECKPOINTS_PER_STREAM = 4;
// A streaming block with no checkpoint yet is tokenized synchronously only when
// short; a long one (a big block arriving in one chunk) goes through the queue.
const SYNC_FULL_PASS_LIMIT = 8000;
// Finite per-line ceiling: cold embedded grammars exceed Shiki's 500ms default.
// This is not a frame-time guarantee; a fallback line may block up to this budget.
const JAVASCRIPT_TOKENIZE_TIME_LIMIT_MS = 5000;

let shikiModule: Promise<typeof import("shiki")> | null = null;
let languageIndex: Promise<{
	aliases: Map<string, string>;
	ids: Set<string>;
}> | null = null;

function loadShiki(): Promise<typeof import("shiki")> {
	shikiModule ??= import("shiki");
	return shikiModule;
}

function loadLanguageIndex() {
	languageIndex ??= loadShiki().then(
		({ bundledLanguages, bundledLanguagesInfo }) => {
			const aliases = new Map<string, string>();
			for (const info of bundledLanguagesInfo) {
				for (const alias of info.aliases ?? []) {
					aliases.set(alias, info.id);
				}
			}
			return { aliases, ids: new Set(Object.keys(bundledLanguages)) };
		}
	);
	return languageIndex;
}

const customThemes = new WeakMap<object, ThemeInput>();
let customThemeId = 0;

function normalizeTheme(theme: ThemeInput): ThemeInput {
	if (isNativeText(theme)) {
		return theme;
	}
	let normalized = customThemes.get(theme);
	if (!normalized) {
		normalized = { ...theme, name: `ryu-custom-${customThemeId++}` };
		customThemes.set(theme, normalized);
	}
	return normalized;
}

function themeName(theme: ThemeInput): string {
	return isNativeText(theme) ? theme : (theme.name ?? "custom");
}

function normalizeLanguage(language: string): string {
	return language.trim().toLowerCase();
}

// Resolved on first use; until then every language is treated as supported and
// unknown ones fall back to plain text when highlighted.
let resolvedLanguages: {
	aliases: Map<string, string>;
	ids: Set<string>;
} | null = null;
loadLanguageIndex()
	.then((index) => {
		resolvedLanguages = index;
	})
	.catch(() => undefined);

function resolveLanguage(language: string): string {
	const normalized = normalizeLanguage(language);
	return resolvedLanguages?.aliases.get(normalized) ?? normalized;
}

async function createTokenizer(
	language: string,
	themes: [ThemeInput, ThemeInput]
): Promise<Tokenizer> {
	const { createHighlighter } = await loadShiki();
	const { ids } = await loadLanguageIndex();
	const langs = ids.has(language) ? [language] : [];
	try {
		const { createOnigurumaEngine } = await import("shiki/engine/oniguruma");
		return await createHighlighter({
			engine: createOnigurumaEngine(import("shiki/wasm")),
			langs,
			themes,
		});
	} catch {
		// A host whose CSP forbids WASM still gets highlighting, just slower.
		const { createJavaScriptRegexEngine } = await import(
			"shiki/engine/javascript"
		);
		const fallback = await createHighlighter({
			engine: createJavaScriptRegexEngine({ forgiving: true }),
			langs,
			themes,
		});
		return {
			queuedOnly: true,
			codeToTokens: (code, options) =>
				fallback.codeToTokens(code, {
					...options,
					tokenizeTimeLimit: JAVASCRIPT_TOKENIZE_TIME_LIMIT_MS,
				}),
			getLastGrammarState: (tokens) => fallback.getLastGrammarState(tokens),
			getLoadedLanguages: () => fallback.getLoadedLanguages(),
		};
	}
}

function streamKey(language: string, themeNames: [string, string]) {
	return `${language}:${themeNames[0]}:${themeNames[1]}`;
}

const tokenizers = new Map<string, Promise<Tokenizer>>();
// The same tokenizers once loaded, so the streaming path can use them
// synchronously.
const readyTokenizers = new Map<string, Tokenizer>();

function getTokenizer(
	language: string,
	themes: [ThemeInput, ThemeInput],
	themeNames: [string, string]
): Promise<Tokenizer> {
	const key = streamKey(language, themeNames);
	let tokenizer = tokenizers.get(key);
	if (!tokenizer) {
		tokenizer = createTokenizer(language, themes);
		tokenizer
			.then((ready) => readyTokenizers.set(key, ready))
			.catch(() => tokenizers.delete(key));
		tokenizers.set(key, tokenizer);
	}
	return tokenizer;
}

const resultCache = new Map<string, HighlightResult>();

function readCache(key: string): HighlightResult | undefined {
	const hit = resultCache.get(key);
	if (hit) {
		// Map iteration order is insertion order: re-inserting marks it recent.
		resultCache.delete(key);
		resultCache.set(key, hit);
	}
	return hit;
}

function writeCache(key: string, result: HighlightResult) {
	resultCache.set(key, result);
	if (resultCache.size > RESULT_CACHE_LIMIT) {
		const oldest = resultCache.keys().next().value;
		if (oldest !== undefined) {
			resultCache.delete(oldest);
		}
	}
}

const checkpoints = new Map<string, Checkpoint[]>();

function findCheckpoint(stream: string, code: string): Checkpoint | undefined {
	let best: Checkpoint | undefined;
	for (const checkpoint of checkpoints.get(stream) ?? []) {
		if (
			code.startsWith(checkpoint.prefix) &&
			checkpoint.prefix.length > (best?.prefix.length ?? -1)
		) {
			best = checkpoint;
		}
	}
	return best;
}

function saveCheckpoint(
	stream: string,
	previous: Checkpoint | undefined,
	next: Checkpoint
) {
	const list = (checkpoints.get(stream) ?? []).filter(
		(checkpoint) => checkpoint !== previous
	);
	list.push(next);
	checkpoints.set(stream, list.slice(-CHECKPOINTS_PER_STREAM));
}

function resultBase({ tokens: _tokens, ...base }: HighlightResult): ResultBase {
	return base;
}

function grammarStateOf(
	tokenizer: Tokenizer,
	tokens: TokenLines
): GrammarState | undefined {
	try {
		return tokenizer.getLastGrammarState(tokens);
	} catch {
		// Plain text has no grammar state; such a block is simply re-tokenized.
		return undefined;
	}
}

/**
 * Tokens for `code`, resuming from `checkpoint` when it covers a prefix. Only
 * the lines after the checkpoint are tokenized; the returned checkpoint covers
 * every finished line of `code` for the next call.
 */
function tokenizeFromCheckpoint(
	tokenizer: Tokenizer,
	code: string,
	options: TokenizeOptions,
	checkpoint: Checkpoint | undefined
) {
	const resumable =
		checkpoint && code.startsWith(checkpoint.prefix) ? checkpoint : undefined;
	let prefix = resumable?.prefix ?? "";
	let tokens = resumable?.tokens ?? [];
	let state = resumable?.state;
	let base = resumable?.base;

	const delta = code.slice(prefix.length);
	const lastNewline = delta.lastIndexOf("\n");
	if (lastNewline >= 0) {
		const finished = tokenizer.codeToTokens(delta.slice(0, lastNewline), {
			...options,
			grammarState: state,
		});
		tokens = tokens.concat(finished.tokens);
		state = grammarStateOf(tokenizer, finished.tokens);
		base ??= resultBase(finished);
		prefix += delta.slice(0, lastNewline + 1);
	}
	const partial = tokenizer.codeToTokens(delta.slice(lastNewline + 1), {
		...options,
		grammarState: state,
	});
	base ??= resultBase(partial);
	const result = { ...base, tokens: tokens.concat(partial.tokens) };
	const next =
		prefix && state !== undefined ? { base, prefix, state, tokens } : undefined;
	return { checkpoint: next, result };
}

const queue: HighlightJob[] = [];
const queuedByKey = new Map<string, HighlightJob>();
let drainScheduled = false;

function scheduleDrain() {
	if (drainScheduled || queue.length === 0) {
		return;
	}
	drainScheduled = true;
	setTimeout(() => {
		drainScheduled = false;
		runNextJob()
			.catch(() => undefined)
			.finally(scheduleDrain);
	}, 0);
}

function tokenizeOptions(
	tokenizer: Tokenizer,
	language: string,
	themeNames: [string, string]
): TokenizeOptions {
	return {
		// SAFETY: This private tokenizer is created only from Shiki bundled language IDs;
		// its loaded language names are therefore the native bundled language/alias domain.
		// The existing loaded-language test forwards that complete native name unchanged.
		lang: tokenizer.getLoadedLanguages().includes(language)
			? (language as TokenizeOptions["lang"])
			: "text",
		themes: { dark: themeNames[1], light: themeNames[0] },
	};
}

function highlightStreaming(
	tokenizer: Tokenizer,
	key: string,
	code: string,
	language: string,
	themeNames: [string, string]
): HighlightResult {
	const stream = streamKey(language, themeNames);
	const previous = findCheckpoint(stream, code);
	const { checkpoint, result } = tokenizeFromCheckpoint(
		tokenizer,
		code,
		tokenizeOptions(tokenizer, language, themeNames),
		previous
	);
	if (checkpoint) {
		saveCheckpoint(stream, previous, checkpoint);
	}
	writeCache(key, result);
	return result;
}

interface StreamDelivery {
	at: number;
	code: string;
	pending?: { callbacks: Set<HighlightCallback>; code: string; key: string };
	result: HighlightResult;
	timer?: ReturnType<typeof setTimeout>;
}

// Streamdown redraws every line of a code block whenever it receives a new
// result object: its code body is memoized on result identity alone. A growing
// request can temporarily reuse the displayed result while a trailing timer
// delivers its exact source. Equal pending requests share the tokenization and
// retain every subscriber. Distinct pending sources settle immediately before
// another request takes the slot: Streamdown supplies no block identity, so a
// shared throttle must not discard an independent block's callback.
const STREAM_REDRAW_INTERVAL_MS = 100;
const deliveries = new Map<string, StreamDelivery>();

function flushDelivery(
	tokenizer: Tokenizer,
	stream: string,
	language: string,
	themeNames: [string, string]
) {
	const delivery = deliveries.get(stream);
	if (!delivery?.pending) {
		return;
	}
	clearTimeout(delivery.timer);
	const { callbacks, code, key } = delivery.pending;
	const result = highlightStreaming(tokenizer, key, code, language, themeNames);
	deliveries.set(stream, { at: performance.now(), code, result });
	for (const callback of callbacks) {
		callback(result);
	}
}

function deliverStreaming(
	tokenizer: Tokenizer,
	key: string,
	code: string,
	language: string,
	themeNames: [string, string],
	callback: HighlightCallback | undefined
): HighlightResult {
	const stream = streamKey(language, themeNames);
	const now = performance.now();
	const last = deliveries.get(stream);
	if (
		last &&
		code.startsWith(last.code) &&
		now - last.at < STREAM_REDRAW_INTERVAL_MS
	) {
		// A different source may belong to another mounted block. Complete its
		// exact callbacks before replacing the shared delivery slot.
		if (last.pending && last.pending.code !== code) {
			flushDelivery(tokenizer, stream, language, themeNames);
			return deliverStreaming(
				tokenizer,
				key,
				code,
				language,
				themeNames,
				callback
			);
		}
		if (last.pending) {
			if (callback) {
				last.pending.callbacks.add(callback);
			}
		} else {
			last.pending = {
				callbacks: new Set(callback ? [callback] : []),
				code,
				key,
			};
		}
		last.timer ??= setTimeout(
			() => flushDelivery(tokenizer, stream, language, themeNames),
			STREAM_REDRAW_INTERVAL_MS - (now - last.at)
		);
		return last.result;
	}
	// A different block of the same language: settle the previous block's
	// held-back update before this one takes over the slot.
	if (last?.pending && !code.startsWith(last.code)) {
		flushDelivery(tokenizer, stream, language, themeNames);
	} else {
		clearTimeout(last?.timer);
	}
	const result = highlightStreaming(tokenizer, key, code, language, themeNames);
	deliveries.set(stream, { at: now, code, result });
	return result;
}

async function runNextJob() {
	const job = queue.shift();
	if (!job) {
		return;
	}
	queuedByKey.delete(job.key);
	const tokenizer = await getTokenizer(
		job.language,
		job.themes,
		job.themeNames
	);
	let result: HighlightResult;
	if (job.streaming) {
		result = highlightStreaming(
			tokenizer,
			job.key,
			job.code,
			job.language,
			job.themeNames
		);
	} else {
		result = tokenizer.codeToTokens(
			job.code,
			tokenizeOptions(tokenizer, job.language, job.themeNames)
		);
		writeCache(job.key, result);
	}
	for (const callback of job.callbacks) {
		callback(result);
	}
}

function createHighlighterPlugin(streaming: boolean): CodeHighlighterPlugin {
	return {
		name: "shiki",
		type: "code-highlighter",
		// SAFETY: These IDs are only the own keys of Shiki's actual bundledLanguages
		// registry; its public Record keys are BundledLanguage. Object.keys erases that
		// finite key type, while the plugin forwards the complete native key array unchanged.
		getSupportedLanguages: () =>
			Array.from(resolvedLanguages?.ids ?? []) as ReturnType<
				CodeHighlighterPlugin["getSupportedLanguages"]
			>,
		getThemes: () => DEFAULT_THEMES,
		supportsLanguage: (language) =>
			resolvedLanguages
				? resolvedLanguages.ids.has(resolveLanguage(language))
				: true,
		highlight(options: HighlightOptions, callback?: HighlightCallback) {
			const language = resolveLanguage(options.language);
			const themes: [ThemeInput, ThemeInput] = [
				normalizeTheme(options.themes[0]),
				normalizeTheme(options.themes[1]),
			];
			const themeNames: [string, string] = [
				themeName(themes[0]),
				themeName(themes[1]),
			];
			const key = `${language}:${themeNames[0]}:${themeNames[1]}:${options.code}`;
			const cached = readCache(key);
			if (cached) {
				return cached;
			}
			if (streaming) {
				const tokenizer = readyTokenizers.get(streamKey(language, themeNames));
				if (
					tokenizer &&
					!tokenizer.queuedOnly &&
					(findCheckpoint(streamKey(language, themeNames), options.code) ||
						options.code.length <= SYNC_FULL_PASS_LIMIT)
				) {
					return deliverStreaming(
						tokenizer,
						key,
						options.code,
						language,
						themeNames,
						callback
					);
				}
			}
			const queued = queuedByKey.get(key);
			if (queued) {
				if (callback) {
					queued.callbacks.add(callback);
				}
				return null;
			}
			const job: HighlightJob = {
				callbacks: new Set(callback ? [callback] : []),
				code: options.code,
				key,
				language,
				streaming,
				themeNames,
				themes,
			};
			// Streamdown provides no caller identity: even prefix-related requests
			// can belong to independent blocks, so every callback must settle.
			queue.push(job);
			queuedByKey.set(key, job);
			scheduleDrain();
			return null;
		},
	};
}

/** Exact highlighting for finished content: every requested pass runs. */
export const staticCodeHighlighter = createHighlighterPlugin(false);

/**
 * Highlighting for a reply that is still streaming: growing blocks resume from
 * their last finished line; every queued request retains its callbacks.
 */
export const streamingCodeHighlighter = createHighlighterPlugin(true);
