import { afterAll, afterEach, expect, setSystemTime, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";

GlobalRegistrator.register();
(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const { useDisplayDayRevision } = await import(
	"../../../../packages/ui/src/lib/display-day.ts"
);
const {
	setTimezonePreference,
	resetTimezone,
	startOfDisplayDayMs,
	nextDisplayDayBoundaryMs,
} = await import("../../../../packages/ui/src/lib/timezone.ts");
const { bucketByDate } = await import("./sidebar/date-buckets.ts");
afterEach(() => {
	setSystemTime();
	resetTimezone();
});
afterAll(async () => {
	await GlobalRegistrator.unregister();
});

const wait = (delay: number) =>
	new Promise((resolve) => setTimeout(resolve, delay));
for (const [season, boundary, stamp] of [
	["spring", "2026-03-09T04:00:00Z", "2026-03-08T05:30:00Z"],
	["autumn", "2026-11-02T05:00:00Z", "2026-11-01T04:30:00Z"],
] as const) {
	test(`mounted shared day subscriber moves unchanged ${season} records at the actual scheduled midnight`, async () => {
		const midnight = Date.parse(boundary);
		const records = [
			{ id: "retained", at: Date.parse(stamp), unrelated: "retained" },
		];
		const original = JSON.stringify(records);
		setSystemTime(midnight - 80);
		setTimezonePreference("America/New_York");
		expect(nextDisplayDayBoundaryMs(midnight - 80)).toBe(midnight);
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		function Probe() {
			useDisplayDayRevision();
			const now = Date.now();
			const buckets = bucketByDate(
				records,
				(row) => row.at,
				startOfDisplayDayMs(now),
				{
					yesterday: startOfDisplayDayMs(now, 1),
					lastWeek: startOfDisplayDayMs(now, 7),
					lastMonth: startOfDisplayDayMs(now, 30),
					lastYear: startOfDisplayDayMs(now, 365),
				}
			);
			return (
				<output>
					{JSON.stringify(
						buckets.map((bucket) => ({
							key: bucket.key,
							ids: bucket.items.map((row) => row.id),
						}))
					)}
				</output>
			);
		}
		try {
			await act(async () => {
				root.render(<Probe />);
			});
			expect(container.textContent).toBe(
				'[{"key":"today","ids":["retained"]}]'
			);
			await act(async () => {
				setSystemTime(midnight + 1);
				await wait(120);
			});
			expect(container.textContent).toBe(
				'[{"key":"yesterday","ids":["retained"]}]'
			);
			expect(JSON.stringify(records)).toBe(original);
		} finally {
			await act(async () => {
				root.unmount();
			});
			container.remove();
		}
	});
}

test("mounted day consumers acknowledge zone and focus clock jumps, remount fresh and release their singleton resources", async () => {
	const originalSet = globalThis.setTimeout;
	const originalClear = globalThis.clearTimeout;
	const targets: EventTarget[] = [window, document];
	const originals = targets.map((target) => ({
		target,
		add: target.addEventListener,
		remove: target.removeEventListener,
	}));
	const timers = new Set<ReturnType<typeof setTimeout>>();
	const listeners = new Set<EventListenerOrEventListenerObject>();
	const owned = () =>
		new Error("Audit temporal resource ownership").stack?.includes(
			"/lib/display-day.ts"
		) ?? false;
	globalThis.setTimeout = ((
		handler: (...args: unknown[]) => void,
		delay?: number,
		...args: unknown[]
	) => {
		const track = owned();
		const handle = originalSet(() => {
			timers.delete(handle);
			handler(...args);
		}, delay);
		if (track) {
			timers.add(handle);
		}
		return handle;
	}) as typeof setTimeout;
	globalThis.clearTimeout = ((handle: ReturnType<typeof setTimeout>) => {
		timers.delete(handle);
		return originalClear(handle);
	}) as typeof clearTimeout;
	for (const { target, add, remove } of originals) {
		target.addEventListener = function (type, callback, options) {
			if (callback && owned() && ["focus", "visibilitychange"].includes(type)) {
				listeners.add(callback);
			}
			if (callback) {
				return add.call(this, type, callback, options);
			}
		};
		target.removeEventListener = function (type, callback, options) {
			if (callback) {
				listeners.delete(callback);
			}
			if (callback) {
				return remove.call(this, type, callback, options);
			}
		};
	}
	const container = document.createElement("div");
	document.body.append(container);
	let root = createRoot(container);
	function Probe() {
		return <output>{useDisplayDayRevision()}</output>;
	}
	const at = Date.parse("2026-03-09T03:59:59Z");
	setSystemTime(at);
	setTimezonePreference("America/New_York");
	try {
		await act(async () => {
			root.render(
				<>
					<Probe />
					<Probe />
				</>
			);
		});
		expect(timers.size).toBe(1);
		expect(listeners.size).toBe(2);
		expect(container.querySelectorAll("output")[0].textContent).toBe(
			`America/New_York:${Date.parse("2026-03-08T05:00:00Z")}`
		);
		await act(async () => {
			setTimezonePreference("UTC");
		});
		expect(container.querySelectorAll("output")[0].textContent).toBe(
			`UTC:${Date.parse("2026-03-09T00:00:00Z")}`
		);
		await act(async () => {
			setSystemTime(Date.parse("2026-03-10T12:00:00Z"));
			window.dispatchEvent(new Event("focus"));
		});
		expect(container.querySelectorAll("output")[1].textContent).toBe(
			`UTC:${Date.parse("2026-03-10T00:00:00Z")}`
		);
		await act(async () => {
			root.unmount();
		});
		expect(timers.size).toBe(0);
		expect(listeners.size).toBe(0);
		setSystemTime(at);
		root = createRoot(container);
		await act(async () => {
			root.render(<Probe />);
		});
		expect(container.textContent).toBe(
			`UTC:${Date.parse("2026-03-09T00:00:00Z")}`
		);
		expect(timers.size).toBe(1);
		expect(listeners.size).toBe(2);
	} finally {
		await act(async () => {
			root.unmount();
		});
		expect(timers.size).toBe(0);
		expect(listeners.size).toBe(0);
		container.remove();
		globalThis.setTimeout = originalSet;
		globalThis.clearTimeout = originalClear;
		for (const { target, add, remove } of originals) {
			target.addEventListener = add;
			target.removeEventListener = remove;
		}
	}
});
test("a visible return without any focus event acknowledges a suspended day change and conserves records", async () => {
	// happy-dom pins the main document to "visible"; this own-property stands in
	// for the browser boundary, which updates the state before the event fires.
	let visibility: DocumentVisibilityState = "visible";
	Object.defineProperty(document, "visibilityState", {
		configurable: true,
		get: () => visibility,
	});
	let focusEvents = 0;
	const countFocus = () => {
		focusEvents += 1;
	};
	window.addEventListener("focus", countFocus, true);
	const records = [
		{ id: "retained", at: Date.parse("2026-11-01T15:30:00Z"), note: "kept" },
	];
	const original = JSON.stringify(records);
	// New York noon: the next boundary is hours away, so the bounded recheck
	// (one minute) cannot fire during this test and only the return can wake.
	setSystemTime(Date.parse("2026-11-01T16:00:00Z"));
	setTimezonePreference("America/New_York");
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	function Probe() {
		useDisplayDayRevision();
		const now = Date.now();
		const buckets = bucketByDate(
			records,
			(row) => row.at,
			startOfDisplayDayMs(now),
			{
				yesterday: startOfDisplayDayMs(now, 1),
				lastWeek: startOfDisplayDayMs(now, 7),
				lastMonth: startOfDisplayDayMs(now, 30),
				lastYear: startOfDisplayDayMs(now, 365),
			}
		);
		return <output>{buckets.map((bucket) => bucket.key).join(",")}</output>;
	}
	try {
		await act(async () => {
			root.render(<Probe />);
		});
		expect(container.textContent).toBe("today");
		await act(async () => {
			visibility = "hidden";
			document.dispatchEvent(new Event("visibilitychange"));
		});
		// Suspended across New York midnight while hidden.
		setSystemTime(Date.parse("2026-11-02T13:00:00Z"));
		await act(async () => {
			visibility = "visible";
			document.dispatchEvent(new Event("visibilitychange"));
		});
		expect(container.textContent).toBe("yesterday");
		expect(focusEvents).toBe(0);
		expect(JSON.stringify(records)).toBe(original);
	} finally {
		await act(async () => {
			root.unmount();
		});
		container.remove();
		window.removeEventListener("focus", countFocus, true);
		Reflect.deleteProperty(document, "visibilityState");
	}
	expect(document.visibilityState).toBe("visible");
});
