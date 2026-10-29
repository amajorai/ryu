// DOM WIRING test for <CrashBoundary>'s bounded self-recovery (#60).
//
// The pure policy (budget arithmetic) is covered by src/lib/crash-recovery.test.ts.
// What that CANNOT see is the half that actually spins forever when it's wrong:
// the boundary's own lifecycle — whether a remount really happens, whether the
// budget survives `getDerivedStateFromError` (which returns a fresh state object
// on every single crash), and whether the "recovered, refund the budget" timer is
// cancelled when a second crash lands. So this file mounts the REAL component and
// crashes it for real.
//
// The discriminating case is `spends attempt 2 …`: crash → auto-recover → render
// cleanly for a while → crash again. If the stable-render timer or the episode
// field is mishandled, that second crash reads as attempt 1 forever and the
// "budget" bounds nothing.
//
// It lives in e2e/wiring/ (not src/) for the same reason as the ExtensionHost
// wiring test: the happy-dom global registration is process-wide and must not leak
// into the pure unit tests. Run with `bun test e2e/wiring/`.

import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";
import type { Root } from "react-dom/client";

import "./setup-dom.ts";

// --- Sentry capture spy ------------------------------------------------------
// crash.ts is a no-op without VITE_SENTRY_DSN, so the real module could never show
// us what WOULD be reported. Mock it and assert the call shape instead — that is
// the honest evidence for the observability requirement.

interface CapturedReport {
	attempt: number;
	autoRetriesSpent: number;
	kind: "error" | "recovered";
	manualRetries: number;
	tag: string | undefined;
}

const reports: CapturedReport[] = [];

mock.module("@/src/lib/crash.ts", () => ({
	reportCrashEvent: (
		_message: string,
		context?: { extra?: Record<string, number>; tags?: Record<string, string> }
	) => {
		reports.push({
			kind: "recovered",
			attempt: 0,
			autoRetriesSpent: context?.extra?.auto_retries_spent ?? -1,
			manualRetries: context?.extra?.manual_retries ?? -1,
			tag: context?.tags?.crash_recovery,
		});
	},
	reportError: <ReportedError,>(
		_error: ReportedError,
		context?: { extra?: Record<string, number>; tags?: Record<string, string> }
	) => {
		reports.push({
			kind: "error",
			attempt: context?.extra?.attempt ?? -1,
			autoRetriesSpent: context?.extra?.auto_retries_spent ?? -1,
			manualRetries: context?.extra?.manual_retries ?? -1,
			tag: context?.tags?.crash_recovery,
		});
	},
}));

const { CrashBoundary } = await import("@/src/components/CrashBoundary.tsx");
const { MAX_AUTO_RETRIES, RETRY_BACKOFF_MS, STABLE_RENDER_MS } = await import(
	"@/src/lib/crash-recovery.ts"
);
const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");

// --- Harness -----------------------------------------------------------------

/** Flipped by each test to make the child throw or behave. */
let shouldThrow = true;
/** How many times the child has been constructed — i.e. how many mounts happened. */
let mountCount = 0;

function Boom(): React.ReactElement {
	mountCount++;
	if (shouldThrow) {
		throw new Error("Maximum update depth exceeded");
	}
	return createElement("div", { "data-testid": "child" }, "alive");
}

let container: HTMLElement | null = null;
let root: Root | null = null;

/** React logs caught errors to console.error; silence it for the crash tests. */
const realConsoleError = console.error;

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Let React flush effects/timers scheduled during the wait. */
async function advance(ms: number): Promise<void> {
	await act(async () => {
		await sleep(ms);
	});
}

/**
 * Wall time to spend the whole auto-retry budget, plus slack for happy-dom timer
 * drift and the last hop (final backoff → crash → terminal).
 */
const FULL_BUDGET_MS = RETRY_BACKOFF_MS.reduce((sum, ms) => sum + ms, 0) + 1500;

/**
 * Step time forward until `done()` holds. The stepping is REQUIRED, not stylistic:
 * the recovery chain is timer → setState → render → crash → timer, and React only
 * flushes that work as each `act()` scope exits. One long `act(sleep(2500))` sits
 * on the whole chain and the boundary never gets past its first retry.
 */
async function waitUntil(
	done: () => boolean,
	timeoutMs: number
): Promise<void> {
	const step = 100;
	for (let waited = 0; waited < timeoutMs; waited += step) {
		if (done()) {
			return;
		}
		await advance(step);
	}
}

/** Step forward until the fallback shows `needle`, or the budget window elapses. */
async function waitForText(needle: string, timeoutMs: number): Promise<void> {
	await waitUntil(() => text().includes(needle), timeoutMs);
}

async function mountBoundary(): Promise<void> {
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	await act(async () => {
		root?.render(createElement(CrashBoundary, null, createElement(Boom)));
	});
}

function text(): string {
	return container?.textContent ?? "";
}

beforeEach(() => {
	reports.length = 0;
	mountCount = 0;
	shouldThrow = true;
	console.error = () => {
		// swallow React's "The above error occurred in <Boom>" noise
	};
});

afterAll(async () => {
	console.error = realConsoleError;
});

async function unmount(): Promise<void> {
	await act(async () => {
		root?.unmount();
	});
	container?.remove();
	root = null;
	container = null;
}

