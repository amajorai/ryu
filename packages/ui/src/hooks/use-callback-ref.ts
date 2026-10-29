import { useEffect, useMemo, useRef } from "react";

/**
 * @see https://github.com/radix-ui/primitives/blob/main/packages/react/use-callback-ref/src/useCallbackRef.tsx
 */

/**
 * A custom hook that converts a callback to a ref to avoid triggering re-renders when passed as a
 * prop or avoid re-executing effects when passed as a dependency
 */
function useCallbackRef<T extends (...args: Parameters<T>) => ReturnType<T>>(
	callback: T | undefined
): (...args: Parameters<T>) => ReturnType<T> | undefined {
	const callbackRef = useRef(callback);

	useEffect(() => {
		callbackRef.current = callback;
	});

	// https://github.com/facebook/react/issues/19240
	return useMemo(
		() =>
			(...args: Parameters<T>) =>
				callbackRef.current?.(...args),
		[]
	);
}

export { useCallbackRef };
