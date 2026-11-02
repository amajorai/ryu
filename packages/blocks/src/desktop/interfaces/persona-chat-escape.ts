import { useEffect, useRef } from "react";

/**
 * Escape anywhere in the open chat (strip or frame) closes it back to the
 * preview, unless something inside (a menu, the host composer) used it.
 */
export function useEscapeToClose(onClose: (() => void) | null) {
	const ref = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const element = ref.current;
		if (!(element && onClose)) {
			return;
		}
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape" && !event.defaultPrevented) {
				event.preventDefault();
				onClose();
			}
		};
		element.addEventListener("keydown", onKeyDown);
		return () => element.removeEventListener("keydown", onKeyDown);
	}, [onClose]);
	return ref;
}