describe("CrashBoundary self-recovery", () => {
	it("does not show the terminal error immediately — it tries to recover first", async () => {
		await mountBoundary();

		// Straight after the crash the user must NOT be looking at a dead end.
		expect(text()).toContain("Recovering");
		expect(text()).not.toContain("Something broke");

		await unmount();
	});

	it("remounts the failed subtree and comes back alive", async () => {
		await mountBoundary();
		const mountsAtCrash = mountCount;

		// The transient case: whatever broke is gone by the time we retry.
		shouldThrow = false;
		await advance(RETRY_BACKOFF_MS[0] + 200);

		expect(mountCount).toBeGreaterThan(mountsAtCrash);
		expect(text()).toContain("alive");
		expect(text()).not.toContain("Something broke");

		await unmount();
	});

	it("reports every attempt to Sentry with its attempt number", async () => {
		await mountBoundary();
		shouldThrow = false;
		await advance(RETRY_BACKOFF_MS[0] + 200);

		const errors = reports.filter((r) => r.kind === "error");
		expect(errors).toHaveLength(1);
		expect(errors[0]?.attempt).toBe(1);
		expect(errors[0]?.tag).toBe("auto-retry");

		await unmount();
	});

	it("gives up after the budget and renders the terminal UI", async () => {
		await mountBoundary();
		// Never stops throwing — the render-loop shape this feature is bounded for.
		await waitForText("Something broke", FULL_BUDGET_MS);

		expect(text()).toContain("Something broke");
		expect(text()).toContain("Try again or reload.");
		expect(
			container?.querySelector('[data-expressive-expression="dead"]')
		).toBeDefined();
		expect(
			container?.querySelectorAll('[data-expressive-eye-shape="x"]')
		).toHaveLength(2);
		// Exactly MAX_AUTO_RETRIES retries were attempted, then one terminal report.
		const errors = reports.filter((r) => r.kind === "error");
		expect(errors).toHaveLength(MAX_AUTO_RETRIES + 1);
		expect(errors.at(-1)?.tag).toBe("terminal");

		await unmount();
	});

	it("keeps the manual retry and the report affordance on the terminal screen", async () => {
		await mountBoundary();
		await waitForText("Something broke", FULL_BUDGET_MS);

		expect(text()).toContain("Try again");
		expect(text()).toContain("Reload");

		// The manual retry must actually remount, not just clear the message.
		shouldThrow = false;
		const before = mountCount;
		const buttons = [...(container?.querySelectorAll("button") ?? [])];
		const tryAgain = buttons.find((b) => b.textContent?.includes("Try again"));
		expect(tryAgain).toBeDefined();
		await act(async () => {
			tryAgain?.click();
			await sleep(0);
		});

		expect(mountCount).toBeGreaterThan(before);
		expect(text()).toContain("alive");

		await unmount();
	});

	it("spends attempt 2 on a second crash that follows a successful recovery", async () => {
		// THE discriminating case. A stale stable-render timer, or an episode kept
		// in state, would hand this second crash a fresh budget — and a render loop
		// that takes ~100ms to blow up would then retry forever.
		await mountBoundary();
		shouldThrow = false;
		await advance(RETRY_BACKOFF_MS[0] + 200);
		expect(text()).toContain("alive");

		// Render cleanly for a while — but less than STABLE_RENDER_MS, so the
		// episode has NOT been forgiven yet.
		await advance(500);

		// Now break it again, in place, on the same route.
		reports.length = 0;
		shouldThrow = true;
		await act(async () => {
			root?.render(
				createElement(
					CrashBoundary,
					null,
					createElement(Boom, { key: "second" })
				)
			);
			await sleep(0);
		});

		const errors = reports.filter((r) => r.kind === "error");
		expect(errors).toHaveLength(1);
		expect(errors[0]?.attempt).toBe(2);
		expect(errors[0]?.autoRetriesSpent).toBe(2);

		await unmount();
	});

	it(
		"reports the recovery itself, so a self-healed crash is still visible",
		async () => {
			// The requirement this whole feature could quietly fail: a crash the user
			// never noticed must STILL show up in Sentry, or auto-recovery becomes a
			// way to hide bugs. Nothing else in this file asserts the success event,
			// and it is the one path a slightly-too-eager clearTimers() would kill
			// while leaving every other test green.
			await mountBoundary();
			shouldThrow = false;
			await waitForText("alive", RETRY_BACKOFF_MS[0] + 1000);

			await waitUntil(
				() => reports.some((r) => r.kind === "recovered"),
				STABLE_RENDER_MS + 3000
			);

			const recovered = reports.filter((r) => r.kind === "recovered");
			expect(recovered).toHaveLength(1);
			expect(recovered[0]?.tag).toBe("recovered");
			expect(recovered[0]?.autoRetriesSpent).toBe(1);

			await unmount();
		},
		STABLE_RENDER_MS + 15_000
	);

	it("refunds the budget when the reset keys change", async () => {
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		await act(async () => {
			root?.render(
				createElement(
					CrashBoundary,
					{ resetKeys: ["conversation-a"] },
					createElement(Boom)
				)
			);
		});
		await waitForText("Something broke", FULL_BUDGET_MS);

		// Moving to another conversation is a different bug: the crash clears and
		// the next one starts its own budget at attempt 1.
		shouldThrow = false;
		reports.length = 0;
		await act(async () => {
			root?.render(
				createElement(
					CrashBoundary,
					{ resetKeys: ["conversation-b"] },
					createElement(Boom)
				)
			);
			await sleep(0);
		});
		expect(text()).toContain("alive");

		shouldThrow = true;
		await act(async () => {
			root?.render(
				createElement(
					CrashBoundary,
					{ resetKeys: ["conversation-b"] },
					createElement(Boom, { key: "again" })
				)
			);
			await sleep(0);
		});

		const errors = reports.filter((r) => r.kind === "error");
		expect(errors).toHaveLength(1);
		expect(errors[0]?.attempt).toBe(1);

		await unmount();
	});
});
