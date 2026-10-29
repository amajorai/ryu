// Bot-mode chat sections: nesting a section into a collapsed parent (by drag
// or "Move section to") expands that parent so the moved section stays visible.
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, useState } from "react";
import type { Root } from "react-dom/client";
import type {
	BotChatSectionState,
	nestBotChatSection as NestBotChatSection,
} from "@/src/lib/bot-chat-sections.ts";

const nativeFetch = globalThis.fetch;
const NativeAbortController = globalThis.AbortController;
if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
globalThis.fetch = nativeFetch;
globalThis.AbortController = NativeAbortController;
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
mock.module("@/src/contexts/entitlement-context.tsx", () => ({
	useEntitlementContext: () => ({
		requestUpgrade: () => undefined,
		verdict: null,
	}),
}));

const { createRoot } = await import("react-dom/client");
const { TabsProvider } = await import("@/src/contexts/TabsContext.tsx");
const { nestBotChatSection } = (await import(
	"@/src/lib/bot-chat-sections.ts"
)) as { nestBotChatSection: typeof NestBotChatSection };
const { BotModeChatSectionsBody } = await import("./AppSidebar.tsx");

type Handlers = Parameters<typeof BotModeChatSectionsBody>[0]["handlers"];

const initialState: BotChatSectionState = {
	assignments: {},
	sections: [
		{ id: "A", name: "Alpha" },
		{ id: "B", name: "Beta" },
	],
};

function Harness() {
	const [state, setState] = useState(initialState);
	return (
		<BotModeChatSectionsBody
			handlers={{} as Handlers}
			loose={[]}
			onAssignMany={() => undefined}
			onDelete={() => undefined}
			onNest={(sectionId, parentId) =>
				setState((prev) => nestBotChatSection(prev, sectionId, parentId))
			}
			onOpenRename={() => undefined}
			sectionState={state}
			sections={state.sections}
		/>
	);
}

let root: Root | undefined;
let client: QueryClient;

async function mount() {
	root = createRoot(document.body.appendChild(document.createElement("div")));
	await act(async () =>
		root?.render(
			<QueryClientProvider client={client}>
				<TabsProvider>
					<Harness />
				</TabsProvider>
			</QueryClientProvider>
		)
	);
}

async function until(check: () => boolean) {
	for (let i = 0; i < 250; i++) {
		if (check()) {
			return;
		}
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 8));
		});
	}
	if (!check()) {
		throw new Error("Timed out waiting for the condition");
	}
}

const query = (selector: string) => document.querySelector(selector);
const sectionHeader = (id: string) =>
	query(`[data-testid="bot-chat-section-${id}"] button[draggable="true"]`);

async function collapseA() {
	const header = sectionHeader("A");
	if (!(header instanceof HTMLElement)) {
		throw new Error("section A header missing");
	}
	await act(async () => header.click());
}

// A collapsed, empty section hides its "Drop a project…" placeholder.
const sectionAText = () =>
	query('[data-testid="bot-chat-section-A"]')?.textContent ?? "";

function dragEvent(type: string, clientY = 0) {
	const event = new Event(type, { bubbles: true, cancelable: true });
	const store = new Map<string, string>();
	Object.defineProperties(event, {
		clientY: { value: clientY },
		dataTransfer: {
			value: {
				dropEffect: "none",
				effectAllowed: "all",
				getData: (format: string) => store.get(format) ?? "",
				setData: (format: string, value: string) => store.set(format, value),
				types: [],
			},
		},
	});
	return event;
}

const sectionBInsideA = () =>
	query(
		'[data-testid="bot-chat-section-children-A"] [data-testid="bot-chat-section-B"]'
	);

beforeEach(() => {
	localStorage.clear();
	client = new QueryClient();
});

afterEach(async () => {
	await act(async () => root?.unmount());
	root = undefined;
	document.body.innerHTML = "";
	client.clear();
	localStorage.clear();
});

test("dropping a section on a collapsed section's header expands it", async () => {
	await mount();
	await collapseA();
	expect(sectionAText()).not.toContain("Drop a project");
	const dragged = sectionHeader("B");
	const target = sectionHeader("A");
	const targetRow = target?.parentElement;
	if (!(dragged && target && targetRow)) {
		throw new Error("section headers missing");
	}
	// Give A's header a box so the pointer lands in its "drop inside" band.
	targetRow.getBoundingClientRect = () =>
		({ bottom: 32, height: 32, top: 0 }) as DOMRect;
	await act(async () => {
		dragged.dispatchEvent(dragEvent("dragstart"));
	});
	await act(async () => {
		target.dispatchEvent(dragEvent("dragover", 16));
	});
	await act(async () => {
		target.dispatchEvent(dragEvent("drop", 16));
	});
	expect(sectionBInsideA()).not.toBeNull();
});

test("moving a section into a collapsed section via the menu expands it", async () => {
	await mount();
	await collapseA();
	expect(sectionAText()).not.toContain("Drop a project");
	const trigger = query('[aria-label="Beta options"]');
	if (!(trigger instanceof HTMLElement)) {
		throw new Error("Beta options trigger missing");
	}
	await act(async () => {
		trigger.dispatchEvent(
			new PointerEvent("pointerdown", { bubbles: true, button: 0 })
		);
		trigger.click();
	});
	await until(() =>
		[...document.querySelectorAll('[role="menuitem"]')].some((item) =>
			item.textContent?.includes("Move section to")
		)
	);
	const moveTo = [...document.querySelectorAll('[role="menuitem"]')].find(
		(item) => item.textContent?.includes("Move section to")
	);
	await act(async () => {
		moveTo?.dispatchEvent(
			new PointerEvent("pointermove", { bubbles: true, pointerType: "mouse" })
		);
		moveTo?.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
		if (moveTo instanceof HTMLElement) {
			moveTo.click();
		}
		moveTo?.dispatchEvent(
			new KeyboardEvent("keydown", { bubbles: true, key: "ArrowRight" })
		);
	});
	await until(() =>
		[...document.querySelectorAll('[role="menuitem"]')].some(
			(item) => item.textContent === "Alpha"
		)
	);
	const alpha = [...document.querySelectorAll('[role="menuitem"]')].find(
		(item) => item.textContent === "Alpha"
	);
	await act(async () => {
		if (alpha instanceof HTMLElement) {
			alpha.click();
		}
	});
	await until(
		() => query('[data-testid="bot-chat-section-children-A"]') !== null
	);
	expect(sectionBInsideA()).not.toBeNull();
});
