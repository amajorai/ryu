import { afterAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { SlideCommit } = await import("./slide-commit.tsx");

afterAll(async () => {
	await GlobalRegistrator.unregister();
});

const pressRight = async (slider: HTMLElement, times: number) => {
	for (let step = 0; step < times; step += 1) {
		await act(async () => {
			slider.dispatchEvent(
				new KeyboardEvent("keydown", { bubbles: true, key: "ArrowRight" })
			);
		});
	}
};

test("a keyboard retry right after a failed confirm commits again", async () => {
	let calls = 0;
	const onConfirm = () => {
		calls += 1;
		return calls === 1
			? Promise.reject(new Error("first attempt fails"))
			: Promise.resolve();
	};
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	await act(async () => {
		root.render(
			<SlideCommit
				keyboardSteps={5}
				label="Delete chat"
				onConfirm={onConfirm}
				onError={() => undefined}
			/>
		);
	});
	const slider = host.querySelector<HTMLElement>('[role="slider"]');
	expect(slider).not.toBeNull();
	if (!slider) {
		return;
	}

	await pressRight(slider, 5);
	// Let the rejected confirm settle into the error phase (the minimum pending
	// time runs first), without waiting for the handle's delayed trip home.
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 900));
	});
	expect(calls).toBe(1);

	// Retrying at once, while the handle is still parked or springing home,
	// starts from home and commits after the same five steps.
	await pressRight(slider, 4);
	expect(calls).toBe(1);
	await pressRight(slider, 1);
	expect(calls).toBe(2);

	await act(async () => {
		root.unmount();
	});
	host.remove();
});
