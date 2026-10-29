import "./CrashBoundary.css";
// apps/desktop/src/components/CrashBoundary.tsx
//
// Renderer error boundary for the crash reporting tier (#544, P3). Wraps the app so
// an unhandled render error is (a) caught and shown a recoverable fallback instead
// of a white screen, and (b) reported to Sentry — but ONLY when the user consented
// to crash reports AND a DSN is configured (the gate lives in reportError()).
//
// This is the renderer half of the Rust panic tier in apps/core/src/crash.rs. It
// never reports prompt/agent content: only the error itself, already PII-scrubbed
// by crash.ts's beforeSend.
//
// BOUNDED SELF-RECOVERY (#60). A caught error no longer dead-ends on "Something
// went wrong". The boundary first tries to remount the failed subtree — most
// renderer crashes here are transient (a stale prop, one bad payload) and a
// remount is invisible to the user. The policy behind that lives in
// lib/crash-recovery.ts; the three rules that make it safe:
//
//   1. It is BUDGETED. The crash this was built for is React's "Maximum update
//      depth exceeded" — a render loop, which re-throws the instant it remounts.
//      MAX_AUTO_RETRIES caps the spin; after that the terminal UI renders and
//      stays. The budget is the feature, not a detail.
//   2. It is LOUD. Every attempt is reported to Sentry with its attempt number,
//      and a recovery that succeeds emits its own event. Auto-recovery that hides
//      a real bug is worse than the crash it hid.
//   3. It is OFF IN DEV (AUTO_RETRY_ENABLED). A developer must see an infinite
//      loop as an infinite loop, not as a self-healing app.
//
// The budget belongs to an *episode*, held in an instance field rather than in
// state — see the comment on `episode` for why putting it in state would silently
// unbound the retries.

import { Button } from "@ryu/ui/components/button.tsx";
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@ryu/ui/components/empty.tsx";
import { Logo } from "@ryu/ui/components/logo.tsx";
import { Spinner } from "@ryu/ui/components/spinner.tsx";
import { Component, type ErrorInfo, Fragment, type ReactNode } from "react";
import { isDeveloperMode } from "@/src/hooks/useDeveloperMode.ts";
import {
	getConsoleBufferText,
	limitConsoleText,
	MAX_CONSOLE_COPY_LINES,
} from "@/src/lib/console-buffer.ts";
import { reportCrashEvent, reportError } from "@/src/lib/crash.ts";
import { getCrashRoute } from "@/src/lib/crash-context.ts";
import {
	episodeDidRecover,
	MAX_AUTO_RETRIES,
	planRecovery,
	type RecoveryEpisode,
	recordManualRetry,
	resetKeysChanged,
	STABLE_RENDER_MS,
} from "@/src/lib/crash-recovery.ts";

/**
 * Auto-retry is production-only. In dev a render loop must stay loud: remounting
 * it would turn "Maximum update depth exceeded" into a mysterious flicker and cost
 * a developer the stack that tells them which component to fix.
 *
 * Deliberately NOT gated on isDeveloperMode() as well — that is a toggle real
 * users turn on, and gating on it would strip recovery from exactly the people
 * this exists for.
 */
const AUTO_RETRY_ENABLED = !import.meta.env.DEV;

interface CrashBoundaryProps {
	children: ReactNode;
	/**
	 * Changing any of these clears a crash and starts a fresh budget — the
	 * "different screen, different bug" signal for a boundary that wraps something
	 * narrower than the app. The root boundary in App.tsx passes none: it sits
	 * outside the tabs context, so it cannot observe the route reactively and
	 * instead keys its episode on the route recorded at crash time (see
	 * `episodeRouteKey()`).
	 */
	resetKeys?: readonly unknown[];
}

/** What the boundary is currently showing. */
type CrashPhase =
	/** No error — children render. */
	| "ok"
	/** Crashed, an automatic remount is scheduled: neutral placeholder, no scary copy. */
	| "recovering"
	/** Budget spent (or auto-retry disabled): the terminal error UI. */
	| "terminal";

interface CrashBoundaryState {
	/** React component stack from componentDidCatch (names the failing component). */
	componentStack: string | null;
	copied: boolean;
	error: Error | null;
	phase: CrashPhase;
	/** Bumped to remount the child subtree. THIS is the recovery mechanism. */
	retryKey: number;
}

