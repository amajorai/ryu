// DOM tests for the morph's kept content and launcher intent. They register
// happy-dom before importing React DOM, like page-context.interaction.test.tsx.
import { afterAll, afterEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const registeredHere = !GlobalRegistrator.isRegistered;
if (registeredHere) {
	GlobalRegistrator.register({ url: "https://docs.example/" });
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const { RyuAssistantMorph } = await import("./morph.tsx");

let root: Root | null = null;

afterEach(() => {
	act(() => root?.unmount());
	root = null;
	document.body.innerHTML = "";
});

afterAll(async () => {
	if (registeredHere) {
		await GlobalRegistrator.unregister();
	}
});

function mount(): HTMLDivElement {
	const container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	return container;
}

test("keepContentMounted keeps closed content inert and hidden from assistive tech", () => {
	const container = mount();
	const render = (isOpen: boolean) =>
		act(() =>
			root?.render(
				<RyuAssistantMorph
					contentHeight={620}
					isOpen={isOpen}
					keepContentMounted
					triggerLabel="Ask"
				>
					<p>kept</p>
				</RyuAssistantMorph>
			)
		);

	render(true);
	const dialog = container.querySelector('[role="dialog"]');
	expect(dialog?.hasAttribute("inert")).toBe(false);

	render(false);
	const closed = container.querySelector('[role="dialog"]');
	expect(closed?.textContent).toBe("kept");
	expect(closed?.hasAttribute("inert")).toBe(true);
	expect(closed?.getAttribute("aria-hidden")).toBe("true");
});

test("onTriggerIntent fires when the trigger takes focus", () => {
	const container = mount();
	const onTriggerIntent = mock(() => undefined);
	act(() =>
		root?.render(
			<RyuAssistantMorph
				contentHeight={620}
				onTriggerIntent={onTriggerIntent}
				triggerLabel="Ask"
			>
				<p>content</p>
			</RyuAssistantMorph>
		)
	);

	const trigger = container.querySelector<HTMLButtonElement>(
		'button[aria-label="Ask"]'
	);
	act(() => trigger?.focus());
	expect(onTriggerIntent).toHaveBeenCalledTimes(1);
});
