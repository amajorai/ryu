import { type RefObject, useRef } from "react";

function useLazyRef<T>(fn: () => T): RefObject<T> {
	const ref = useRef<T | null>(null);
	if (ref.current === null) {
		ref.current = fn();
	}
	// SAFETY: The synchronous initializer assigns T before this private React ref is exposed.
	// React retains its nullable allocation type; null-valued T and ref identity stay unchanged.
	return ref as RefObject<T>;
}

export { useLazyRef };
