import {
	agentActs,
	type ClockOptions,
	type InterfaceAgentAct,
	type InterfaceAsk,
	type InterfaceSnapshot,
	unownedAsks,
} from "@ryuhq/protocol/interfaces";
import {
	createContext,
	createElement,
	type ReactNode,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { type AnnounceState, actAnnouncement } from "./game3d-acts.ts";

/**
 * React glue for the act layer: `useActs(snapshot)` derives every agent's
 * act (protocol `agentActs`) and the unowned asks on a 1 s clock, keeping
 * each agent's act object stable while it is unchanged, so only villagers
 * whose act changed get a new life script. `useActAnnouncement` feeds the
 * game's `ActAnnouncer`. `ActClockProvider` lets a host (the story
 * harness, tests) freeze "now" and pin the clock format.
 */

interface ActClock {
	clock?: ClockOptions;
	/** A frozen "now" (epoch ms); live time when unset. */
	nowMs?: number;
}

const ActClockContext = createContext<ActClock>({});

/** Freezes the act layer's clock (and its clock format) for a subtree. */
export function ActClockProvider({
	children,
	clock,
	nowMs,
}: ActClock & { children: ReactNode }) {
	const value = useMemo(() => ({ clock, nowMs }), [clock, nowMs]);
	return createElement(ActClockContext.Provider, { value }, children);
}

/** The act clock's options (locale, time zone) for labels. */
export function useActClockOptions(): ClockOptions | undefined {
	return useContext(ActClockContext).clock;
}

/**
 * "Now" for the act layer: frozen when provided, else a 1 s tick. With
 * `active` false (no act layer) or a hidden tab, no timer runs.
 */
export function useActNow(intervalMs = 1000, active = true): number {
	const { nowMs } = useContext(ActClockContext);
	const [tick, setTick] = useState(() => Date.now());
	useEffect(() => {
		if (nowMs !== undefined || !active) {
			return;
		}
		const update = () => {
			if (document.visibilityState !== "hidden") {
				setTick(Date.now());
			}
		};
		const timer = window.setInterval(update, intervalMs);
		// Catch up as soon as the tab is shown again.
		document.addEventListener("visibilitychange", update);
		return () => {
			window.clearInterval(timer);
			document.removeEventListener("visibilitychange", update);
		};
	}, [active, intervalMs, nowMs]);
	return nowMs ?? tick;
}

/** True when the snapshot carries the act layer (a host with ask sources). */
export function hasActs(snapshot: Pick<InterfaceSnapshot, "asks">): boolean {
	return snapshot.asks !== undefined;
}

/** Stable JSON of an act, for keeping unchanged acts the same object. */
function actSignature(act: InterfaceAgentAct): string {
	return JSON.stringify(act);
}

export interface ActsView {
	acts: ReadonlyMap<string, InterfaceAgentAct>;
	/** False for an old-host snapshot (no `asks`): render as today. */
	enabled: boolean;
	nowMs: number;
	privacy: "full" | "redacted";
	unowned: InterfaceAsk[];
}

const NO_ACTS: ReadonlyMap<string, InterfaceAgentAct> = new Map();

/** An act kept across renders, with the JSON it was kept for. */
export interface KeptAct {
	act: InterfaceAgentAct;
	signature: string;
}

/**
 * `fresh` acts, keeping the previous object for each agent whose act did
 * not change, so memoised scenes stay put. A kept act takes the fresh
 * act's fields, so its blockers, asks and suggestions are always the
 * CURRENT snapshot's objects: `act.blockers.includes(thread.blocker)`
 * holds for this snapshot. Still, compare snapshot objects by value
 * (`actHasBlocker`), never by identity across renders.
 */
export function stableActs(
	fresh: ReadonlyMap<string, InterfaceAgentAct>,
	previous: ReadonlyMap<string, KeptAct>
): { acts: Map<string, InterfaceAgentAct>; kept: Map<string, KeptAct> } {
	const acts = new Map<string, InterfaceAgentAct>();
	const kept = new Map<string, KeptAct>();
	for (const [id, act] of fresh) {
		const signature = actSignature(act);
		const old = previous.get(id);
		let stable = act;
		if (old && old.signature === signature) {
			// Same content: keep the object, but point it at this snapshot.
			stable = Object.assign(old.act, act);
		}
		acts.set(id, stable);
		kept.set(id, { act: stable, signature });
	}
	return { acts, kept };
}

/**
 * Every agent's act and the unowned asks, recomputed each second. An
 * agent whose act did not change keeps the same object across ticks
 * (`stableActs`), refreshed to the current snapshot's objects.
 */
export function useActs(snapshot: InterfaceSnapshot): ActsView {
	const enabled = hasActs(snapshot);
	const nowMs = useActNow(1000, enabled);
	const clock = useActClockOptions();
	const previous = useRef<ReadonlyMap<string, KeptAct>>(new Map());
	const acts = useMemo(() => {
		if (!enabled) {
			previous.current = new Map();
			return NO_ACTS;
		}
		const { acts: next, kept } = stableActs(
			agentActs(snapshot, nowMs, clock),
			previous.current
		);
		previous.current = kept;
		return next;
	}, [clock, enabled, nowMs, snapshot]);
	const unowned = useMemo(
		() => (enabled ? unownedAsks(snapshot) : []),
		[enabled, snapshot]
	);
	return {
		acts,
		enabled,
		nowMs,
		privacy: snapshot.privacy ?? "full",
		unowned,
	};
}

/** How long the live region stays empty before a new sentence. */
export const ANNOUNCE_GAP_MS = 60;

/**
 * The act announcement for the game's `ActAnnouncer`: silent on the
 * first snapshot, then one sentence per change (new asks, new failures,
 * asks entering their last 2 minutes), re-checked every second.
 */
export function useActAnnouncement(
	snapshot: InterfaceSnapshot,
	view: ActsView
): string | null {
	const state = useRef<AnnounceState | null>(null);
	const [sentence, setSentence] = useState<string | null>(null);
	const pending = useRef<number | null>(null);
	useEffect(
		() => () => {
			if (pending.current !== null) {
				window.clearTimeout(pending.current);
			}
		},
		[]
	);
	const { acts, enabled, nowMs, privacy, unowned } = view;
	useEffect(() => {
		if (!enabled) {
			state.current = null;
			return;
		}
		const result = actAnnouncement(
			state.current,
			acts,
			unowned,
			snapshot,
			nowMs,
			privacy
		);
		state.current = result.state;
		const next = result.sentence;
		if (next) {
			// Clear first, then speak: a live region ignores a sentence equal
			// to the one already in it, and under redaction repeats are routine.
			setSentence(null);
			if (pending.current !== null) {
				window.clearTimeout(pending.current);
			}
			pending.current = window.setTimeout(() => {
				pending.current = null;
				setSentence(next);
			}, ANNOUNCE_GAP_MS);
		}
	}, [acts, enabled, nowMs, privacy, snapshot, unowned]);
	return enabled ? sentence : null;
}
