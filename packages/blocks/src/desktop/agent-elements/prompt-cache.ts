import { isNativeNumber } from "@ryu/ui/lib/native-primitive-observation.ts";
import { formatCount } from "@ryu/ui/lib/number-format.ts";
import type { ContextUsage } from "./context-usage.tsx";

/**
 * Prompt-cache model shared by the composer's context hover card, the Context
 * panel, and the model-switch warning.
 *
 * Neither catalog Ryu reads publishes a cache lifetime: models.dev carries only
 * `cost.cache_read` / `cost.cache_write`, and OpenRouter only the matching
 * prices. The lifetime is a property of the provider's cache, so it is authored
 * here per provider family from each provider's published caching docs. Where a
 * provider publishes no expiry, the policy says so instead of inventing one.
 *
 * Ryu cannot observe a provider's cache directly; warmth is a countdown from
 * the last turn that read or wrote the cache, using the provider's default TTL
 * (which every cache hit refreshes). It is a best estimate, and labelled as one.
 */

const MINUTE_MS = 60_000;

export type PromptCachePolicy =
	| {
			kind: "timed";
			/** Upper bound the provider allows when a request opts in / under low load. */
			maxTtlMs?: number;
			note: string;
			provider: string;
			/** Default lifetime after the last read or write. */
			ttlMs: number;
	  }
	| {
			kind: "managed";
			note: string;
			provider: string;
	  };

const ANTHROPIC: PromptCachePolicy = {
	kind: "timed",
	provider: "Anthropic",
	ttlMs: 5 * MINUTE_MS,
	maxTtlMs: 60 * MINUTE_MS,
	note: "5 min default, refreshed on every cache hit (1 h when the request opts in).",
};

const OPENAI: PromptCachePolicy = {
	kind: "timed",
	provider: "OpenAI",
	ttlMs: 30 * MINUTE_MS,
	maxTtlMs: 24 * 60 * MINUTE_MS,
	note: "At least 30 min after last use on current models, up to 24 h; zero-data-retention orgs keep 5–10 min.",
};

const GOOGLE: PromptCachePolicy = {
	kind: "managed",
	provider: "Google",
	note: "Implicit caching — Google does not publish an expiry.",
};

const DEEPSEEK: PromptCachePolicy = {
	kind: "managed",
	provider: "DeepSeek",
	note: "Disk cache, usually cleared within a few hours.",
};

const XAI: PromptCachePolicy = {
	kind: "managed",
	provider: "xAI",
	note: "Automatic caching — xAI does not publish an expiry.",
};

/**
 * Ordered: the first family whose pattern matches the model id (or, failing
 * that, the provider / agent hint) wins. Open-weight `gpt-oss` is excluded from
 * the OpenAI row because it is usually served by another host or locally.
 * Word boundaries are non-alphanumerics, as in Core's `match_family`
 * (`apps/core/src/sidecar/adapters/prompt_cache_warmth.rs`); the `Core parity`
 * tests in `prompt-cache.test.ts` run Core's classification asserts against this.
 */
const FAMILIES: ReadonlyArray<{ pattern: RegExp; policy: PromptCachePolicy }> =
	[
		{
			pattern:
				/claude|anthropic|(^|[^a-z0-9])(opus|sonnet|haiku)([^a-z0-9]|$)/i,
			policy: ANTHROPIC,
		},
		{ pattern: /gemini|(^|[^a-z0-9])google([^a-z0-9]|$)/i, policy: GOOGLE },
		{ pattern: /deepseek/i, policy: DEEPSEEK },
		{ pattern: /grok|(^|[^a-z0-9])xai([^a-z0-9]|$)/i, policy: XAI },
		{
			pattern:
				/^(?!.*gpt-oss)(.*(^|[^a-z0-9])(gpt|openai|codex|chatgpt)|(.*[/:])?o\d[^/:]*$)/i,
			policy: OPENAI,
		},
	];

function matchPolicy(value: string | null | undefined) {
	if (!value) {
		return;
	}
	return FAMILIES.find((family) => family.pattern.test(value))?.policy;
}

