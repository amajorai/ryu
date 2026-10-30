import { useCallback, useEffect, useLayoutEffect, useState } from "react";
import { type OpenedDoors, readOpened, writeOpened } from "./seasonal-model.ts";

export function useElementSize(ref: { current: HTMLElement | null }) {
	const [size, setSize] = useState({ height: 0, width: 0 });
	useLayoutEffect(() => {
		const element = ref.current;
		if (!element) {
			return;
		}
		const rect = element.getBoundingClientRect();
		setSize({ height: rect.height, width: rect.width });
		if (typeof ResizeObserver === "undefined") {
			return;
		}
		const observer = new ResizeObserver((records) => {
			const box = records[0]?.contentRect;
			if (box) {
				setSize({ height: box.height, width: box.width });
			}
		});
		observer.observe(element);
		return () => observer.disconnect();
	}, [ref]);
	return size;
}

/**
 * How far down the stage the HUD's top-left column reaches (its measured
 * bottom, relative to the stage's top), or 0 before it is measured. The
 * column wraps at a phone width, so a fixed height would frame the
 * diorama under it.
 */
export function useHudBottom(
	hudRef: { current: HTMLElement | null },
	stageRef: { current: HTMLElement | null },
	/** Changes when the stage resizes or the HUD remounts. */
	layoutKey: string
) {
	const [bottom, setBottom] = useState(0);
	// biome-ignore lint/correctness/useExhaustiveDependencies: re-measured when the stage resizes or the HUD remounts.
	useLayoutEffect(() => {
		const hud = hudRef.current;
		if (!hud) {
			return;
		}
		const measure = () => {
			const stageTop = stageRef.current?.getBoundingClientRect().top;
			const rect = hud.getBoundingClientRect();
			if (stageTop === undefined || rect.height === 0) {
				return;
			}
			setBottom(Math.max(0, Math.round(rect.bottom - stageTop)));
		};
		measure();
		if (typeof ResizeObserver === "undefined") {
			return;
		}
		const observer = new ResizeObserver(measure);
		observer.observe(hud);
		return () => observer.disconnect();
	}, [hudRef, stageRef, layoutKey]);
	return bottom;
}

/** Doors this viewer has opened, kept in this browser. */
export function useOpenedDoors() {
	const [opened, setOpened] = useState<OpenedDoors>({});
	useEffect(() => {
		setOpened(readOpened());
	}, []);
	const update = useCallback(
		(change: (current: OpenedDoors) => OpenedDoors) => {
			setOpened((current) => {
				const next = change(current);
				writeOpened(next);
				return next;
			});
		},
		[]
	);
	return [opened, update] as const;
}

/** How often the board checks whether the local date has turned over. */
const DAY_CHECK_MS = 60_000;

/** Whether two instants fall on different local calendar dates. */
export function localDateChanged(previous: number, next: number): boolean {
	return new Date(previous).toDateString() !== new Date(next).toDateString();
}

/**
 * The current time, advanced only when the local date changes: today's door
 * and an `auto` season move on overnight without re-rendering every minute.
 * Polling (not one long timeout to midnight) survives a sleeping laptop.
 */
export function useLocalDayNow(): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const timer = setInterval(() => {
			const next = Date.now();
			setNow((previous) =>
				localDateChanged(previous, next) ? next : previous
			);
		}, DAY_CHECK_MS);
		return () => clearInterval(timer);
	}, []);
	return now;
}
