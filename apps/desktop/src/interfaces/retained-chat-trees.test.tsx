import { afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, useEffect } from "react";
import type { Root } from "react-dom/client";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const { createRoot } = await import("react-dom/client");
const { RetainedChatTrees, RetainedThreadSlot } = await import(
	"./retained-chat-trees.tsx"
);

import type { Tab } from "@/src/contexts/TabsContext.tsx";

const roots: Root[] = [];
const events: string[] = [];

function tab(id: string): Tab {
	return { id, path: "/chat", title: id } as Tab;
}

function Page({ tab: current }: { tab: Tab }) {
	useEffect(() => {
		events.push(`mount:${current.id}`);
		return () => {
			events.push(`unmount:${current.id}`);
		};
	}, [current.id]);
	return <p data-testid={`page-${current.id}`}>{current.id}</p>;
}

function Harness({ shown, tabs }: { shown: string | null; tabs: Tab[] }) {
	return (
		<RetainedChatTrees
			renderTab={(open) => <Page tab={open} />}
			shownTabId={shown}
			tabs={tabs}
		>
			<section data-testid="slot-parent">
				{shown ? <RetainedThreadSlot tabId={shown} /> : null}
			</section>
		</RetainedChatTrees>
	);
}

function mount(node: React.ReactNode): (next: React.ReactNode) => void {
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	roots.push(root);
	act(() => root.render(node));
	return (next) => act(() => root.render(next));
}

afterEach(() => {
	for (const root of roots.splice(0)) {
		act(() => root.unmount());
	}
	document.body.replaceChildren();
	events.length = 0;
});

test("switching threads keeps the other chat tab mounted and moves the shown one into the slot", () => {
	const both = [tab("a"), tab("b")];
	const render = mount(<Harness shown="a" tabs={both} />);
	const slot = () => document.querySelector('[data-testid="slot-parent"]');
	expect(slot()?.querySelector('[data-testid="page-a"]')).not.toBeNull();
	expect(slot()?.querySelector('[data-testid="page-b"]')).toBeNull();
	// The other tab is mounted, parked in the hidden container.
	expect(
		document
			.querySelector('[data-testid="ryu-interface-retained-chats"]')
			?.querySelector('[data-testid="page-b"]')
	).not.toBeNull();

	render(<Harness shown="b" tabs={both} />);
	expect(slot()?.querySelector('[data-testid="page-b"]')).not.toBeNull();
	expect(slot()?.querySelector('[data-testid="page-a"]')).toBeNull();
	expect(
		document
			.querySelector('[data-testid="ryu-interface-retained-chats"]')
			?.querySelector('[data-testid="page-a"]')
	).not.toBeNull();
	// Neither page was unmounted or remounted by the switch.
	expect(events).toEqual(["mount:a", "mount:b"]);
});

test("a closed or unloaded tab unmounts and an overview parks every tab", () => {
	const render = mount(<Harness shown="a" tabs={[tab("a"), tab("b")]} />);
	render(<Harness shown={null} tabs={[tab("a"), tab("b")]} />);
	expect(
		document
			.querySelector('[data-testid="slot-parent"]')
			?.querySelector("[data-testid^='page-']")
	).toBeNull();
	expect(events).toEqual(["mount:a", "mount:b"]);
	render(<Harness shown={null} tabs={[tab("b")]} />);
	expect(events).toEqual(["mount:a", "mount:b", "unmount:a"]);
	expect(document.querySelector('[data-testid="page-a"]')).toBeNull();
});