/**
 * The cache policy for a model. `provider` is a fallback hint — a provider id
 * (`anthropic`) or an agent id (`claude-code`, `codex`) — used when the model id
 * alone is ambiguous (ACP agents often report `default`).
 */
export function promptCachePolicy(
	model?: string | null,
	provider?: string | null
): PromptCachePolicy | undefined {
	return matchPolicy(model) ?? matchPolicy(provider);
}

export type PromptCacheState =
	/** A turn is streaming: the cache is being read/written right now. */
	| "active"
	/** Within the provider's default TTL of the last cache read/write. */
	| "warm"
	/** Past the default TTL — the next turn most likely re-writes the cache. */
	| "expired"
	/** The provider reported cache tokens but publishes no expiry. */
	| "unknown"
	/** The last turn reported zero cache reads and writes. */
	| "unused";

export interface PromptCacheStatus {
	/** Share of the last turn's input served from cache (0–1). */
	hitRate?: number;
	policy?: PromptCachePolicy;
	/** Milliseconds of default TTL left; only for `warm`. */
	remainingMs?: number;
	state: PromptCacheState;
}

function finiteCount(value: unknown): number | undefined {
	return isNativeNumber(value) && Number.isFinite(value) && value >= 0
		? value
		: undefined;
}

/**
 * Cache hit rate for the last turn: cache reads over total input. When the
 * provider omitted the total, reads + writes + misses stand in for it.
 */
export function promptCacheHitRate(usage: ContextUsage): number | undefined {
	const read = finiteCount(usage.cacheReadTokens ?? usage.cachedTokens);
	if (read === undefined) {
		return;
	}
	const prompt = finiteCount(usage.promptTokens);
	const denominator =
		prompt !== undefined && prompt > 0
			? prompt
			: read +
				(finiteCount(usage.cacheWriteTokens) ?? 0) +
				(finiteCount(usage.cacheMissTokens) ?? 0);
	if (denominator <= 0) {
		return;
	}
	return Math.min(1, read / denominator);
}

/**
 * Derive the cache state for the last reported turn. Returns null when the
 * provider reported no cache counters at all — there is nothing honest to say.
 */
export function promptCacheStatus(
	usage: ContextUsage,
	now: number
): PromptCacheStatus | null {
	const read = finiteCount(usage.cacheReadTokens ?? usage.cachedTokens);
	const write = finiteCount(usage.cacheWriteTokens);
	if (read === undefined && write === undefined) {
		return null;
	}
	const policy = promptCachePolicy(usage.model, usage.provider);
	const hitRate = promptCacheHitRate(usage);
	if (usage.inFlight) {
		return { state: "active", hitRate, policy };
	}
	if ((read ?? 0) + (write ?? 0) <= 0) {
		return { state: "unused", hitRate, policy };
	}
	const observedAt = finiteCount(usage.observedAt);
	if (policy?.kind !== "timed" || observedAt === undefined) {
		return { state: "unknown", hitRate, policy };
	}
	const remainingMs = observedAt + policy.ttlMs - now;
	return remainingMs > 0
		? { state: "warm", hitRate, policy, remainingMs }
		: { state: "expired", hitRate, policy };
}

