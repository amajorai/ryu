import { type LiteralMessage, useLiteralMessages } from "@ryu/i18n/react";
import {
	type NativePropertyValue,
	observeNativeOptionalProperty,
} from "@ryu/ui/lib/native-optional-property.mjs";
import { isNativeNumber } from "@ryu/ui/lib/native-primitive-observation.ts";
import { formatTime } from "@ryu/ui/lib/timezone.ts";
import {
	createContext,
	type ReactNode,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";

/**
 * Per-tool-call timing, the row-level counterpart to the whole-turn duration in
 * `message-stats.tsx`.
 *
 * # Two clocks, and why the authoritative one is Core's
 *
 * Core stamps every tool frame it emits with `startedAt` (opening frame) and
 * `startedAt`/`completedAt`/`durationMs` (closing frame), carried in the AI
 * SDK's `providerMetadata` under a `ryu` namespace and landing on the part as
 * `callProviderMetadata`. That stamp survives persistence, so a reopened
 * conversation shows the SAME duration the user watched live.
 *
 * The older mount-based clock is kept as a fallback for parts that carry no
 * stamp — an older Core, or any producer that has not been taught to stamp. Its
 * limitation is the reason the server stamp exists: a row's own mount can only
 * time a call this client actually watched run, so reopening a conversation
 * re-mounts finished rows. `isRunning` starting false is what stops that
 * fallback from displaying a running timer on a call that completed days ago —
 * at the cost of showing nothing at all for it. With a stamp, there is no such
 * cost.
 *
 * # The case this exists for
 *
 * A call that hung and a call that failed used to look identical: both just stop.
 * A stamped call that never received a closing frame renders its START CLOCK
 * rather than a duration ("started 14:32"), which is the one piece of
 * information that tells those two apart after the fact.
 */

const TICK_MS = 100;
const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
/** Below this, whole seconds round most calls to a useless "0s". */
const SUB_SECOND_CUTOFF_MS = 1000;
const TEN_SECONDS_MS = 10_000;

/** One tool call's timing as Core stamped it. */
export interface ToolTimingSource {
	/** Epoch ms when the call's closing frame was emitted, if it ever closed. */
	completedAt?: number;
	/** `completedAt - startedAt`, precomputed by Core. */
	durationMs?: number;
	/** Epoch ms when the call's opening frame was emitted. */
	startedAt: number;
}

/**
 * The stamp for the tool row currently rendering.
 *
 * A context rather than a prop threaded through every renderer: `ToolRowBase`
 * sits under a dozen tool components (Bash, Edit, Todo, MCP, generic, …), and
 * every one of them would otherwise have to forward a value none of them use.
 * Nested subagent rows render their OWN parts, so they re-provide rather than
 * inherit — see `subagent-tool.tsx`.
 */
const ToolTimingContext = createContext<ToolTimingSource | null>(null);

/** A finite, non-negative epoch stamp, or undefined. */
function finiteMs(value: NativePropertyValue): number | undefined {
	return isNativeNumber(value) && Number.isFinite(value) && value >= 0
		? value
		: undefined;
}

/**
 * Read Core's timing stamp off a tool part.
 *
 * Returns null when the part carries none, which is the signal to fall back to
 * the mount clock. A `completedAt` that precedes `startedAt` is dropped rather
 * than rendered as a negative duration — a wall clock can step backwards mid
 * call (an NTP correction), and Core already floors its own `durationMs`.
 */
export function readToolTiming<Part>(part: Part): ToolTimingSource | null {
	const meta = observeNativeOptionalProperty(
		observeNativeOptionalProperty(part, "callProviderMetadata"),
		"ryu"
	);
	const startedAt = finiteMs(observeNativeOptionalProperty(meta, "startedAt"));
	if (startedAt === undefined) {
		return null;
	}
	const completedAt = finiteMs(
		observeNativeOptionalProperty(meta, "completedAt")
	);
	if (completedAt === undefined || completedAt < startedAt) {
		return { startedAt };
	}
	return {
		startedAt,
		completedAt,
		durationMs:
			finiteMs(observeNativeOptionalProperty(meta, "durationMs")) ??
			completedAt - startedAt,
	};
}

/**
 * Publish `part`'s timing stamp to the tool row rendered beneath it.
 *
 * Always renders its children, stamp or not: a part with no stamp provides null,
 * which puts `ToolTiming` back on the mount clock.
 */
export function ToolTimingProvider<Part>({
	part,
	children,
}: {
	children: ReactNode;
	part: Part;
}) {
	const timing = useMemo(() => readToolTiming(part), [part]);
	return (
		<ToolTimingContext.Provider value={timing}>
			{children}
		</ToolTimingContext.Provider>
	);
}

/**
 * Format a tool-call duration.
 *
 * Deliberately finer-grained than `formatDuration` in `message-stats.tsx`, which
 * rounds to whole seconds: that is right for a turn lasting minutes and wrong
 * here, where a great many tool calls finish in under a second and would all
 * render as "0s". Precision tapers as the number grows, so the column stays
 * narrow: "420ms", "3.2s", "12s", "1m 23s".
 */
export function formatToolDuration(ms: number): string {
	if (!Number.isFinite(ms) || ms < 0) {
		return "";
	}
	if (ms < SUB_SECOND_CUTOFF_MS) {
		return `${Math.round(ms)}ms`;
	}
	if (ms < TEN_SECONDS_MS) {
		return `${(ms / MS_PER_SECOND).toFixed(1)}s`;
	}
	const totalSeconds = Math.round(ms / MS_PER_SECOND);
	if (totalSeconds < SECONDS_PER_MINUTE) {
		return `${totalSeconds}s`;
	}
	const minutes = Math.floor(totalSeconds / SECONDS_PER_MINUTE);
	const seconds = totalSeconds % SECONDS_PER_MINUTE;
	return `${minutes}m ${seconds}s`;
}

/** Wall-clock time of day, the form a start stamp is readable in. */
export function formatToolClock(epochMs: number, withSeconds = false): string {
	if (!Number.isFinite(epochMs)) {
		return "";
	}
	return formatTime(epochMs, {
		hour: "2-digit",
		minute: "2-digit",
		...(withSeconds ? { second: "2-digit" } : undefined),
	});
}

/**
 * Elapsed milliseconds for one tool call, live while it runs and frozen once it
 * finishes. Returns null when there is nothing honest to show — either the call
 * was already complete on mount (see the note above), or it never ran.
 *
 * `startedAt` anchors the count to Core's stamp when there is one, so a row that
 * mounts mid-call reports the call's real age instead of restarting from zero.
 */
export function useToolElapsed(
	isRunning: boolean,
	startedAt?: number
): number | null {
	const startedAtRef = useRef<number | null>(null);
	const [elapsedMs, setElapsedMs] = useState<number | null>(null);

	useEffect(() => {
		if (!isRunning) {
			// Freeze on the last tick. Without a recorded start this is a row that
			// mounted already-finished, so it stays null and renders nothing.
			return;
		}
		if (startedAt !== undefined) {
			startedAtRef.current = startedAt;
		} else if (startedAtRef.current === null) {
			startedAtRef.current = Date.now();
		}
		const started = startedAtRef.current;
		setElapsedMs(Date.now() - started);
		const id = setInterval(() => setElapsedMs(Date.now() - started), TICK_MS);
		return () => clearInterval(id);
	}, [isRunning, startedAt]);

	return elapsedMs;
}

/** What the badge should say, resolved from the stamp and the running flag. */
function resolveLabel(
	tl: LiteralMessage,
	timing: ToolTimingSource | null,
	isRunning: boolean,
	elapsedMs: number | null
): { label: string; title: string } | null {
	if (timing) {
		const startedClock = formatToolClock(timing.startedAt, true);
		// Finished: Core's own duration, identical live and on reload.
		if (timing.durationMs !== undefined) {
			return {
				label: formatToolDuration(timing.durationMs),
				title: tl("Started {startedClock} · took {duration}", {
					duration: formatToolDuration(timing.durationMs),
					startedClock,
				}),
			};
		}
		// Still running: tick against Core's start, so a row that mounts mid-call
		// shows the call's real age rather than restarting at zero.
		if (isRunning && elapsedMs !== null) {
			return {
				label: formatToolDuration(elapsedMs),
				title: tl("Running · started {startedClock}", { startedClock }),
			};
		}
		// Opened, never closed, not running. THE case this feature exists for: a
		// hang and a failure both just stop, and the start clock is the only thing
		// that separates them afterwards. Rendered as a time of day, not a
		// duration, so it cannot be misread as "this call took 14 hours".
		return {
			label: tl("started {startedClock}", {
				startedClock: formatToolClock(timing.startedAt),
			}),
			title: tl("Never completed · started {startedClock}", { startedClock }),
		};
	}
	// Unstamped part: mount clock only, which by construction has nothing to say
	// about a call it did not watch run.
	if (elapsedMs === null) {
		return null;
	}
	const label = formatToolDuration(elapsedMs);
	return label ? { label, title: isRunning ? "Running" : "Time taken" } : null;
}

/**
 * The timing badge itself. Muted and tabular so a ticking counter does not
 * shift the row's layout on every frame.
 */
export function ToolTiming({
	isRunning,
	className,
}: {
	className?: string;
	isRunning: boolean;
}) {
	const tl = useLiteralMessages();
	const timing = useContext(ToolTimingContext);
	const elapsedMs = useToolElapsed(isRunning, timing?.startedAt);
	const resolved = resolveLabel(tl, timing, isRunning, elapsedMs);
	if (!resolved) {
		return null;
	}
	return (
		<span
			// Running calls announce themselves; a frozen final time does not need to
			// interrupt a screen reader mid-turn.
			aria-live={isRunning ? "off" : undefined}
			className={
				className ??
				"shrink-0 whitespace-nowrap font-normal text-muted-foreground/70 text-xs tabular-nums"
			}
			title={resolved.title}
		>
			{resolved.label}
		</span>
	);
}
