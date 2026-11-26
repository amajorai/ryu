import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// The chips above the Ask Ryu composer are the only place a person sees what
// an open app adds to the next turn. An app the host named always gets one
// chip with that name, whatever audience its items claim, and the chip's
// button takes the whole entry out.
const ownsDom = typeof document === "undefined";
if (ownsDom) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { parseModelContext, useModelContextStore } = await import(
	"@ryu/app-host/model-context"
);
const { ModelContextAttachments } = await import(
	"./model-context-attachments.tsx"
);

const OWNER = "plugin:com.example.evil:page:n1";
const HIDDEN_ITEM = {
	type: "text",
	text: "x",
	annotations: { audience: ["assistant"] },
};

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

function renderChips(scope: string) {
	act(() => {
		root.render(<ModelContextAttachments scope={scope} />);
	});
}

function ownerChips(): Element[] {
	return [...container.querySelectorAll('[data-testid="model-context-owner"]')];
}

beforeEach(() => {
	useModelContextStore.setState({ entries: {}, held: {} });
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});

afterEach(() => {
	act(() => {
		root.unmount();
	});
	container.remove();
});

afterAll(async () => {
	if (ownsDom) {
		await GlobalRegistrator.unregister();
	}
});

test("an entry whose only item is for the assistant alone still shows a chip that names the app", () => {
	useModelContextStore
		.getState()
		.update("assistant", OWNER, parseModelContext({ content: [HIDDEN_ITEM] }), {
			label: "Evil App",
		});
	renderChips("assistant");
	const chips = ownerChips();
	expect(chips).toHaveLength(1);
	expect(chips[0]?.textContent).toContain("Context from Evil App");
	expect(chips[0]?.querySelector("button")?.getAttribute("aria-label")).toBe(
		"Remove Context from Evil App"
	);
});

test("the chip's button takes the app's whole entry out of the next turn", () => {
	useModelContextStore.getState().update(
		"assistant",
		OWNER,
		parseModelContext({
			content: [HIDDEN_ITEM, { type: "text", text: "shown" }],
			structuredContent: { secret: true },
		}),
		{ label: "Evil App" }
	);
	renderChips("assistant");
	const button = ownerChips()[0]?.querySelector("button");
	expect(button).toBeTruthy();
	act(() => {
		button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
	});
	expect(useModelContextStore.getState().get("assistant", OWNER)).toBeNull();
	expect(
		container.querySelector('[data-testid="model-context-attachments"]')
	).toBeNull();
});

test("a title an item claims does not replace the host's name for the app", () => {
	useModelContextStore.getState().update(
		"assistant",
		OWNER,
		parseModelContext({
			content: [{ type: "text", text: "y", _meta: { "openai/title": "Ryu" } }],
		}),
		{ label: "Evil App" }
	);
	renderChips("assistant");
	const chips = ownerChips();
	expect(chips).toHaveLength(1);
	expect(chips[0]?.textContent).toContain("Context from Evil App");
	expect(chips[0]?.textContent).not.toContain("Ryu");
});

test("an entry held back for a tab that is not in front shows no chip", () => {
	useModelContextStore
		.getState()
		.update(
			"assistant",
			OWNER,
			parseModelContext({ content: [{ type: "text", text: "shown" }] }),
			{ held: true, label: "Evil App" }
		);
	renderChips("assistant");
	expect(container.innerHTML).toBe("");
});

test("an entry the host did not name keeps its item chips and gets no app chip", () => {
	useModelContextStore
		.getState()
		.update(
			"conv-1",
			"widget:1",
			parseModelContext({ content: [{ type: "text", text: "from a widget" }] })
		);
	renderChips("conv-1");
	expect(ownerChips()).toEqual([]);
	expect(container.textContent).toContain("from a widget");
});
