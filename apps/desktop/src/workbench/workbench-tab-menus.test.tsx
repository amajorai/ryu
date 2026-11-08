import { afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { WorkbenchItem } from "@ryu/workbench/model";
import { act } from "react";
import type { Root } from "react-dom/client";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register({ url: "http://localhost/" });
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const { createRoot } = await import("react-dom/client");
const { ContextMenu, ContextMenuTrigger } = await import(
	"@ryu/ui/components/context-menu.tsx"
);
const { DirectionProvider } = await import("@ryu/ui/components/direction.tsx");
const { WorkbenchTabMenu } = await import("./workbench-tab-menus.tsx");

function tab(id: string): WorkbenchItem {
	// SAFETY: the tab menu reads only `id` and `closable` from an item.
	return { closable: true, id } as unknown as WorkbenchItem;
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(async () => {
	await act(async () => {
		root?.unmount();
	});
	container?.remove();
	root = null;
	container = null;
	document.body.innerHTML = "";
});

async function openMenu(dir: "ltr" | "rtl", closed: string[]) {
	const items = [tab("a"), tab("b"), tab("c")];
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	await act(async () => {
		root?.render(
			<DirectionProvider direction={dir}>
				<ContextMenu defaultOpen>
					<ContextMenuTrigger>tab a</ContextMenuTrigger>
					<WorkbenchTabMenu
						canSplit={() => false}
						closeItem={(item) => closed.push(item.id)}
						item={items[0] as WorkbenchItem}
						moveRegions={[]}
						moveToRegion={() => undefined}
						others={items.slice(1)}
						splitItem={() => undefined}
						toTheRight={items.slice(1)}
					/>
				</ContextMenu>
			</DirectionProvider>
		);
	});
}

function menuItem(label: string): HTMLElement | undefined {
	return [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
		(element) => element.textContent?.trim() === label
	);
}

for (const dir of ["ltr", "rtl"] as const) {
	test(`${dir}: the later-tabs action names no physical side and closes the later tabs`, async () => {
		const closed: string[] = [];
		await openMenu(dir, closed);
		expect(document.body.textContent).not.toContain("Close to the Right");
		const action = menuItem("Close Tabs After This One");
		expect(action).toBeDefined();
		await act(async () => {
			action?.click();
		});
		expect(closed).toEqual(["b", "c"]);
	});
}
