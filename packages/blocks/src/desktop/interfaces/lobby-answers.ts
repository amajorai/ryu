import {
	type InterfacePort,
	type InterfaceSnapshot,
	localDayKey,
} from "@ryuhq/protocol/interfaces";
import { useEffect, useMemo, useRef, useState } from "react";
import {
	ANSWER_GRACE_MS,
	type SentAnswer,
	settleAnswers,
} from "./lobby-model.ts";

/**
 * The lobby's daily "answer what needs you" tally: blocking asks answered
 * through the ask card today, kept per local day (in storage, shared with
 * other windows) so a remount does not lose them.
 */

/** Where the lobby keeps today's answered asks (per local day). */
export const ANSWERED_KEY = "ryu:lobby-answered";

/** Today's answered ask ids; nothing when storage is unavailable or stale. */
export function readAnswered(day: string): string[] {
	try {
		const raw = globalThis.localStorage?.getItem(ANSWERED_KEY);
		const parsed = raw
			? (JSON.parse(raw) as { day?: string; ids?: unknown })
			: null;
		return parsed?.day === day && Array.isArray(parsed.ids)
			? parsed.ids.filter((id): id is string => typeof id === "string")
			: [];
	} catch {
		return [];
	}
}

/** Adds `ids` to the day's stored list, keeping another window's ids too. */
function writeAnswered(day: string, ids: readonly string[]) {
	try {
		const merged = [...new Set([...readAnswered(day), ...ids])];
		globalThis.localStorage?.setItem(
			ANSWERED_KEY,
			JSON.stringify({ day, ids: merged })
		);
	} catch {
		// Storage can be full or blocked; the count then lasts this session.
	}
}

/**
 * Today's answered count, the port whose answerAsk records answers, and
 * the ids still on their way (not waiting, not yet answered). An answer is
 * recorded only for a blocking ask live when it was sent, and counts once
 * that ask leaves the snapshot within the grace and before it expires.
 */
export function useAnsweredToday(
	snapshot: Pick<InterfaceSnapshot, "asks">,
	port: InterfacePort,
	nowMs: number
): {
	answered: number;
	answerPort: InterfacePort;
	pending: ReadonlySet<string>;
} {
	const today = localDayKey(new Date(nowMs));
	const [answeredToday, setAnsweredToday] = useState(() => ({
		day: today,
		ids: readAnswered(today),
	}));
	const [sent, setSent] = useState<readonly SentAnswer[]>([]);
	const [graceTick, setGraceTick] = useState(0);
	const asks = useRef(snapshot.asks ?? []);
	asks.current = snapshot.asks ?? [];
	const clock = useRef(nowMs);
	clock.current = nowMs;
	// Every snapshot settles the answers on their way (the ids alone would
	// miss "the next snapshot still lists it").
	const liveAsks = snapshot.asks;

	// Re-settle when the first grace (or expiry) runs out, even without a
	// new snapshot. The act clock ticks about once a second, so a re-settle
	// can still find an expiry ahead of it: each re-settle re-arms the timer
	// until the clock passes it.
	// biome-ignore lint/correctness/useExhaustiveDependencies: re-arms after each re-settle (graceTick), when the act clock has moved.
	useEffect(() => {
		if (sent.length === 0) {
			return;
		}
		const wall = Date.now();
		const ends = sent.flatMap((answer) => [
			answer.at + ANSWER_GRACE_MS - wall,
			...(answer.expiresAt === null ? [] : [answer.expiresAt - clock.current]),
		]);
		const timer = setTimeout(
			() => setGraceTick((tick) => tick + 1),
			Math.max(0, Math.min(...ends)) + 50
		);
		return () => clearTimeout(timer);
	}, [graceTick, sent]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: re-runs per snapshot and when the grace runs out.
	useEffect(() => {
		const settled = settleAnswers(
			sent,
			new Set((liveAsks ?? []).map((ask) => ask.id)),
			Date.now(),
			// Expiry by the act clock, the one the countdown shows: a pinned
			// clock is judged at its own time, not the wall's.
			clock.current
		);
		if (settled.sent.length !== sent.length) {
			setSent(settled.sent);
		}
		if (settled.confirmed.length > 0) {
			writeAnswered(today, settled.confirmed);
		}
		setAnsweredToday((state) => {
			const kept = state.day === today ? state.ids : [];
			const ids = [
				...new Set([...kept, ...readAnswered(today), ...settled.confirmed]),
			];
			return state.day === today && ids.length === state.ids.length
				? state
				: { day: today, ids };
		});
	}, [graceTick, liveAsks, sent, today]);

	// Another window's answers count here too.
	useEffect(() => {
		const onStorage = (event: StorageEvent) => {
			if (event.key !== ANSWERED_KEY) {
				return;
			}
			setAnsweredToday((state) => ({
				day: today,
				ids: [
					...new Set([
						...(state.day === today ? state.ids : []),
						...readAnswered(today),
					]),
				],
			}));
		};
		try {
			globalThis.addEventListener?.("storage", onStorage);
		} catch {
			return;
		}
		return () => globalThis.removeEventListener?.("storage", onStorage);
	}, [today]);

	const answerPort = useMemo<InterfacePort>(() => {
		const answerAsk = port.answerAsk;
		if (!answerAsk) {
			return port;
		}
		return {
			...port,
			answerAsk: async (askId, choiceId) => {
				// Only a blocking ask still live when it was answered can count.
				const ask = asks.current.find(
					(item) => item.id === askId && item.blocking
				);
				await answerAsk(askId, choiceId);
				if (!ask) {
					return;
				}
				const expires = ask.expiresAt ? Date.parse(ask.expiresAt) : Number.NaN;
				setSent((list) =>
					list.some((item) => item.id === askId)
						? list
						: [
								...list,
								{
									at: Date.now(),
									expiresAt: Number.isNaN(expires) ? null : expires,
									id: askId,
								},
							]
				);
			},
		};
	}, [port]);

	const pending = useMemo(() => new Set(sent.map((item) => item.id)), [sent]);
	return { answered: answeredToday.ids.length, answerPort, pending };
}
