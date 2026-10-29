import { afterAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";

const registeredDom = globalThis.document === undefined;
if (registeredDom) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
afterAll(async () => {
	if (registeredDom) {
		await GlobalRegistrator.unregister();
	}
});
const { MessageList } = await import("./message-list.tsx");
const { Suggestions } = await import("./input/suggestions.tsx");

test("transcript class contracts preserve the genuine scroller root and caller override order", async () => {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	try {
		await act(async () =>
			root.render(
				<MessageList
					className="min-h-12 flex-auto"
					classNames={{ messageList: "flex-none min-h-8" }}
					initialScrollBehavior="top"
					messages={[]}
					status="ready"
				/>
			)
		);
		const scroller = container.querySelector('[data-slot="message-scroller"]');
		expect(scroller).not.toBeNull();
		expect(scroller?.classList.contains("flex-auto")).toBe(true);
		expect(scroller?.classList.contains("min-h-12")).toBe(true);
		expect(scroller?.classList.contains("flex-none")).toBe(false);
		expect(scroller?.classList.contains("min-h-8")).toBe(false);
		const viewport = container.querySelector(
			'[data-slot="message-scroller-viewport"]'
		);
		expect(viewport?.classList.contains("flex-auto")).toBe(false);
		await act(async () =>
			root.render(
				<MessageList
					className="min-h-10 flex-initial"
					classNames={{ messageList: "flex-none min-h-8" }}
					initialScrollBehavior="top"
					messages={[]}
					status="ready"
				/>
			)
		);
		expect(container.querySelector('[data-slot="message-scroller"]')).toBe(
			scroller
		);
		expect(scroller?.classList.contains("flex-initial")).toBe(true);
		expect(scroller?.classList.contains("min-h-10")).toBe(true);
		expect(scroller?.classList.contains("flex-auto")).toBe(false);
		await act(async () =>
			root.render(
				<MessageList
					className="min-h-10 flex-initial"
					classNames={{ messageList: "flex-none min-h-8" }}
					initialScrollBehavior="top"
					messages={[]}
					status="submitted"
				/>
			)
		);
		expect(container.querySelector('[data-slot="message-scroller"]')).toBe(
			scroller
		);
		expect(scroller?.classList.contains("flex-initial")).toBe(true);
	} finally {
		await act(async () => root.unmount());
		container.remove();
	}
});

test("suggestion item overrides win and genuine disabled buttons prevent dispatch", async () => {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	const selected: string[] = [];
	const items = [
		{ id: "item", label: "Hello", className: "h-10 px-6 rounded-none" },
	];
	try {
		await act(async () =>
			root.render(
				<Suggestions
					buttonSize="follow-up"
					itemClassName="h-9 px-4"
					items={items}
					onSelect={(item) => selected.push(item.id)}
				/>
			)
		);
		const button = container.querySelector("button");
		expect(button?.classList.contains("h-10")).toBe(true);
		expect(button?.classList.contains("px-6")).toBe(true);
		expect(button?.classList.contains("rounded-none")).toBe(true);
		expect(button?.classList.contains("h-8")).toBe(false);
		await act(async () => button?.click());
		expect(selected).toEqual(["item"]);
		await act(async () =>
			root.render(
				<Suggestions
					buttonSize="follow-up"
					disabled
					itemClassName="h-9 px-4"
					items={items}
					onSelect={(item) => selected.push(item.id)}
				/>
			)
		);
		expect(button?.disabled).toBe(true);
		await act(async () => button?.click());
		expect(selected).toEqual(["item"]);
	} finally {
		await act(async () => root.unmount());
		container.remove();
	}
});
