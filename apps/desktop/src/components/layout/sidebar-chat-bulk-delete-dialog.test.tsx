import { afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
Reflect.set(Element.prototype, "getAnimations", () => []);

// Imported after happy-dom so the dialog primitives see a document.
const { SidebarChatBulkDeleteDialog, useSidebarChatSelection } = await import(
	"./sidebar-chat-selection.tsx"
);

const roots: Root[] = [];

async function mountSidebarDialog(): Promise<Root> {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	roots.push(root);
	await act(async () => {
		root.render(<SidebarChatBulkDeleteDialog onDelete={() => undefined} />);
	});
	return root;
}

async function requestDelete(ids: string[]) {
	await act(async () => {
		useSidebarChatSelection.setState({ pendingDeleteIds: ids });
	});
}

function confirmations(): Element[] {
	return [...document.querySelectorAll('[role="alertdialog"]')];
}

afterEach(async () => {
	await act(async () => {
		useSidebarChatSelection.setState({ pendingDeleteIds: null });
		for (const root of roots.splice(0)) {
			root.unmount();
		}
	});
	document.body.innerHTML = "";
});

test("two mounted sidebars open one bulk-delete confirmation", async () => {
	await mountSidebarDialog();
	await mountSidebarDialog();

	await requestDelete(["a", "b"]);
	expect(confirmations()).toHaveLength(1);
	expect(confirmations()[0]?.textContent).toContain("Delete 2 chats?");
});

test("the remaining sidebar takes over when the hosting one unmounts", async () => {
	const first = await mountSidebarDialog();
	await mountSidebarDialog();
	await act(async () => {
		first.unmount();
	});

	await requestDelete(["a"]);
	expect(confirmations()).toHaveLength(1);
});
