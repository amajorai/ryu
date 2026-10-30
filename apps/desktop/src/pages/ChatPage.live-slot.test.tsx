import { expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, memo, type ReactNode, useState } from "react";

if (globalThis.document === undefined) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const { createRoot } = await import("react-dom/client");
const { useLiveSlot } = await import("./ChatPage.live-slot.tsx");

test("the slot element keeps its identity and shows the newest node", async () => {
	const slots = new Set<ReactNode>();
	let holderRenders = 0;
	// Stands in for the memoized title bar actions: it renders only when the
	// slot element's identity changes.
	const Holder = memo(function Holder({ slot }: { slot: ReactNode }) {
		holderRenders += 1;
		return <div data-testid="holder">{slot}</div>;
	});
	let bump: () => void = () => undefined;
	function Page() {
		const [count, setCount] = useState(0);
		bump = () => setCount((value) => value + 1);
		const slot = useLiveSlot(<span>picker {count}</span>);
		slots.add(slot);
		return <Holder slot={slot} />;
	}
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	await act(async () => {
		root.render(<Page />);
	});
	expect(container.textContent).toBe("picker 0");
	for (let index = 1; index <= 3; index += 1) {
		await act(async () => {
			bump();
		});
		expect(container.textContent).toBe(`picker ${index}`);
	}
	expect(slots.size).toBe(1);
	expect(holderRenders).toBe(1);
	await act(async () => {
		root.unmount();
	});
	container.remove();
});
