import { useLayoutEffect, useState } from "react";

/** The element's size, kept current with a ResizeObserver. */
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

export function isEditable(target: EventTarget | null): boolean {
	return (
		target instanceof HTMLElement &&
		(target.isContentEditable ||
			target.tagName === "INPUT" ||
			target.tagName === "TEXTAREA" ||
			target.tagName === "SELECT")
	);
}
