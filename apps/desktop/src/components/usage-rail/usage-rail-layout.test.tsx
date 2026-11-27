import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { Root } from "react-dom/client";
import type { UsageRailSource } from "@/src/lib/usage-rail/usage-rail-sources.ts";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

// The two side strips measure their own room with a ResizeObserver and never
// from the window size. These tests give the hooks an element of a known size,
// change it, and read how many ring places or which placement comes back. The
// sizes react to what the hook answered, as the real strips do: a ring that
// shows takes its height from the list beside it.

// The sources come from Core through the data hook, which has its own test.
// Bun's module mocks are process-wide and this file runs in its own process.
let railSources: UsageRailSource[] = [];
mock.module("@/src/hooks/useUsageRailSources.ts", () => ({
	useUsageRailSources: () => railSources,
}));

// React DOM reads the DOM globals at import, so load it only after they exist.
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { resetUsageBarPrefs, setUsageBarPrefs } = await import(
	"@/src/hooks/useUsageBarPrefs.ts"
);
const { fitUsageRings, MAX_RING_PLACES, RAIL_MIN_FREE } = await import(
	"@/src/lib/usage-rail/usage-rail-fit.ts"
);
const { useSettingsDialog } = await import("@/src/store/useSettingsDialog.ts");
const {
	RAIL_MIN_ROSTER_HEIGHT,
	RAIL_RING_SLOT,
	SIDEBAR_RING_ROW_HEIGHT,
	SIDEBAR_RING_SLOT,
	useRailRingPlaces,
	useRowRingPlaces,
	useSidebarUsagePlacement,
	useUsageRail,
} = await import("./usage-rail-layout.ts");

/** A ResizeObserver the test fires by hand. */
class ManualResizeObserver {
	static live: ManualResizeObserver[] = [];
	readonly targets: Element[] = [];
	private readonly notify: () => void;

	constructor(notify: () => void) {
		this.notify = notify;
		ManualResizeObserver.live.push(this);
	}

	observe(target: Element) {
		this.targets.push(target);
	}

	unobserve() {
		// The hooks never stop watching one element of several.
	}

	disconnect() {
		ManualResizeObserver.live = ManualResizeObserver.live.filter(
			(observer) => observer !== this
		);
	}

	fire() {
		this.notify();
	}
}

const frames = new Map<number, FrameRequestCallback>();
let nextFrame = 0;
const realGlobals = {
	cancelAnimationFrame: globalThis.cancelAnimationFrame,
	requestAnimationFrame: globalThis.requestAnimationFrame,
	ResizeObserver: globalThis.ResizeObserver,
};

function setGlobal(name: keyof typeof realGlobals, value: unknown) {
	Object.defineProperty(globalThis, name, {
		configurable: true,
		value,
		writable: true,
	});
}

let mounted: { host: HTMLElement; root: Root }[] = [];

beforeEach(() => {
	ManualResizeObserver.live = [];
	frames.clear();
	setGlobal("ResizeObserver", ManualResizeObserver);
	setGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
		nextFrame += 1;
		frames.set(nextFrame, callback);
		return nextFrame;
	});
	setGlobal("cancelAnimationFrame", (frame: number) => {
		frames.delete(frame);
	});
});

afterEach(() => {
	for (const { host, root } of mounted) {
		act(() => root.unmount());
		host.remove();
	}
	mounted = [];
	railSources = [];
	for (const name of Object.keys(realGlobals) as (keyof typeof realGlobals)[]) {
		setGlobal(name, realGlobals[name]);
	}
	act(() => resetUsageBarPrefs());
	localStorage.clear();
	useSettingsDialog.setState({ open: false, section: "general" });
});

/** Mounts a component that reads `useValue` and keeps the latest answer. */
async function mountHook<T>(useValue: () => T) {
	const seen: { renders: number; value: T | undefined } = {
		renders: 0,
		value: undefined,
	};
	function Reader() {
		seen.value = useValue();
		seen.renders += 1;
		return null;
	}
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	mounted.push({ host, root });
	await act(() => root.render(<Reader />));
	return {
		rerender: () => act(() => root.render(<Reader />)),
		get renders() {
			return seen.renders;
		},
		unmount: () => act(() => root.unmount()),
		get value(): T {
			return seen.value as T;
		},
	};
}

