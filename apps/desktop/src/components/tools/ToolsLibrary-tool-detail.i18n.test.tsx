import { afterEach, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { Root } from "react-dom/client";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { I18nProvider } = await import("@ryu/i18n/react");
const { registerLiteralCatalogLoader } = await import("@ryu/i18n/core");
const { ToolDetail } = await import("./ToolsLibrary-tool-detail.tsx");

// The test-call result renders in a `<pre>` the DOM localizer skips, so the
// fallback for a failure without an error message is translated in place.
const JA: Record<string, string> = {
	"Tool call failed": "ツールの呼び出しに失敗しました",
};

const TOOL = {
	description: "Reads a file",
	id: "fs.read",
	name: "read",
	server: "fs",
} as never;

const roots: Root[] = [];

beforeEach(() => {
	registerLiteralCatalogLoader((locale) => (locale.startsWith("ja") ? JA : {}));
});

afterEach(async () => {
	await act(async () => {
		for (const root of roots.splice(0)) {
			root.unmount();
		}
	});
	document.body.replaceChildren();
	registerLiteralCatalogLoader(null);
});

test("shows the translated fallback when a failed call has no error", async () => {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	roots.push(root);
	const onCallTool = (() =>
		Promise.resolve({ error: undefined, ok: false })) as never;
	await act(async () => {
		root.render(
			<I18nProvider
				autoLocalizeDom={false}
				initialLocale="ja"
				initialPackId={null}
			>
				<ToolDetail
					agents={[{ id: "agent_1", name: "Helper" }]}
					onCallTool={onCallTool}
					tool={TOOL}
				/>
			</I18nProvider>
		);
	});
	await act(async () => {
		await Bun.sleep(50);
	});
	const button = [...container.querySelectorAll("button")].find((candidate) =>
		candidate.textContent?.includes("Test call")
	);
	expect(button).toBeDefined();
	await act(async () => {
		button?.click();
		await Bun.sleep(20);
	});
	expect(container.querySelector("pre")?.textContent).toBe(
		"ツールの呼び出しに失敗しました"
	);
});
