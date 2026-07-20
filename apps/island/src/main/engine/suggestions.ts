// The context monitor + local-model proactive suggestion engine (Island U3).
//
// Lifecycle: `start()` begins two loops and `stop()` tears them down cleanly
// (no orphan timers) — the consent gate for U6 lives upstream of `start()`.
//
//   1. Context loop (~4s): poll Shadow `GET /context/current`, detect a
//      significant change (app/title/large-OCR-delta), debounce ~8s so the
//      screen settles, respect a per-app cooldown (~2.5 min), then ask the local
//      model (Core `POST /v1/chat/completions`, default Gemma 4 E2B) for a
//      strict-JSON suggestion. Malformed output is logged + skipped, never fatal.
//
//   2. Proactive loop (~30s): poll Shadow `GET /proactive` and surface any
//      `push_now` suggestion through the same dedupe + emit path.
//
// Both paths dedupe on hash(title + app) and emit `suggestion:new`. Feedback
// (accept/dismiss/snooze) routes to Shadow `POST /api/feedback` and feeds the
// cooldown. The engine is Electron-free: it takes an emitter callback, so the
// IPC layer wires it to `webContents.send` and the pure logic stays testable.

import { randomUUID } from "node:crypto";
import type {
	FeedbackKind,
	IslandSuggestion,
	ShadowContextResult,
	ShadowProactiveResult,
	SuggestionEngineStatus,
} from "../../shared/ipc.ts";
import {
	type ContextSnapshot,
	detectChange,
	toSnapshot,
} from "./change-detection.ts";
import { AppCooldown, appKeyOf } from "./cooldown.ts";
import { SuggestionDedupe, suggestionKey } from "./dedupe.ts";
import { parseModelSuggestion } from "./parse.ts";
import { buildSuggestionMessages } from "./prompt.ts";

/** Tunables for the engine. All in milliseconds unless noted. */
export interface SuggestionEngineOptions {
	/** Min model confidence to surface a suggestion. */
	confidenceThreshold: number;
	/** Context poll interval. */
	contextIntervalMs: number;
	/** Base per-app cooldown after emitting. */
	cooldownMs: number;
	/** How long the context must stay changed before we call the model. */
	debounceMs: number;
	/** Max remembered suggestion keys. */
	dedupeMaxEntries: number;
	/** Dedupe TTL window. */
	dedupeTtlMs: number;
	/** OCR Jaccard similarity at/above which the screen is "unchanged". */
	ocrSimilarityThreshold: number;
	/** Proactive (Shadow) poll interval. */
	proactiveIntervalMs: number;
	/** Longer cooldown applied on snooze feedback. */
	snoozeCooldownMs: number;
}

export const DEFAULT_OPTIONS: SuggestionEngineOptions = {
	contextIntervalMs: 4000,
	proactiveIntervalMs: 30_000,
	debounceMs: 8000,
	cooldownMs: 150_000,
	snoozeCooldownMs: 600_000,
	ocrSimilarityThreshold: 0.6,
	confidenceThreshold: 0.5,
	dedupeTtlMs: 300_000,
	dedupeMaxEntries: 50,
};

/** Outbound dependencies, injected so the engine stays testable. */
export interface SuggestionEngineDeps {
	/** Non-streaming local-model completion (Core client). Returns text or null. */
	complete(
		messages: ReturnType<typeof buildSuggestionMessages>
	): Promise<string | null>;
	/** Emit a new suggestion to the renderer. */
	emit(suggestion: IslandSuggestion): void;
	/** Notify the renderer that suggestions were cleared (engine stopped). */
	emitCleared(): void;
	/**
	 * Optional: the latest web page bridged by the browser extension. Folded into
	 * the snapshot so the model sees the full page text (including content
	 * scrolled off-screen that OCR can't capture). Returns null when no recent
	 * page is available; failures resolve to null and are non-fatal.
	 */
	getBrowserContext?(): Promise<{ content: string; url: string } | null>;
	/** Fetch the current screen context (Shadow client). */
	getContext(): Promise<ShadowContextResult>;
	/** Fetch the top push_now proactive suggestion (Shadow client). */
	getProactive(): Promise<ShadowProactiveResult>;
	/** Optional logger; defaults to a no-op so production stays quiet. */
	log?(message: string): void;
	/** Post feedback to Shadow. */
	postFeedback(kind: FeedbackKind, suggestionType: string): Promise<void>;
}

