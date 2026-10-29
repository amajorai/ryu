import { afterAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// The hook reads the DOM: register it, then import.
GlobalRegistrator.register();
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
afterAll(async () => {
	await GlobalRegistrator.unregister();
});

const { act, useRef } = await import("react");
const { createRoot } = await import("react-dom/client");
const { useStageVisible } = await import("./town-hooks.ts");

function Probe() {
	const ref = useRef<HTMLDivElement>(null);
	const visible = useStageVisible(ref);
	return (
		<div data-game-shell="">
			<div data-testid="stage" data-visible={String(visible)} ref={ref} />
		</div>
	);
}

describe("town stage visibility", () => {
	test("the scene stops drawing while the host covers the interface", async () => {
		const host = document.createElement("div");
		document.body.append(host);
		const root = createRoot(host);
		await act(async () => root.render(<Probe />));
		const stage = () =>
			host.querySelector<HTMLElement>("[data-testid='stage']")?.dataset.visible;
		expect(stage()).toBe("true");
		// A host page opened over the interface makes it inert.
		await act(async () => host.setAttribute("inert", ""));
		expect(stage()).toBe("false");
		await act(async () => host.removeAttribute("inert"));
		expect(stage()).toBe("true");
		await act(async () => root.unmount());
		host.remove();
	});
});
