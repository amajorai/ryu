import { useEffect, useId, useRef, useSyncExternalStore } from "react";

interface StackEntry {
	expanded: boolean;
	height: number;
	id: string;
	width: number;
}

const EMPTY_STACK: readonly StackEntry[] = [];
let entries: readonly StackEntry[] = EMPTY_STACK;
const listeners = new Set<() => void>();

function publish(next: readonly StackEntry[]) {
	entries = next;
	for (const listener of listeners) {
		listener();
	}
}

function subscribe(listener: () => void) {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

/** Coordinate separate host status surfaces without owning their connection state. */
export function useConnectionStatusStack(visible: boolean) {
	const id = useId();
	const surfaceRef = useRef<HTMLDivElement>(null);
	const interaction = useRef({ hovered: false, focused: false });
	const collapseTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
		undefined
	);
	const stack = useSyncExternalStore(
		subscribe,
		() => entries,
		() => EMPTY_STACK
	);

	useEffect(() => {
		if (!visible) {
			return;
		}
		const element = surfaceRef.current;
		publish([
			{
				id,
				height: element?.offsetHeight ?? 44,
				width: element?.offsetWidth ?? 340,
				expanded: false,
			},
			...entries,
		]);
		const observer = new ResizeObserver(() => {
			const height = element?.offsetHeight ?? 44;
			const width = element?.offsetWidth ?? 340;
			const entry = entries.find((candidate) => candidate.id === id);
			if (entry?.height !== height || entry?.width !== width) {
				publish(
					entries.map((entry) =>
						entry.id === id ? { ...entry, height, width } : entry
					)
				);
			}
		});
		if (element) {
			observer.observe(element);
		}
		return () => {
			observer.disconnect();
			clearTimeout(collapseTimer.current);
			interaction.current = { hovered: false, focused: false };
			publish(entries.filter((entry) => entry.id !== id));
		};
	}, [id, visible]);

	const index = Math.max(
		0,
		stack.findIndex((entry) => entry.id === id)
	);
	const expanded = stack.some((entry) => entry.expanded);
	const depth = Math.min(index, 2);
	const y = expanded
		? stack
				.slice(0, index)
				.reduce((offset, entry) => offset + entry.height + 8, 0)
		: depth * 10;

	function setInteraction(kind: "hovered" | "focused", value: boolean) {
		interaction.current[kind] = value;
		clearTimeout(collapseTimer.current);
		const next = interaction.current.hovered || interaction.current.focused;
		const update = () => {
			if (entries.find((entry) => entry.id === id)?.expanded !== next) {
				publish(
					entries.map((entry) =>
						entry.id === id ? { ...entry, expanded: next } : entry
					)
				);
			}
		};
		if (next) {
			update();
		} else {
			// Let the pointer cross the gap between expanded cards without collapsing.
			collapseTimer.current = setTimeout(update, 120);
		}
	}

	return {
		expanded,
		frontWidth: stack[0]?.width,
		index,
		opacity: expanded ? 1 : index < 3 ? 1 - depth * 0.15 : 0,
		scale: expanded ? 1 : 1 - depth * 0.03,
		surfaceRef,
		y,
		setHovered: (value: boolean) => setInteraction("hovered", value),
		setFocused: (value: boolean) => setInteraction("focused", value),
	};
}