/** `m:ss` countdown for the warmth row. */
export function formatCacheCountdown(milliseconds: number): string {
	const seconds = Math.max(0, Math.ceil(milliseconds / 1000));
	const minutes = Math.floor(seconds / 60);
	return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

/** `5 min` / `1 h` for a policy's TTL. */
export function formatCacheTtl(milliseconds: number): string {
	const minutes = Math.round(milliseconds / MINUTE_MS);
	return minutes % 60 === 0 ? `${minutes / 60} h` : `${minutes} min`;
}

/**
 * Whether switching models now discards a cache worth warning about. The
 * prompt cache is keyed by model, so any switch re-sends the whole context
 * uncached; it is only worth a warning while that cache could still be hit.
 */
export function modelSwitchLosesCache(
	usage: ContextUsage | null | undefined,
	now: number
): boolean {
	if (!usage) {
		return false;
	}
	const status = promptCacheStatus(usage, now);
	if (!status) {
		// No cache counters, but a long conversation still pays full input price
		// on the switch when the provider caches silently — warn when it has history.
		return (finiteCount(usage.used) ?? 0) > 0;
	}
	return (
		status.state === "active" ||
		status.state === "warm" ||
		status.state === "unknown"
	);
}

/**
 * The toast shown when the user picks a different model mid-conversation, or
 * null when the switch discards no cache worth mentioning.
 */
export function modelSwitchCacheWarning(
	usage: ContextUsage | null | undefined,
	nextModel: string,
	now: number
): { description: string; title: string } | null {
	if (!(usage && modelSwitchLosesCache(usage, now))) {
		return null;
	}
	const resent =
		finiteCount(usage.promptTokens) ?? finiteCount(usage.used) ?? 0;
	const tokens = formatCount(resent);
	const status = promptCacheStatus(usage, now);
	const warmth =
		status?.state === "warm" && status.remainingMs !== undefined
			? ` The current cache is still warm for ${formatCacheCountdown(status.remainingMs)}.`
			: "";
	return {
		title: `Switching to ${nextModel} resets the prompt cache`,
		description: `Prompt caches are per model, so the next message re-sends ${
			tokens ? `${tokens} tokens of` : "the"
		} context at the full input price.${warmth}`,
	};
}

/**
 * Where an edited setting reaches the system prompt. Every thread in that reach
 * re-sends its prompt uncached on its next turn.
 */
export type PromptEditReach =
	| "all-threads"
	| "bot"
	| "bot-in-project"
	| "project"
	| "ryu-agent"
	| "skill-threads";

const REACH_LABEL: Record<PromptEditReach, string> = {
	"all-threads": "every thread on this node",
	bot: "this bot's threads, in every project",
	"bot-in-project": "this bot's threads in this project",
	project: "every thread in this project",
	"ryu-agent": "every Ryu assistant thread",
	"skill-threads": "every thread that loads skills",
};

/** Field labels that read as plural nouns ("The instructions are …"). */
const PLURAL_LABEL = /(instructions|skills|replies|goals)$/i;

/**
 * The confirmation shown before saving a setting that Core injects into the
 * system prompt: goals, instructions, persona tone, output style, brief
 * replies, skills. Providers cache the prompt as one prefix, so changing any
 * of it is a guaranteed miss for each affected thread's next turn. The miss is
 * paid once per thread; later turns are cached again.
 *
 * Returns null when nothing that reaches the prompt changed, so callers can
 * save without asking.
 */
export function promptEditCacheWarning(
	changed: readonly string[],
	reach: PromptEditReach
): { description: string; title: string } | null {
	const fields = changed.filter((field) => field.trim().length > 0);
	if (fields.length === 0) {
		return null;
	}
	const list =
		fields.length === 1
			? fields[0]
			: `${fields.slice(0, -1).join(", ")} and ${fields.at(-1)}`;
	return {
		title: "Apply now? This resets the prompt cache",
		description: `${list} ${fields.length === 1 && !PLURAL_LABEL.test(list ?? "") ? "is" : "are"} part of the system prompt for ${REACH_LABEL[reach]}. Each thread's next message re-sends its whole conversation at the full input price, once; replies after that are cached again. Switching models costs the same.`,
	};
}

/**
 * The confirmation shown before changing a stored model default (a project, a
 * bot, or a bot inside a project). Unlike the composer's per-chat switch, this
 * moves every thread that inherits the scope, and prompt caches are per model,
 * so each of those threads re-sends its context uncached on its next message.
 * Effort-only changes return null: they do not change the cache key.
 */
export function modelDefaultCacheWarning(
	scopeLabel: string,
	before: { model: string; provider: string },
	after: { model: string; provider: string }
): { description: string; title: string } | null {
	const same = (left: string, right: string) => left.trim() === right.trim();
	if (
		same(before.model, after.model) &&
		same(before.provider, after.provider)
	) {
		return null;
	}
	return {
		title: "Apply now? This resets the prompt cache",
		description: `Every thread that inherits ${scopeLabel} switches model on its next message. Prompt caches are per model, so each of those threads re-sends its whole conversation at the full input price, once.`,
	};
}