/** An element whose measured size the test decides. */
function sized(
	property: "clientHeight" | "clientWidth",
	read: () => number
): { current: HTMLElement } {
	const element = document.createElement("div");
	Object.defineProperty(element, property, { configurable: true, get: read });
	return { current: element };
}

/** A size change reaches the hook on the next frame, as in a browser. */
async function resize() {
	await act(() => {
		for (const observer of ManualResizeObserver.live) {
			observer.fire();
		}
	});
	await act(() => {
		const due = [...frames.values()];
		frames.clear();
		for (const callback of due) {
			callback(0);
		}
	});
}

function source(id: string, leftPercent: number): UsageRailSource {
	return {
		accounts: [],
		id,
		kind: "provider",
		leftPercent,
		logo: { kind: "initial", text: id.slice(0, 1) },
		name: id,
		readable: 1,
		tracks: [{ label: "5h", usedPercent: 100 - leftPercent }],
	};
}

describe("the ring places of the narrow rail", () => {
	/**
	 * A rail that gives its roster and its rings `height.total` pixels together:
	 * every ring place that shows takes one slot from the roster.
	 */
	async function rail(ringCount: number, total: number) {
		const height = { total };
		const count = { rings: ringCount };
		let places = MAX_RING_PLACES;
		const roster = sized(
			"clientHeight",
			() => height.total - Math.min(count.rings, places) * RAIL_RING_SLOT
		);
		const hook = await mountHook(() => {
			places = useRailRingPlaces(roster, count.rings);
			return places;
		});
		return { count, height, hook, roster };
	}
	/** What the roster keeps for itself: three avatars and the free gap. */
	const KEPT = RAIL_MIN_ROSTER_HEIGHT + RAIL_MIN_FREE;

	test("a tall rail gives every ring a place, five at most", async () => {
		const { hook } = await rail(12, 2000);
		expect(hook.value).toBe(MAX_RING_PLACES);
		expect(hook.value).toBe(5);
	});

	test("the roster keeps room for three avatars before a ring gets a place", async () => {
		const four = await rail(6, KEPT + 4 * RAIL_RING_SLOT);
		expect(four.hook.value).toBe(4);
		// One pixel short of the fourth place.
		const three = await rail(6, KEPT + 4 * RAIL_RING_SLOT - 1);
		expect(three.hook.value).toBe(3);
	});

	test("a short rail keeps one place, and that place is the +N ring for all sources", async () => {
		const { hook } = await rail(6, KEPT + RAIL_RING_SLOT - 1);
		expect(hook.value).toBe(1);
		const sources = [90, 10, 50, 70, 30, 60].map((left, index) =>
			source(`s${index}`, left)
		);
		const layout = fitUsageRings(sources, hook.value);
		expect(layout.shown).toEqual([]);
		expect(layout.more).toHaveLength(6);
	});

	test("a rail too short for its own roster still keeps the one place", async () => {
		const { hook } = await rail(6, 40);
		expect(hook.value).toBe(1);
	});

	test("one source keeps its own ring in a short rail, never a +1 ring", async () => {
		const { hook } = await rail(1, KEPT);
		expect(hook.value).toBe(1);
		const layout = fitUsageRings([source("only", 40)], hook.value);
		expect(layout.shown.map((entry) => entry.id)).toEqual(["only"]);
		expect(layout.more).toEqual([]);
	});

	test("with no source nothing is measured and nothing is watched", async () => {
		let reads = 0;
		const roster = sized("clientHeight", () => {
			reads += 1;
			return 0;
		});
		const hook = await mountHook(() => useRailRingPlaces(roster, 0));
		expect(hook.value).toBe(MAX_RING_PLACES);
		expect(reads).toBe(0);
		expect(ManualResizeObserver.live).toHaveLength(0);
	});

	test("a rail with no roster element yet waits without failing", async () => {
		const hook = await mountHook(() => useRailRingPlaces({ current: null }, 3));
		expect(hook.value).toBe(MAX_RING_PLACES);
		expect(ManualResizeObserver.live).toHaveLength(0);
	});

	test("the places follow the rail as the window shrinks and grows", async () => {
		const { height, hook, roster } = await rail(6, 2000);
		expect(hook.value).toBe(5);
		expect(ManualResizeObserver.live).toHaveLength(1);
		expect(ManualResizeObserver.live[0]?.targets).toEqual([roster.current]);

		height.total = KEPT + 2 * RAIL_RING_SLOT + 10;
		await resize();
		expect(hook.value).toBe(2);

		height.total = KEPT + 10;
		await resize();
		expect(hook.value).toBe(1);

		height.total = 2000;
		await resize();
		expect(hook.value).toBe(5);
	});

	test("the answer settles: the room a hidden ring gives back does not bring it back", async () => {
		const { height, hook } = await rail(6, 2000);
		height.total = KEPT + 3 * RAIL_RING_SLOT + 20;
		await resize();
		expect(hook.value).toBe(3);
		// The roster grew by the two places that went away. Measured again and
		// again, the answer stays.
		const renders = hook.renders;
		await resize();
		await resize();
		expect(hook.value).toBe(3);
		expect(hook.renders).toBe(renders);
	});

	test("a size change is measured once, on the next frame", async () => {
		let reads = 0;
		const roster = sized("clientHeight", () => {
			reads += 1;
			return 2000;
		});
		await mountHook(() => useRailRingPlaces(roster, 3));
		// The first measure runs at once, before the first paint.
		expect(reads).toBe(1);
		const [observer] = ManualResizeObserver.live;
		await act(() => {
			observer?.fire();
			observer?.fire();
			observer?.fire();
		});
		expect(reads).toBe(1);
		expect(frames.size).toBe(1);
		await resize();
		expect(reads).toBe(2);
	});

	test("a new number of sources is measured at once", async () => {
		const { count, hook } = await rail(2, KEPT + 2 * RAIL_RING_SLOT);
		expect(hook.value).toBe(2);
		// Four more sources arrive: two places still, one of them the +N ring.
		count.rings = 6;
		await hook.rerender();
		expect(hook.value).toBe(2);
		expect(ManualResizeObserver.live).toHaveLength(1);
	});

	test("an unmounted rail stops watching and drops its pending frame", async () => {
		const { hook } = await rail(6, 2000);
		const [observer] = ManualResizeObserver.live;
		await act(() => observer?.fire());
		expect(frames.size).toBe(1);
		await hook.unmount();
		expect(ManualResizeObserver.live).toHaveLength(0);
		expect(frames.size).toBe(0);
	});

	test("a webview with no ResizeObserver still measures once", async () => {
		setGlobal("ResizeObserver", undefined);
		const { hook } = await rail(6, KEPT + 2 * RAIL_RING_SLOT);
		expect(hook.value).toBe(2);
	});
});

