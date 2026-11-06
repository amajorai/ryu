import { afterEach, expect, test } from "bun:test";
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
const { AppPermissionsEditor } = await import("./AppPermissionsEditor.tsx");

// Settings > App permissions names each grant in the reader's language, both in
// the row and inside the Revoke/Grant switch's accessible name. The DOM
// localizer is off, so the shared grant registry itself must translate; before
// it did, `tool:execute` read "Tool execute" in every language.
const JA: Record<string, string> = {
	"Run its own code": "独自のコードを実行",
	"Connect to {host}": "{host} に接続",
	'Revoke "{grantName}" for {appName}': "{appName} の「{grantName}」を取り消す",
	'Grant "{grantName}" for {appName}': "{appName} に「{grantName}」を許可",
};

const roots: Root[] = [];

afterEach(async () => {
	await act(async () => {
		for (const root of roots.splice(0)) {
			root.unmount();
		}
	});
	document.body.replaceChildren();
	registerLiteralCatalogLoader(null);
});

test("grant rows and switch names use the translated grant copy", async () => {
	registerLiteralCatalogLoader((locale) => (locale.startsWith("ja") ? JA : {}));
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	roots.push(root);
	await act(async () => {
		root.render(
			<I18nProvider
				autoLocalizeDom={false}
				initialLocale="ja"
				initialPackId={null}
			>
				<AppPermissionsEditor
					app={{
						approvedGrants: ["tool:execute"],
						enabled: true,
						id: "com.example.search",
						name: "Search",
						permissionGrants: ["tool:execute", "tool:http-egress:api.exa.ai"],
					}}
					onGrantsChanged={() => undefined}
					target={{ kind: "local" } as never}
				/>
			</I18nProvider>
		);
	});
	await act(async () => {
		await Bun.sleep(50);
	});
	const text = container.textContent ?? "";
	expect(text).toContain("独自のコードを実行");
	expect(text).toContain("api.exa.ai に接続");
	expect(text).not.toContain("Tool execute");
	const names = [...container.querySelectorAll("[aria-label]")].map(
		(node) => node.getAttribute("aria-label") ?? ""
	);
	expect(names).toContain("Search の「独自のコードを実行」を取り消す");
	expect(names).toContain("Search に「api.exa.ai に接続」を許可");
});