/** Tracks an in-flight debounce window for a candidate change. */
interface PendingChange {
	since: number;
	snapshot: ContextSnapshot;
}

export class SuggestionEngine {
	private readonly opts: SuggestionEngineOptions;
	private readonly deps: SuggestionEngineDeps;
	private readonly dedupe: SuggestionDedupe;
	private readonly cooldown: AppCooldown;
	private readonly emittedById = new Map<string, IslandSuggestion>();

	private running = false;
	private contextTimer: ReturnType<typeof setInterval> | null = null;
	private proactiveTimer: ReturnType<typeof setInterval> | null = null;
	private lastSnapshot: ContextSnapshot | null = null;
	private pending: PendingChange | null = null;
	private lastContextReason: string | null = null;
	private emittedCount = 0;
	private contextTickActive = false;
	private proactiveTickActive = false;

	constructor(
		deps: SuggestionEngineDeps,
		options: Partial<SuggestionEngineOptions> = {}
	) {
		this.deps = deps;
		this.opts = { ...DEFAULT_OPTIONS, ...options };
		this.dedupe = new SuggestionDedupe(
			this.opts.dedupeTtlMs,
			this.opts.dedupeMaxEntries
		);
		this.cooldown = new AppCooldown(
			this.opts.cooldownMs,
			this.opts.snoozeCooldownMs
		);
	}

	/** Start both poll loops. Idempotent. */
	start(): SuggestionEngineStatus {
		if (this.running) {
			return this.status();
		}
		this.running = true;
		// `contextTick`/`proactiveTick` swallow all errors internally, so the
		// promise never rejects; the no-op catch only satisfies the linter.
		this.contextTimer = setInterval(() => {
			this.contextTick().catch(noop);
		}, this.opts.contextIntervalMs);
		this.proactiveTimer = setInterval(() => {
			this.proactiveTick().catch(noop);
		}, this.opts.proactiveIntervalMs);
		this.log("engine started");
		return this.status();
	}

	/** Stop both loops and clear all in-memory state. No orphan timers. */
	stop(): SuggestionEngineStatus {
		if (this.contextTimer) {
			clearInterval(this.contextTimer);
			this.contextTimer = null;
		}
		if (this.proactiveTimer) {
			clearInterval(this.proactiveTimer);
			this.proactiveTimer = null;
		}
		const wasRunning = this.running;
		this.running = false;
		this.pending = null;
		this.lastSnapshot = null;
		this.dedupe.clear();
		this.cooldown.clear();
		this.emittedById.clear();
		if (wasRunning) {
			this.deps.emitCleared();
			this.log("engine stopped");
		}
		return this.status();
	}

	/** Current lifecycle/status snapshot. */
	status(): SuggestionEngineStatus {
		return {
			running: this.running,
			lastContextReason: this.lastContextReason,
			emitted: this.emittedCount,
		};
	}

	/**
	 * Route renderer feedback to Shadow and feed the cooldown. Positive feedback
	 * is recorded; dismiss/snooze extend the per-app cooldown so the engine backs
	 * off. Unknown ids are ignored gracefully.
	 */
	async feedback(id: string, kind: FeedbackKind): Promise<void> {
		const suggestion = this.emittedById.get(id);
		const suggestionType = suggestion?.suggestionType ?? "context";
		try {
			await this.deps.postFeedback(kind, suggestionType);
		} catch (error) {
			this.log(`feedback post failed: ${describeError(error)}`);
		}
		if (suggestion && (kind === "dismiss" || kind === "snooze")) {
			this.cooldown.penalize(appKeyOf(suggestion.appName), kind, Date.now());
		}
	}

	private async contextTick(): Promise<void> {
		if (this.contextTickActive) {
			return;
		}
		this.contextTickActive = true;
		try {
			await this.runContextTick();
		} catch (error) {
			this.log(`context tick error: ${describeError(error)}`);
		} finally {
			this.contextTickActive = false;
		}
	}

