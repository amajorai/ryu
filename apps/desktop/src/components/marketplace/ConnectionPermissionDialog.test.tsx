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
const { ConnectionPermissionDialog } = await import(
	"./ConnectionPermissionDialog.tsx"
);

const JA: Record<string, string> = {
	"Review access before connecting this integration":
		"この連携を接続する前にアクセス権を確認",
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

test("an unnamed connection is reviewed with a whole translated title", async () => {
	registerLiteralCatalogLoader((tag) => (tag.startsWith("ja") ? JA : {}));
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
				<ConnectionPermissionDialog
					connectionName={null}
					connectionType="Composio"
					onConfirm={async () => undefined}
					onOpenChange={() => undefined}
					open
				/>
			</I18nProvider>
		);
	});
	await act(async () => {
		await Promise.resolve();
	});
	expect(document.body.textContent).toContain(
		"この連携を接続する前にアクセス権を確認"
	);
	expect(document.body.textContent).not.toContain("this integration");
});
