// The API-reference tab under a Japanese UI: hook phases, composer control
// types and view targets read as whole translated phrases, and a token this
// build has no name for appears verbatim in a code chip beside a translated
// generic label instead of inside a translated sentence.

import { afterAll, afterEach, describe, expect, test } from "bun:test";
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
const { registerLiteralCatalogLoader } = await import("@ryu/i18n/core");
const { ApiReferencePanel } = await import("./api-reference-panel.tsx");

const JA: Record<string, string> = {
	"Composer control": "コンポーザーのコントロール",
	"Composer switch": "コンポーザーのスイッチ",
	"Runs after every assistant reply": "アシスタントが返信するたびに実行",
	"Runs on a hook event": "フックイベントで実行",
	"Sidebar view": "サイドバービュー",
};

const roots: Root[] = [];

afterEach(async () => {
	for (const root of roots.splice(0)) {
		await act(async () => {
			root.unmount();
		});
	}
	registerLiteralCatalogLoader(null);
	document.body.innerHTML = "";
});

async function mount(): Promise<HTMLDivElement> {
	registerLiteralCatalogLoader(() => JA);
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	roots.push(root);
	await act(async () => {
		root.render(
			<I18nProvider
				autoLocalizeDom={false}
				initialLocale="ja"
				initialPackId={null}
			>
				<ApiReferencePanel
					surface={{
						composerControls: [
							{ id: "mode", label: "Mode", type: "toggle" },
							{ id: "dial", label: "Dial", type: "slider" },
						],
						triggers: {
							turnHooks: [
								{ event: "post_assistant_turn", id: "a" },
								{ event: "before_turn", id: "b" },
							],
						},
						views: [{ id: "board", surface: "sidebar", title: "Board" }],
					}}
				/>
			</I18nProvider>
		);
	});
	return host;
}

describe("ApiReferencePanel under ja", () => {
	test("known tokens read as whole translated phrases", async () => {
		const text = (await mount()).textContent ?? "";
		expect(text).toContain("アシスタントが返信するたびに実行");
		expect(text).toContain("コンポーザーのスイッチ");
		expect(text).toContain("サイドバービュー");
		expect(text).not.toContain("post assistant turn");
		expect(text).not.toContain("toggle");
	});

	test("unknown tokens sit in a code chip beside a translated label", async () => {
		const host = await mount();
		const chips = [...host.querySelectorAll("code")].map(
			(code) => code.textContent
		);
		expect(chips).toEqual(["before_turn", "slider"]);
		expect(host.textContent).toContain("フックイベントで実行");
		expect(host.textContent).toContain("コンポーザーのコントロール");
	});
});