	private async runContextTick(): Promise<void> {
		const result = await this.deps.getContext();
		if (!result.available) {
			this.lastContextReason = result.reason;
			return;
		}
		this.lastContextReason = "ok";
		const snapshot = toSnapshot(result.context);
		// Fold in the latest browser page (extension bridge), if any. Guarded so
		// the engine works unchanged when no bridge dep is wired.
		if (this.deps.getBrowserContext) {
			const browser = await this.deps.getBrowserContext().catch(() => null);
			if (browser) {
				snapshot.browserUrl = browser.url;
				snapshot.browserContent = browser.content;
			}
		}
		const now = Date.now();
		const change = detectChange(
			this.lastSnapshot,
			snapshot,
			this.opts.ocrSimilarityThreshold
		);
		this.lastSnapshot = snapshot;
		if (change.changed) {
			// (Re)start the debounce window on every fresh change.
			this.pending = { snapshot, since: now };
			return;
		}
		// No change this tick: if a pending change has settled past the debounce
		// window and the app is not cooling down, fire the model call.
		await this.maybeFirePending(now);
	}

	private async maybeFirePending(now: number): Promise<void> {
		const pending = this.pending;
		if (!pending) {
			return;
		}
		if (now - pending.since < this.opts.debounceMs) {
			return;
		}
		const key = appKeyOf(pending.snapshot.appName);
		if (this.cooldown.isCoolingDown(key, now)) {
			this.pending = null;
			return;
		}
		this.pending = null;
		await this.generateFromContext(pending.snapshot, now);
	}

	private async generateFromContext(
		snapshot: ContextSnapshot,
		now: number
	): Promise<void> {
		const messages = buildSuggestionMessages(snapshot);
		const text = await this.deps.complete(messages);
		if (!text) {
			this.log("model returned no text");
			return;
		}
		const parsed = parseModelSuggestion(text, this.opts.confidenceThreshold);
		if (!parsed) {
			this.log("model output dropped (irrelevant/low-confidence/malformed)");
			return;
		}
		const suggestion: IslandSuggestion = {
			id: randomUUID(),
			source: "local_model",
			suggestionType: "context",
			title: parsed.title,
			body: parsed.body,
			action: parsed.action,
			confidence: parsed.confidence,
			appName: snapshot.appName,
			ts: now,
		};
		this.cooldown.arm(appKeyOf(snapshot.appName), now);
		this.emitDeduped(suggestion, now);
	}

	private async proactiveTick(): Promise<void> {
		if (this.proactiveTickActive) {
			return;
		}
		this.proactiveTickActive = true;
		try {
			await this.runProactiveTick();
		} catch (error) {
			this.log(`proactive tick error: ${describeError(error)}`);
		} finally {
			this.proactiveTickActive = false;
		}
	}

	private async runProactiveTick(): Promise<void> {
		const result = await this.deps.getProactive();
		if (!(result.available && result.suggestion)) {
			return;
		}
		const incoming = result.suggestion;
		const now = Date.now();
		const suggestion: IslandSuggestion = {
			id: incoming.id || randomUUID(),
			source: "shadow_proactive",
			suggestionType: incoming.suggestion_type,
			title: incoming.title,
			body: incoming.body ?? "",
			action: "chat",
			confidence: incoming.confidence,
			appName: this.lastSnapshot?.appName ?? null,
			ts: now,
		};
		this.emitDeduped(suggestion, now);
	}

	private emitDeduped(suggestion: IslandSuggestion, now: number): void {
		const key = suggestionKey(suggestion.title, suggestion.appName);
		if (this.dedupe.isDuplicate(key, now)) {
			this.log(`deduped: ${suggestion.title}`);
			return;
		}
		this.dedupe.record(key, now);
		this.emittedById.set(suggestion.id, suggestion);
		this.emittedCount += 1;
		this.deps.emit(suggestion);
		this.log(`emit (${suggestion.source}): ${suggestion.title}`);
	}

	private log(message: string): void {
		this.deps.log?.(`[suggestions] ${message}`);
	}
}

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** No-op for swallowing the never-rejecting tick promise in `setInterval`. */
function noop(): void {
	// Intentionally empty.
}
