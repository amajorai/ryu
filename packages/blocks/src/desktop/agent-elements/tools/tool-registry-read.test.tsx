import { afterAll, afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
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
const { toolRegistry } = await import("./tool-registry.ts");

const done = { state: "output-available", type: "tool-Read" };
const title = () => toolRegistry["tool-Read"]?.title(done as never);

let root: Root | null = null;
afterEach(async () => {
	await act(async () => root?.unmount());
	root = null;
	document.body.innerHTML = "";
});

test("a finished Read tool row is titled with the done sense, not the verb", async () => {
	expect(title()).toBe("Read");
	const mount = document.createElement("div");
	document.body.append(mount);
	root = createRoot(mount);
	await act(async () => {
		root?.render(
			<I18nProvider
				autoLocalizeDom={false}
				initialLocale="ja"
				initialPackId="official/ja"
			>
				<span />
			</I18nProvider>
		);
	});
	// The bare word is the imperative (読む); the finished row says it is done.
	expect(title()).toBe("読み込み完了");
});