describe("the ring places of the sidebar row", () => {
	/** The inline padding of the row, both sides (`px-2`). */
	const PADDING = 16;

	test("the row holds as many rings as its own width, five at most", async () => {
		const width = { row: PADDING + 3 * SIDEBAR_RING_SLOT };
		const row = sized("clientWidth", () => width.row);
		const hook = await mountHook(() => useRowRingPlaces(row, true));
		expect(hook.value).toBe(3);

		width.row = PADDING + 3 * SIDEBAR_RING_SLOT - 1;
		await resize();
		expect(hook.value).toBe(2);

		width.row = 1200;
		await resize();
		expect(hook.value).toBe(5);
	});

	test("a row with no width yet keeps one place", async () => {
		const row = sized("clientWidth", () => 0);
		const hook = await mountHook(() => useRowRingPlaces(row, true));
		expect(hook.value).toBe(1);
	});

	test("a row that does not show is not measured", async () => {
		let reads = 0;
		const row = sized("clientWidth", () => {
			reads += 1;
			return 0;
		});
		const hook = await mountHook(() => useRowRingPlaces(row, false));
		expect(hook.value).toBe(MAX_RING_PLACES);
		expect(reads).toBe(0);
		expect(ManualResizeObserver.live).toHaveLength(0);
	});

	test("the row is measured when it comes back", async () => {
		const shown = { row: false };
		const row = sized("clientWidth", () => PADDING + 2 * SIDEBAR_RING_SLOT);
		const hook = await mountHook(() => useRowRingPlaces(row, shown.row));
		expect(hook.value).toBe(MAX_RING_PLACES);
		shown.row = true;
		await hook.rerender();
		expect(hook.value).toBe(2);
		expect(ManualResizeObserver.live).toHaveLength(1);
		shown.row = false;
		await hook.rerender();
		expect(ManualResizeObserver.live).toHaveLength(0);
	});
});

