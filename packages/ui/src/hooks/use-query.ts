import { useCallback, useEffect, useRef, useState } from "react";
import {
	isViewVisible,
	subscribeViewVisibility,
} from "../lib/view-visibility.ts";

export interface QueryResult<T> {
	data: T | undefined;
	error: unknown;
	isError: boolean;
	isFetching: boolean;
	isLoading: boolean;
	refetch: () => Promise<void>;
}

export class QueryRequestGate {
	private generation = 0;

	begin(): number {
		this.generation += 1;
		return this.generation;
	}

	isCurrent(request: number): boolean {
		return request === this.generation;
	}

	invalidate(): void {
		this.generation += 1;
	}
}

export function useQuery<T>(opts: {
	queryKey: unknown[];
	queryFn: () => Promise<T>;
	/** Background poll interval in ms; omit to disable polling. */
	refetchInterval?: number;
}): QueryResult<T> {
	const [data, setData] = useState<T | undefined>(undefined);
	const [error, setError] = useState<unknown>(null);
	const [isLoading, setIsLoading] = useState(true);
	const [isFetching, setIsFetching] = useState(true);
	const fnRef = useRef(opts.queryFn);
	fnRef.current = opts.queryFn;
	const gateRef = useRef(new QueryRequestGate());
	const currentRequestRef = useRef<number | null>(null);
	const key = JSON.stringify(opts.queryKey);
	const { refetchInterval } = opts;

	const run = useCallback((aliveRef: { alive: boolean }, silent: boolean) => {
		if (!aliveRef.alive) {
			return Promise.resolve();
		}
		// Let a slow bridge response settle before another automatic poll. Replacing
		// it every interval can otherwise keep the first usable result stale forever.
		if (silent && (currentRequestRef.current !== null || !isViewVisible())) {
			return Promise.resolve();
		}
		const request = gateRef.current.begin();
		// A newer request supersedes every older request. Keep the foreground
		// spinner tied to that newest request so a silent poll cannot leave a
		// manual refetch stuck in `isFetching` after it becomes stale.
		currentRequestRef.current = request;
		setIsFetching(!silent);
		return Promise.resolve()
			.then(() => fnRef.current())
			.then((value) => {
				if (aliveRef.alive && gateRef.current.isCurrent(request)) {
					setData(value);
					setError(null);
				}
			})
			.catch((reason) => {
				if (aliveRef.alive && gateRef.current.isCurrent(request)) {
					setError(reason);
				}
			})
			.finally(() => {
				if (
					aliveRef.alive &&
					gateRef.current.isCurrent(request) &&
					currentRequestRef.current === request
				) {
					currentRequestRef.current = null;
					setIsLoading(false);
					setIsFetching(false);
				}
			});
	}, []);

	const manualRef = useRef<{ alive: boolean }>({ alive: true });

	useEffect(() => {
		const aliveRef = { alive: true };
		manualRef.current = aliveRef;
		run(aliveRef, false);
		let timer: ReturnType<typeof setInterval> | undefined;
		if (refetchInterval && refetchInterval > 0) {
			timer = setInterval(() => run(aliveRef, true), refetchInterval);
		}
		const onVisibility = () => {
			if (isViewVisible()) {
				run(aliveRef, true);
			}
		};
		const unsubscribe = timer
			? subscribeViewVisibility(onVisibility)
			: undefined;
		return () => {
			unsubscribe?.();
			currentRequestRef.current = null;
			aliveRef.alive = false;
			gateRef.current.invalidate();
			if (timer) {
				clearInterval(timer);
			}
		};
	}, [key, refetchInterval, run]);

	const refetch = useCallback(() => {
		return run(manualRef.current, false);
	}, [run]);

	return {
		data,
		error,
		isError: error !== null && error !== undefined,
		isFetching,
		isLoading,
		refetch,
	};
}
