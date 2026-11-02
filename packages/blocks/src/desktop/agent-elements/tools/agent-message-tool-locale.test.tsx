import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

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

const { I18nProvider } = await import("@ryu/i18n/react");
const { registerLiteralCatalogLoader } = await import("@ryu/i18n/core");
const { AgentMessageTool } = await import("./agent-message-tool.tsx");

const ASKED = "<from>{sender}</from> asked <to>{recipient}</to>";

const part = {
	input: { question: "Ready?", to: "bo" },
	output: { from: "ada", reply: "Yes" },
	state: "output-available",
	toolName: "agents.ask",
	type: "tool-agents.ask",
};

const context = {
	resolve: (id: string) => ({ id, name: id === "ada" ? "Ada" : "Bo" }),
};

const roots: Root[] = [];

async function render(node: ReactNode): Promise<HTMLElement> {
	const mount = document.createElement("div");
	document.body.append(mount);
	const root = createRoot(mount);
	roots.push(root);
	await act(async () => {
		root.render(node);
	});
	return mount;
}

function activity(mount: HTMLElement): HTMLElement {
	const node = mount.querySelector<HTMLElement>(
		"[data-testid='agent-message-activity']"
	);
	if (!node) {
		throw new Error("agent message activity did not render");
	}
	return node;
}

afterEach(async () => {
	// Unmounting the provider unregisters its runtime, so the "ja" locale does
	// not leak into the next test file in this process.
	for (const root of roots.splice(0)) {
		await act(async () => {
			root.unmount();
		});
	}
	registerLiteralCatalogLoader(null);
	document.body.innerHTML = "";
});

describe("agent message activity sentence", () => {
	test("keeps the English sentence and accessible name", async () => {
		const mount = await render(
			<AgentMessageTool context={context} part={part} />
		);
		expect(activity(mount).getAttribute("aria-label")).toBe("Ada asked Bo");
		const marker = activity(mount).firstElementChild?.textContent ?? "";
		expect(marker).toContain("asked");
		expect(marker.indexOf("Ada")).toBeLessThan(marker.indexOf("Bo"));
	});

	test("lets a locale reorder the two agents around its verb", async () => {
		registerLiteralCatalogLoader(() => ({
			[ASKED]: "<from>{sender}</from> が <to>{recipient}</to> に質問しました",
		}));
		const mount = await render(
			<I18nProvider
				autoLocalizeDom={false}
				initialLocale="ja"
				initialPackId={null}
			>
				<AgentMessageTool context={context} part={part} />
			</I18nProvider>
		);
		expect(activity(mount).getAttribute("aria-label")).toBe(
			"Ada が Bo に質問しました"
		);
		const marker = activity(mount).firstElementChild?.textContent ?? "";
		expect(marker).toContain("に質問しました");
		expect(marker).not.toContain("asked");
	});
});