describe("where the full sidebar shows its rings", () => {
	/** The chat list is never squeezed under this height. */
	const MIN_LIST = 240;

	/**
	 * A sidebar that gives its chat list and the ring row `height.total` pixels
	 * together: the row takes its height from the list while it shows.
	 */
	async function sidebar(total: number, hasRings = true) {
		const height = { total };
		let placement: "footer" | "row" = "row";
		const list = sized(
			"clientHeight",
			() => height.total - (placement === "row" ? SIDEBAR_RING_ROW_HEIGHT : 0)
		);
		const hook = await mountHook(() => {
			placement = useSidebarUsagePlacement(list, hasRings);
			return placement;
		});
		return { height, hook };
	}

	test("a tall sidebar shows the row above the account footer", async () => {
		const { hook } = await sidebar(900);
		expect(hook.value).toBe("row");
	});

	test("the row stays while the chat list keeps its minimum, to the pixel", async () => {
		const { hook } = await sidebar(MIN_LIST + SIDEBAR_RING_ROW_HEIGHT);
		expect(hook.value).toBe("row");
	});

	test("one pixel less and the row collapses to the ring beside the account button", async () => {
		const { hook } = await sidebar(MIN_LIST + SIDEBAR_RING_ROW_HEIGHT - 1);
		expect(hook.value).toBe("footer");
	});

	test("the placement follows the sidebar as the window shrinks and grows", async () => {
		const { height, hook } = await sidebar(900);
		expect(hook.value).toBe("row");
		height.total = 200;
		await resize();
		expect(hook.value).toBe("footer");
		height.total = 900;
		await resize();
		expect(hook.value).toBe("row");
	});

	test("the collapse does not flip back when the hidden row frees its height", async () => {
		const { height, hook } = await sidebar(900);
		height.total = MIN_LIST + SIDEBAR_RING_ROW_HEIGHT - 1;
		await resize();
		expect(hook.value).toBe("footer");
		// The list is 44 pixels taller now that the row is gone, which is over
		// the minimum on its own. The answer still holds.
		const renders = hook.renders;
		await resize();
		await resize();
		expect(hook.value).toBe("footer");
		expect(hook.renders).toBe(renders);
	});

	test("with no ring to show the list is not measured", async () => {
		const { hook } = await sidebar(100, false);
		expect(hook.value).toBe("row");
		expect(ManualResizeObserver.live).toHaveLength(0);
	});

	test("a sidebar with no list element yet waits without failing", async () => {
		const hook = await mountHook(() =>
			useSidebarUsagePlacement({ current: null }, true)
		);
		expect(hook.value).toBe("row");
	});
});

describe("what both strips read their rings from", () => {
	test("the sources, the reading mode of the preference and the click action", async () => {
		railSources = [source("claude", 40), source("codex", 80)];
		const hook = await mountHook(() => useUsageRail());
		expect(hook.value.sources.map((entry) => entry.id)).toEqual([
			"claude",
			"codex",
		]);
		// A percentage reads as used until the user asks for what is left.
		expect(hook.value.mode).toBe("used");
		await act(() => setUsageBarPrefs({ mode: "remaining" }));
		expect(hook.value.mode).toBe("remaining");
	});

	test("a click on a ring opens Settings on the Usage page", async () => {
		const hook = await mountHook(() => useUsageRail());
		expect(useSettingsDialog.getState().open).toBe(false);
		await act(() => hook.value.openUsage());
		expect(useSettingsDialog.getState().open).toBe(true);
		expect(useSettingsDialog.getState().section).toBe("usage");
	});

	test("with no source the strips get an empty list, not a placeholder", async () => {
		const hook = await mountHook(() => useUsageRail());
		expect(hook.value.sources).toEqual([]);
	});
});
