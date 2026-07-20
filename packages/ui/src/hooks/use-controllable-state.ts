import { useCallback, useEffect, useRef, useState } from "react";

type SetStateFn<T> = (prev: T) => T;

interface UseControllableStateParams<T> {
	/** Initial value used in uncontrolled mode. */
	defaultProp: T;
	/** Called whenever the value changes, in either mode. */
	onChange?: (value: T) => void;
	/** Controlled value. When defined, the hook is in controlled mode. */
	prop?: T | undefined;
}

/**
 * Minimal controllable-state hook (Radix-style): supports both controlled
 * (`prop` + `onChange`) and uncontrolled (`defaultProp`) usage with a single
 * `[value, setValue]` tuple. `setValue` accepts a value or an updater fn.
 */
export function useControllableState<T>({
	prop,
	defaultProp,
	onChange,
}: UseControllableStateParams<T>): readonly [
	T,
	(next: T | SetStateFn<T>) => void,
] {
	const [uncontrolled, setUncontrolled] = useState<T>(defaultProp);
	const isControlled = prop !== undefined;
	const value = isControlled ? (prop as T) : uncontrolled;

	const onChangeRef = useRef(onChange);
	useEffect(() => {
		onChangeRef.current = onChange;
	});

	const setValue = useCallback(
		(next: T | SetStateFn<T>) => {
			if (isControlled) {
				const resolved =
					typeof next === "function"
						? (next as SetStateFn<T>)(prop as T)
						: next;
				if (resolved !== prop) {
					onChangeRef.current?.(resolved);
				}
				return;
			}

			setUncontrolled((prev) => {
				const resolved =
					typeof next === "function" ? (next as SetStateFn<T>)(prev) : next;
				if (resolved !== prev) {
					onChangeRef.current?.(resolved);
				}
				return resolved;
			});
		},
		[isControlled, prop]
	);

	return [value, setValue] as const;
}
