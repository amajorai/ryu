import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

// The collapsed message rail opens its "Messages" popover toward the inline
// end, so under a right-to-left language it opens leftward over the gutter
// instead of rightward across the transcript.
const ownsDom = typeof document === "undefined";
if (ownsDom) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const { CollapsedMessageRail } = await import("./message-scroller-rail.tsx");
const { DirectionProvider } = await import("../direction.tsx");

let root: Root | undefined;
let container: HTMLElement | undefined;
afterEach(async () => {
	await act(async () => {
		root?.unmount();
	});
	container?.remove();
	root = undefined;
	container = undefined;
});
afterAll(async () => {
	if (ownsDom) {
		await GlobalRegistrator.unregister();
	}
});

async function openedPopoverSide(direction: "ltr" | "rtl") {
	container = document.createElement("div");
	container.setAttribute("dir", direction);
	document.body.append(container);
	root = createRoot(container);
	await act(async () => {
		root?.render(
			<DirectionProvider direction={direction}>
				<CollapsedMessageRail
					activeId="a"
					items={[
						{ id: "a", label: "First" },
						{ id: "b", label: "Second" },
					]}
					onItemSelect={() => undefined}
				/>
			</DirectionProvider>
		);
	});
	const trigger = container.querySelector<HTMLElement>(
		'[data-slot="message-navigation-collapsed-rail"]'
	);
	if (!trigger) {
		throw new Error("Collapsed rail trigger did not render");
	}
	await act(async () => {
		trigger.click();
	});
	const popup = document.querySelector(
		'[data-message-navigation-popover="true"]'
	);
	if (!popup) {
		throw new Error("Messages popover did not open");
	}
	return popup.getAttribute("data-side");
}

describe("collapsed message rail popover", () => {
	test("opens toward the inline end under RTL", async () => {
		expect(await openedPopoverSide("rtl")).toBe("inline-end");
	});

	test("opens toward the inline end under LTR", async () => {
		expect(await openedPopoverSide("ltr")).toBe("inline-end");
	});
});
