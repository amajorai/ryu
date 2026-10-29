// apps/desktop/src/lib/tauri-ready.ts
//
// THE ready-gate for every Tauri IPC call the desktop makes. One module, not a
// guard copy-pasted per call site.
//
// Why it exists: `@tauri-apps/api` is a thin shim over `window.__TAURI_INTERNALS__`
// — `invoke()` is literally `window.__TAURI_INTERNALS__.invoke(...)` and `listen()`
// reaches for `transformCallback` on the same object. Tauri injects that object
// into the webview, and on a cold start the React tree can mount and fire its boot
// effects BEFORE the injection lands. Every such call then rejects with a
// TypeError, and because the boot chains are `listen(...).then(...)` /
// `init().then(...)` with no `.catch`, it surfaces as an unhandled rejection.
// Production (release 0.1.11, 14 days) recorded 88 of them across three
// signatures — "reading 'transformCallback'" (66), "window.__TAURI_INTERNALS__.invoke"
// (14) and "reading 'invoke'" (8) — all early-boot, all this one bug.
//
// The shape of the fix: try the call first (zero added latency on the overwhelming
// majority of boots, where the bridge IS there), and only when it fails *because
// the bridge is missing* wait for the bridge to arrive and retry exactly once.
// So a call made too early QUEUES behind the bridge instead of throwing.
//
// Three rules this file exists to keep:
//
//  1. Only the not-yet-ready case is retried. A genuine IPC failure — the Rust
//     command returned `Err`, the command name is unknown — is detected by the
//     bridge being present at the moment of failure and propagates untouched, with
//     no retry and no swallowing.
//  2. If the bridge never arrives (a plain browser: the Playwright story harness
//     under `e2e/`, browser-mode QA), the wait is bounded by DEADLINE_MS and the
//     verdict is MEMOIZED, so N call sites cost one deadline between them rather
//     than one each. The failure is then a typed {@link TauriUnavailableError},
//     which callers catch — never an unhandled TypeError.
//  3. It must not break `apps/webapp`, which runs this same React tree in a browser
//     with `@tauri-apps/*` aliased to hand-written shims (see
//     `apps/webapp/vite.config.ts`). There `window.__TAURI_INTERNALS__` never
//     exists but the shimmed `invoke` works fine — which is exactly why the gate
//     ATTEMPTS the call before it ever looks at the bridge, and why "bridge
//     missing" alone is never treated as a reason to skip the call.

import { type InvokeArgs, invoke as tauriInvoke } from "@tauri-apps/api/core";
import {
	type EventCallback,
	type EventName,
	listen as tauriListen,
	type UnlistenFn,
} from "@tauri-apps/api/event";
import { z } from "zod";

// Readiness concerns these two native capabilities, not the rest of Window or
// the injected bridge. Both are necessary for invoke and event subscriptions.
const bridgeWindowSchema = z.object({
	__TAURI_INTERNALS__: z.object({
		invoke: z.function(),
		transformCallback: z.function(),
	}),
});
const missingWindowSchema = z.undefined();
const bridgeTypeErrorSchema = z.instanceof(TypeError);
type BridgeFailureInput = Parameters<typeof bridgeTypeErrorSchema.parse>[0];

/** How long to wait for `window.__TAURI_INTERNALS__` before giving up. Injection
 *  is normally sub-frame; this is generous for a slow cold start and short enough
 *  that a plain browser degrades promptly instead of hanging the surface. */
const DEADLINE_MS = 2000;

/** Poll cadence while waiting. Tauri emits no "bridge ready" event, so polling a
 *  property is the only signal available. */
const POLL_INTERVAL_MS = 25;

/** Thrown (and expected to be caught) when the Tauri bridge never showed up —
 *  i.e. this build is running outside a Tauri webview. Typed so callers can tell
 *  "no desktop backend here" apart from "the command failed". */
export class TauriUnavailableError extends Error {
	/** The IPC command or event name that could not be reached. */
	readonly target: string;

	constructor(target: string) {
		super(
			`Tauri IPC "${target}" is unavailable: the desktop bridge never became ready.`
		);
		this.name = "TauriUnavailableError";
		this.target = target;
	}
}

/** True when Tauri has injected its IPC bridge into this window. Synchronous and
 *  free, so it is safe to re-check on every call — that is what lets a LATE
 *  bridge still work after the gate has already returned a negative verdict. */
export function isTauriReady(): boolean {
	return bridgeWindowSchema.safeParse(globalThis.window).success;
}

/** The memoized negative wait. Only ever holds a pending/false-resolved promise:
 *  once the bridge exists {@link isTauriReady} short-circuits ahead of it. */
let pendingGate: Promise<boolean> | null = null;

/**
 * Resolve once the Tauri bridge exists, or `false` after {@link DEADLINE_MS}.
 * Never rejects. Shared across all callers, so twenty call sites in a plain
 * browser wait one deadline between them, not twenty.
 */
