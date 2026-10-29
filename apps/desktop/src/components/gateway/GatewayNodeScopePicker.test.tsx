import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ReactNode } from "react";
import type { Root } from "react-dom/client";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

// Flatten the menu so items are plain buttons in the DOM.
function Pass({ children }: { children?: ReactNode }) {
	return <div>{children}</div>;
}
mock.module("@ryu/ui/components/dropdown-menu.tsx", () => ({
	DropdownMenu: Pass,
	DropdownMenuContent: Pass,
	DropdownMenuLabel: Pass,
	DropdownMenuSeparator: () => null,
	DropdownMenuTrigger: ({
		children,
		"aria-label": label,
	}: {
		"aria-label"?: string;
		children?: ReactNode;
	}) => (
		<button aria-label={label} data-testid="trigger" type="button">
			{children}
		</button>
	),
	DropdownMenuItem: ({
		children,
		onClick,
	}: {
		children?: ReactNode;
		onClick?: () => void;
	}) => (
		<button data-testid="item" onClick={onClick} type="button">
			{children}
		</button>
	),
}));

const { createRoot } = await import("react-dom/client");
const { NodeScopeProvider } = await import(
	"@/src/contexts/NodeScopeContext.tsx"
);
const { useNodeStore } = await import("@/src/store/useNodeStore.ts");
const { GatewayNodeScopePicker } = await import("./GatewayNodeScopePicker.tsx");

const initialStore = useNodeStore.getState();
const setDefault = mock(async (_name: string) => undefined);
const setAutoSelect = mock((_on: boolean) => undefined);
const onScopeChange = mock((_name: string) => undefined);

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
	setDefault.mockClear();
	setAutoSelect.mockClear();
	onScopeChange.mockClear();
	useNodeStore.setState({
		nodes: [
			{ name: "studio", url: "https://studio.example", token: "s" },
			{ name: "laptop", url: "https://laptop.example", token: "l" },
		],
		defaultNode: "studio",
		autoSelect: true,
		autoSelectedNode: null,
		tabOverrides: {},
		setDefault,
		setAutoSelect,
	});
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});

afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	useNodeStore.setState(initialStore, true);
});

async function renderScoped(scope: string | undefined) {
	await act(async () => {
		root.render(
			<NodeScopeProvider nodeName={scope}>
				<GatewayNodeScopePicker onScopeChange={onScopeChange} scope={scope} />
			</NodeScopeProvider>
		);
	});
}

function items(): HTMLButtonElement[] {
	return [
		...container.querySelectorAll<HTMLButtonElement>('[data-testid="item"]'),
	];
}

function item(label: string): HTMLButtonElement {
	const found = items().find((el) => el.textContent?.includes(label));
	if (!found) {
		throw new Error(`No menu item "${label}"`);
	}
	return found;
}

test("the label shows the scoped computer, not the chat computer", async () => {
	await renderScoped("laptop");
	const trigger = container.querySelector('[data-testid="trigger"]');
	expect(trigger?.getAttribute("aria-label")).toContain("Laptop");
	expect(container.textContent).toContain("Changes here apply only to Laptop");
	expect(container.textContent).toContain("Chats keep using Studio");
});

test("selecting a computer only changes the dialog scope", async () => {
	await renderScoped(undefined);
	await act(async () => {
		item("Laptop").click();
	});
	expect(onScopeChange).toHaveBeenCalledWith("laptop");
	expect(setDefault).not.toHaveBeenCalled();
	expect(setAutoSelect).not.toHaveBeenCalled();
	// Re-selecting the computer already shown is a no-op.
	await act(async () => {
		item("Studio").click();
	});
	expect(onScopeChange).toHaveBeenCalledTimes(1);
});

test('"Use for chats too" switches the app-wide computer explicitly', async () => {
	await renderScoped(undefined);
	expect(items().some((el) => el.textContent === "Use for chats too")).toBe(
		false
	);
	await renderScoped("laptop");
	await act(async () => {
		item("Use for chats too").click();
	});
	expect(setAutoSelect).toHaveBeenCalledWith(false);
	expect(setDefault).toHaveBeenCalledWith("laptop");
	expect(onScopeChange).not.toHaveBeenCalled();
});
