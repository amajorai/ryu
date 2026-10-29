import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";

if (globalThis.document === undefined) {
	GlobalRegistrator.register();
}

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const { default: InfiniteSentinel } = await import("./infinite-sentinel.tsx");

/** A fake observer that, like the real one, reports state for the targets it
 *  observes only at the next update step (`flushObservers`), not on observe(). */
const observers = new Set<FakeObserver>();
class FakeObserver {
	readonly callback: IntersectionObserverCallback;
	readonly pending = new Set<Element>();
	constructor(callback: IntersectionObserverCallback) {
		this.callback = callback;
		observers.add(this);
	}
	observe(el: Element) {
		this.pending.add(el);
	}
	unobserve(el: Element) {
		this.pending.delete(el);
	}
	disconnect() {
		this.pending.clear();
		observers.delete(this);
	}
}

function flushObservers() {
	for (const observer of [...observers]) {
		const targets = [...observer.pending];
		observer.pending.clear();
		if (targets.length > 0) {
			observer.callback(
				targets.map(
					(target) =>
						({ isIntersecting: true, target }) as IntersectionObserverEntry
				),
				observer as unknown as IntersectionObserver
			);
		}
	}
}

let container: HTMLDivElement;
let root: Root;
let originalObserver: unknown;

beforeEach(() => {
	originalObserver = Reflect.get(globalThis, "IntersectionObserver");
	Reflect.set(globalThis, "IntersectionObserver", FakeObserver);
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});

afterEach(() => {
	act(() => root.unmount());
	container.remove();
	observers.clear();
	Reflect.set(globalThis, "IntersectionObserver", originalObserver);
});

describe("InfiniteSentinel", () => {
	test("keeps paging a synchronous host whose loading flag never toggles", () => {
		let loads = 0;
		function SyncHost() {
			const [count, setCount] = useState(40);
			return (
				<InfiniteSentinel
					hasMore={count < 200}
					itemCount={count}
					loading={false}
					onLoadMore={() => {
						loads += 1;
						setCount((c) => c + 40);
					}}
				/>
			);
		}
		act(() => root.render(<SyncHost />));
		for (let i = 0; i < 3; i += 1) {
			act(() => flushObservers());
		}
		expect(loads).toBe(3);
	});

	test("re-checks a still-visible sentinel once a page lands, even with no visible rows", () => {
		let loads = 0;
		let settle: (() => void) | null = null;
		function AsyncHost() {
			const [loading, setLoading] = useState(false);
			// Raw loaded rows; client-side filters may hide every one of them.
			const [loaded, setLoaded] = useState(40);
			return (
				<InfiniteSentinel
					hasMore
					itemCount={loaded}
					loading={loading}
					onLoadMore={() => {
						loads += 1;
						setLoading(true);
						settle = () => {
							setLoaded((c) => c + 40);
							setLoading(false);
						};
					}}
				/>
			);
		}
		act(() => root.render(<AsyncHost />));
		act(() => flushObservers());
		expect(loads).toBe(1);
		// While the page is in flight nothing new is requested.
		act(() => flushObservers());
		expect(loads).toBe(1);
		// The page lands but did not push the sentinel out of view.
		act(() => settle?.());
		act(() => flushObservers());
		expect(loads).toBe(2);
	});

	test("does not re-request a failed page until the sentinel crosses again", () => {
		let loads = 0;
		let fail: (() => void) | null = null;
		let crossed = false;
		function FailingHost() {
			const [loading, setLoading] = useState(false);
			return (
				<InfiniteSentinel
					hasMore
					itemCount={40}
					loading={loading}
					onLoadMore={() => {
						loads += 1;
						setLoading(true);
						// React Query: `isFetchingNextPage` drops, `data` and
						// `hasNextPage` are unchanged.
						fail = () => setLoading(false);
					}}
				/>
			);
		}
		act(() => root.render(<FailingHost />));
		act(() => flushObservers());
		expect(loads).toBe(1);
		act(() => fail?.());
		// No automatic re-check after a failure: nothing is re-observed.
		for (let i = 0; i < 3; i += 1) {
			act(() => flushObservers());
		}
		expect(loads).toBe(1);
		// A real scroll crossing still retries, because the latch was released.
		act(() => {
			for (const observer of observers) {
				observer.callback(
					[{ isIntersecting: true } as IntersectionObserverEntry],
					observer as unknown as IntersectionObserver
				);
				crossed = true;
			}
		});
		expect(crossed).toBe(true);
		expect(loads).toBe(2);
	});
});