export function whenTauriReady(): Promise<boolean> {
	if (isTauriReady()) {
		return Promise.resolve(true);
	}
	if (missingWindowSchema.safeParse(globalThis.window).success) {
		return Promise.resolve(false);
	}
	if (!pendingGate) {
		pendingGate = new Promise<boolean>((resolve) => {
			const startedAt = Date.now();
			const tick = () => {
				if (isTauriReady()) {
					resolve(true);
					return;
				}
				if (Date.now() - startedAt >= DEADLINE_MS) {
					// Leave the resolved promise memoized: the sync re-check above is
					// what recovers a bridge that arrives after the deadline.
					resolve(false);
					return;
				}
				setTimeout(tick, POLL_INTERVAL_MS);
			};
			tick();
		});
	}
	return pendingGate;
}

/**
 * Is this failure "the bridge isn't there yet" rather than "the call failed"?
 *
 * Both halves are required. The TypeError class is what a missing
 * `window.__TAURI_INTERNALS__` produces in every one of the three production
 * signatures; the bridge-absence check is what stops a real IPC rejection — or
 * the webapp shim's own `Error("… is not supported on web")` — from being
 * mistaken for one and retried.
 */
function isBridgeMissingFailure(error: BridgeFailureInput): boolean {
	return bridgeTypeErrorSchema.safeParse(error).success && !isTauriReady();
}

/**
 * `invoke`, but a call made before the bridge exists queues until it arrives
 * instead of throwing.
 *
 * Genuine command failures reject exactly as `invoke` would — same error, no
 * retry. Outside Tauri (and outside the webapp shim) it rejects with
 * {@link TauriUnavailableError} after the bounded wait.
 */
export async function invokeWhenReady<T>(
	command: string,
	args?: InvokeArgs
): Promise<T> {
	try {
		return await tauriInvoke<T>(command, args);
	} catch (error) {
		if (!isBridgeMissingFailure(error)) {
			throw error;
		}
		if (!(await whenTauriReady())) {
			throw new TauriUnavailableError(command);
		}
		// The single bounded retry. Anything it throws is a real IPC failure now
		// that the bridge is demonstrably present, so it propagates untouched.
		return await tauriInvoke<T>(command, args);
	}
}

/** Nothing was subscribed, so there is nothing to tear down. */
const NOOP_UNLISTEN: UnlistenFn = () => {
	// no-op
};

/**
 * React effect cleanup is fire-and-forget at every call site in the desktop.
 * Tauri's event unlisten function is async and reaches into a separate event
 * plugin bridge before it invokes native cleanup. That bridge can disappear
 * during a webview teardown, so let cleanup fail closed instead of turning a
 * stale listener into an unhandled rejection.
 */
function safeUnlisten(unlisten: UnlistenFn): UnlistenFn {
	let called = false;
	return () => {
		if (called) {
			return;
		}
		called = true;
		try {
			void Promise.resolve(unlisten()).catch(() => undefined);
		} catch {
			// The bridge may disappear between effect cleanup and this call.
		}
	};
}

/**
 * `listen`, but a subscription attempted before the bridge exists waits for it
 * rather than rejecting — and, outside Tauri, resolves to a no-op unlisten so the
 * caller's `.then((fn) => unlisteners.push(fn))` stays honest instead of becoming
 * an unhandled rejection.
 *
 * A failure with the bridge present still rejects: a listener that silently never
 * fires is worse than a loud one.
 */
export async function listenWhenReady<T>(
	event: EventName,
	handler: EventCallback<T>
): Promise<UnlistenFn> {
	try {
		return safeUnlisten(await tauriListen<T>(event, handler));
	} catch (error) {
		if (!isBridgeMissingFailure(error)) {
			throw error;
		}
		if (!(await whenTauriReady())) {
			return NOOP_UNLISTEN;
		}
		return safeUnlisten(await tauriListen<T>(event, handler));
	}
}

/**
 * Run `work` once the bridge is ready, for the Tauri APIs that are not `invoke`
 * or `listen` (`getCurrentWindow`, `getVersion`, the deep-link plugin, …).
 * Resolves to `null` when the bridge never arrives, so callers degrade with a
 * value instead of a rejection.
 */
export async function withTauri<T>(
	work: () => Promise<T> | T
): Promise<T | null> {
	try {
		return await work();
	} catch (error) {
		if (!isBridgeMissingFailure(error)) {
			throw error;
		}
		if (!(await whenTauriReady())) {
			return null;
		}
		return await work();
	}
}

/**
 * Did this call fail because no desktop backend exists here at all? True for a
 * {@link TauriUnavailableError}, and for the `ReferenceError` a runtime with no
 * `window` (unit tests under Bun) throws before any bridge check can run. A
 * failure while the bridge is present is a real command error and returns false.
 */
export function isNoDesktopBackend(error: unknown): boolean {
	return (
		error instanceof TauriUnavailableError ||
		(error instanceof ReferenceError && !isTauriReady())
	);
}

/** Test-only: forget the memoized negative verdict so a fresh wait can run. */
export function resetTauriGateForTests(): void {
	pendingGate = null;
}
