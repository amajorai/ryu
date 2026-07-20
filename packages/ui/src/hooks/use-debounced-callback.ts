import { useCallback, useEffect, useRef } from "react";
/**
 * @see https://github.com/mantinedev/mantine/blob/master/packages/@mantine/hooks/src/use-debounced-callback/use-debounced-callback.ts
 */

import { useCallbackRef } from "@ryu/ui/hooks/use-callback-ref.ts";

export function useDebouncedCallback<T extends (...args: never[]) => unknown>(
	callback: T,
	delay: number
) {
	const handleCallback = useCallbackRef(callback);
	const debounceTimerRef = useRef(0);
	useEffect(() => () => window.clearTimeout(debounceTimerRef.current), []);

	const setValue = useCallback(
		(...args: Parameters<T>) => {
			window.clearTimeout(debounceTimerRef.current);
			debounceTimerRef.current = window.setTimeout(
				() => handleCallback(...args),
				delay
			);
		},
		[handleCallback, delay]
	);

	return setValue;
}