// Stack-frame parsing regexes (top-level per the code standards). Handle both
// WebKit (`name@url`) and Chromium (`at name (url)`) frame formats — the desktop
// runs in WKWebView but a dev may reproduce in Chromium.
const FRAME_URL_RE = /https?:\/\/[^\s)]+/;
const TRAILING_PARENS_RE = /\)+$/;
const ORIGIN_RE = /^https?:\/\/[^/]+\//;
const VITE_FS_RE = /^@fs\//;
const REPO_ROOT_RE = /^.*\/ryu-closed\//;
const WEBKIT_NAME_RE = /^([^@\s]+)@/;
const CHROMIUM_NAME_RE = /^at\s+([^\s(]+)\s*\(/;

/**
 * Pull the first *app* source frame out of an error stack, skipping bundler and
 * dependency frames (Vite deps, node_modules), rendered as `name (path:line:col)`
 * relative to the dev origin. Best-effort: returns null when no app frame is
 * recognizable.
 */
function firstAppFrame(stack: string | undefined): string | null {
	if (!stack) {
		return null;
	}
	for (const raw of stack.split("\n")) {
		const line = raw.trim();
		const urlMatch = line.match(FRAME_URL_RE);
		if (!urlMatch) {
			continue;
		}
		const url = urlMatch[0].replace(TRAILING_PARENS_RE, "");
		if (url.includes("/node_modules/") || url.includes("/.vite/")) {
			continue;
		}
		const rel = url
			.replace(ORIGIN_RE, "")
			.replace(VITE_FS_RE, "")
			.replace(REPO_ROOT_RE, "");
		const name =
			line.match(WEBKIT_NAME_RE)?.[1] ??
			line.match(CHROMIUM_NAME_RE)?.[1] ??
			null;
		return name ? `${name} (${rel})` : rel;
	}
	return null;
}

export class CrashBoundary extends Component<
	CrashBoundaryProps,
	CrashBoundaryState
> {
	/**
	 * The retry budget for the crash episode in flight.
	 *
	 * An INSTANCE FIELD, not state, and that is load-bearing:
	 * getDerivedStateFromError runs on every caught error and returns a fresh state
	 * object, so a budget living in state would be reset by the very crash it is
	 * supposed to be counting — an infinite retry loop wearing a budget's clothes.
	 * Nothing here affects rendering, so it has no business in state anyway.
	 */
	private episode: RecoveryEpisode | null = null;

	/** Pending automatic remount (the backoff window). */
	private retryTimer: ReturnType<typeof setTimeout> | null = null;

	/** Pending "this render stuck, refund the budget" confirmation. */
	private stableTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(props: CrashBoundaryProps) {
		super(props);
		this.state = {
			phase: "ok",
			error: null,
			copied: false,
			componentStack: null,
			retryKey: 0,
		};
	}

	static getDerivedStateFromError(error: Error): Partial<CrashBoundaryState> {
		// Decide the *display* here so the user never sees "Something went wrong"
		// flash for one frame before an automatic retry takes it away. The budget
		// decision proper happens in componentDidCatch, which can downgrade
		// "recovering" to "terminal" when the budget turns out to be spent.
		// NOTE: never return retryKey here — that would undo remounts.
		return {
			phase: AUTO_RETRY_ENABLED ? "recovering" : "terminal",
			error,
			copied: false,
			componentStack: null,
		};
	}

	componentDidUpdate(prev: CrashBoundaryProps): void {
		if (
			this.state.phase !== "ok" &&
			resetKeysChanged(prev.resetKeys, this.props.resetKeys)
		) {
			// A different screen is a different bug: drop the crash and the budget.
			this.clearTimers();
			this.episode = null;
			this.setState((s) => ({
				phase: "ok",
				error: null,
				copied: false,
				componentStack: null,
				retryKey: s.retryKey + 1,
			}));
		}
	}

	componentWillUnmount(): void {
		this.clearTimers();
	}

	private clearTimers(): void {
		if (this.retryTimer !== null) {
			clearTimeout(this.retryTimer);
			this.retryTimer = null;
		}
		if (this.stableTimer !== null) {
			clearTimeout(this.stableTimer);
			this.stableTimer = null;
		}
	}

	/** Route path only — never the tab title, which is a conversation title. */
	private static routeKey(): string | null {
		return getCrashRoute()?.path ?? null;
	}

	/**
	 * The route this episode belongs to. Sampled ONCE, when the episode opens, and
	 * then held.
	 *
	 * Re-reading it on every crash looks harmless and is not: the crash route is a
	 * module singleton written by a Layout effect, and a remount re-runs that
	 * effect. Until the tabs context has re-resolved its active tab, the singleton
	 * reads null. A crash inside that window would look like "a different route",
	 * planRecovery would hand it a FRESH budget, and a loop alternating
	 * null → "/chat" → null would be attempt 1 forever — the budget bounding
	 * nothing at all.
	 *
	 * Holding the route means a genuine navigation only starts a new episode once
	 * the current one is over (cleared by a clean render, a manual retry, or
	 * resetKeys) — which is also the only time the user could actually have
	 * navigated, since the terminal screen has replaced the app.
	 */
	private episodeRouteKey(): string | null {
		return this.episode ? this.episode.routeKey : CrashBoundary.routeKey();
	}

	componentDidCatch(error: Error, info: ErrorInfo): void {
		// A new crash voids any in-flight timers. Clearing the stable timer is the
		// subtle one: if it survived, it would fire after this crash, report a
		// success that did not happen, and refund the budget — reopening the
		// unbounded-retry hole from the other side.
		this.clearTimers();

		const plan = planRecovery(this.episode, {
			autoRetryEnabled: AUTO_RETRY_ENABLED,
			routeKey: this.episodeRouteKey(),
		});
		this.episode = plan.episode;
		const { decision } = plan;

		// Keep the React component stack for the dev "Copy console" action — it names
		// the failing component (e.g. <EditorRefPluginEffect>), which the raw JS stack
		// often doesn't. State-only; never sent to the network.
		this.setState({ componentStack: info.componentStack ?? null });

		// Gated inside reportError(): a no-op unless crash reports are consented +
		// a DSN is set. The error is PII-scrubbed in crash.ts's beforeSend. The
		// context is counts and outcomes ONLY — no route, no title, no content.
		reportError(error, {
			tags: {
				crash_recovery: decision.kind === "retry" ? "auto-retry" : "terminal",
				crash_recovery_reason:
					decision.kind === "retry" ? "budgeted" : decision.reason,
			},
			extra: {
				attempt: decision.kind === "retry" ? decision.attempt : 0,
				auto_retries_spent: plan.episode.autoRetries,
				manual_retries: plan.episode.manualRetries,
				max_auto_retries: MAX_AUTO_RETRIES,
			},
		});

		if (decision.kind === "terminal") {
			this.setState({ phase: "terminal" });
			return;
		}
		this.retryTimer = setTimeout(() => {
			this.retryTimer = null;
			this.remount();
		}, decision.delayMs);
	}

	/** Bump the key so React throws away the failed subtree and builds a new one. */
	private remount(): void {
		this.setState((s) => ({
			phase: "ok",
			error: null,
			copied: false,
			componentStack: null,
			retryKey: s.retryKey + 1,
		}));
		// The remount only counts as a recovery once it has SURVIVED. A render loop
		// re-throws within a frame or two, which cancels this timer in
		// componentDidCatch long before it fires.
		this.stableTimer = setTimeout(() => {
			this.stableTimer = null;
			this.confirmRecovered();
		}, STABLE_RENDER_MS);
	}

	/**
	 * The subtree has rendered cleanly for STABLE_RENDER_MS. Report the save and
	 * refund the budget so a later, unrelated crash gets its own retries.
	 */
	private confirmRecovered(): void {
		const episode = this.episode;
		this.episode = null;
		if (!episodeDidRecover(episode)) {
			return;
		}
		// The whole point of the observability requirement: a crash the user never
		// saw is still a crash, and this is the event that says one happened AND
		// that the remount worked.
		reportCrashEvent("crash boundary recovered", {
			tags: { crash_recovery: "recovered" },
			extra: {
				auto_retries_spent: episode.autoRetries,
				manual_retries: episode.manualRetries,
				stable_render_ms: STABLE_RENDER_MS,
			},
		});
	}

	/** Terminal-screen "Try again": remount in place, no full page reload. */
	handleRetry = (): void => {
		this.clearTimers();
		this.episode = recordManualRetry(this.episode, this.episodeRouteKey());
		this.remount();
	};

	handleReload = (): void => {
		this.clearTimers();
		this.episode = null;
		this.setState({
			phase: "ok",
			error: null,
			copied: false,
			componentStack: null,
		});
		window.location.reload();
	};

	// Dev-only: copy the crash stack + recent console output to the clipboard so a
	// developer can paste it into a bug report without scrolling devtools.
	handleCopyConsole = async (): Promise<void> => {
		const parts: string[] = [];
		const { error, componentStack } = this.state;

		// Context header: where the user was + which file/component blew up, so a
		// pasted report is self-explanatory without re-deriving it from the stack.
		const route = getCrashRoute();
		if (route) {
			parts.push(
				`Route: ${route.path}${route.title ? ` — ${route.title}` : ""}`
			);
		}
		const frame = firstAppFrame(error?.stack);
		if (frame) {
			parts.push(`Source: ${frame}`);
		}
		if (route || frame) {
			parts.push("");
		}

		if (error) {
			parts.push(error.stack ?? `${error.name}: ${error.message}`, "");
		}
		if (componentStack) {
			parts.push("Component stack:", componentStack.trim(), "");
		}
		parts.push(getConsoleBufferText());
		const copiedText = limitConsoleText(
			parts.join("\n"),
			MAX_CONSOLE_COPY_LINES
		);
		try {
			await navigator.clipboard.writeText(copiedText);
			this.setState({ copied: true });
		} catch {
			// Clipboard writes can reject without focus/permission; nothing to do.
		}
	};

	render(): ReactNode {
		if (this.state.phase === "recovering") {
			return this.renderShell(
				<Empty purpose="recovery">
					<EmptyHeader>
						<EmptyMedia variant="icon">
							<Spinner className="size-6" />
						</EmptyMedia>
						<EmptyTitle>Recovering…</EmptyTitle>
					</EmptyHeader>
				</Empty>
			);
		}

		if (this.state.phase === "terminal") {
			return this.renderShell(
				<Empty purpose="terminal">
					<EmptyHeader spacing="relaxed">
						<EmptyMedia className="mb-0" tone="destructive">
							<Logo
								animated={false}
								animation="idle"
								expression="dead"
								size="96px"
								variant="expressive"
							/>
						</EmptyMedia>
						<EmptyTitle>Something broke</EmptyTitle>
						<EmptyDescription>Try again or reload.</EmptyDescription>
					</EmptyHeader>
					<EmptyContent spacing="compact">
						<div className="flex flex-wrap items-center justify-center gap-2">
							{/* Try again first: it remounts in place and keeps app state,
							    where Reload throws the whole renderer away. */}
							<Button onClick={this.handleRetry} size="sm">
								Try again
							</Button>
							<Button onClick={this.handleReload} size="sm" variant="ghost">
								Reload
							</Button>
							{import.meta.env.DEV || isDeveloperMode() ? (
								<Button
									onClick={this.handleCopyConsole}
									size="sm"
									variant="ghost"
								>
									{this.state.copied ? "Copied" : "Copy console"}
								</Button>
							) : null}
						</div>
					</EmptyContent>
				</Empty>
			);
		}

		// `key` is the recovery mechanism: bumping it discards the failed subtree
		// and mounts a fresh one, so a component wedged in a bad state gets rebuilt
		// from scratch rather than resuming from the state that broke it.
		return <Fragment key={this.state.retryKey}>{this.props.children}</Fragment>;
	}

	/**
	 * CrashBoundary renders OUTSIDE PageWrapper, so PageWrapper's `bg-background`
	 * surface is gone when a fallback shows. The body is intentionally transparent
	 * (see index.css), so we must paint the rounded window surface here ourselves,
	 * otherwise the screen shows through with no background and square corners.
	 */
	private renderShell(content: ReactNode): ReactNode {
		return (
			<div
				className="flex h-screen w-full items-center justify-center overflow-hidden bg-background backdrop-blur-xl"
				data-crash-window-shell=""
				data-tauri-drag-region
			>
				{content}
			</div>
		);
	}
}
