// Ryu-owned adaptation of the termcn timer pool; protected by scripts/vendor-termcn.ts.

import { useEffect, useState } from "react";
import { z } from "zod";
import { useMotion } from "@/components/ui/theme-provider";

const animationIntervalSchema = z
	.union([
		z.number().transform((rate) => ({ intervalMs: Math.round(1000 / rate) })),
		z.object({ intervalMs: z.number() }),
	])
	.catch({ intervalMs: Number.NaN });

type Subscriber = (tick: number) => void;
const pool = new Map<
	number,
	{ id: ReturnType<typeof setInterval>; subs: Set<Subscriber> }
>();
function subscribe(milliseconds: number, subscriber: Subscriber): () => void {
	let entry = pool.get(milliseconds);
	if (!entry) {
		const subs = new Set<Subscriber>();
		let tick = 0;
		const id = setInterval(() => {
			tick++;
			for (const sub of subs) sub(tick);
		}, milliseconds);
		entry = { id, subs };
		pool.set(milliseconds, entry);
	}
	entry.subs.add(subscriber);
	return () => {
		if (!entry.subs.delete(subscriber)) {
			return;
		}
		if (entry.subs.size === 0) {
			clearInterval(entry.id);
			pool.delete(milliseconds);
		}
	};
}

export function useAnimation(
	rate: number | { intervalMs: number } = 12,
): number {
	const { reduced } = useMotion();
	const [frame, setFrame] = useState(0);
	const { intervalMs: milliseconds } = animationIntervalSchema.parse(rate);
	const enabled =
		!reduced && Number.isFinite(milliseconds) && milliseconds >= 1;
	useEffect(() => {
		if (!enabled) return;
		return subscribe(milliseconds, setFrame);
	}, [enabled, milliseconds]);
	return enabled ? frame : 0;
}
