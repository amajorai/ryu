import {
	type SetStateAction,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import { z } from "zod";

const stateUpdaterSchema = z.function();

/** React treats every callable state action as an updater; retain the original
 * callback after validating that branch of its native SetStateAction union. */
function isStateUpdater<T>(next: SetStateAction<T>): next is (prev: T) => T {
	return stateUpdaterSchema.safeParse(next).success;
}

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
	(next: SetStateAction<T>) => void,
] {
	const [uncontrolled, setUncontrolled] = useState<T>(defaultProp);
	const value = prop === undefined ? uncontrolled : prop;

	const onChangeRef = useRef(onChange);
	useEffect(() => {
		onChangeRef.current = onChange;
	});

	const setValue = useCallback(
		(next: SetStateAction<T>) => {
			if (prop !== undefined) {
				const resolved = isStateUpdater(next) ? next(prop) : next;
				if (resolved !== prop) {
					onChangeRef.current?.(resolved);
				}
				return;
			}

			setUncontrolled((prev) => {
				const resolved = isStateUpdater(next) ? next(prev) : next;
				if (resolved !== prev) {
					onChangeRef.current?.(resolved);
				}
				return resolved;
			});
		},
		[prop]
	);

	return [value, setValue] as const;
}
