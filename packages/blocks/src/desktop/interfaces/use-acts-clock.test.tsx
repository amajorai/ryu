import { afterAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// The clock hook schedules timers on the window: register the DOM, then import.
GlobalRegistrator.register();
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
afterAll(async () => {
	await GlobalRegistrator.unregister();
});

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { usefulStateFixture } = await import(
	"@ryuhq/protocol/interfaces-fixture"
);
const { useActs } = await import("./use-acts.ts");

type Snapshot = ReturnType<typeof usefulStateFixture>;

function Probe({ snapshot }: { snapshot: Snapshot }) {
	const view = useActs(snapshot);
	return <span data-enabled={String(view.enabled)} />;
}

/** Intervals started (and not yet cleared) while `run` mounts the probe. */
async function liveIntervals(snapshot: Snapshot): Promise<number> {
	const started = new Set<number>();
	const realSet = window.setInterval.bind(window);
	const realClear = window.clearInterval.bind(window);
	window.setInterval = ((...args: Parameters<typeof realSet>) => {
		const id = realSet(...args);
		started.add(id);
		return id;
	}) as typeof window.setInterval;
	window.clearInterval = ((id?: number) => {
		started.delete(id as number);
		realClear(id);
	}) as typeof window.clearInterval;
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	try {
		await act(async () => root.render(<Probe snapshot={snapshot} />));
		return started.size;
	} finally {
		await act(async () => root.unmount());
		host.remove();
		window.setInterval = realSet as typeof window.setInterval;
		window.clearInterval = realClear as typeof window.clearInterval;
	}
}

describe("the act clock", () => {
	test("ticks only while the snapshot carries the act layer", async () => {
		const withActs = usefulStateFixture();
		expect(await liveIntervals(withActs)).toBeGreaterThan(0);
		const { asks: _asks, ...oldHost } = withActs;
		expect(await liveIntervals(oldHost)).toBe(0);
	});
});
