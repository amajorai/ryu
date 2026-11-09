import { afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (globalThis.document === undefined) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { I18nProvider } = await import("@ryu/i18n/react");
const { registerLiteralCatalogLoader } = await import("@ryu/i18n/core");
const { TeamDialog } = await import("./TeamDialog.tsx");

// The coordination picker's options come from the shared core-client table;
// the dialog translates each label and description where it renders them.
const JA: Record<string, string> = {
	Broadcast: "一斉送信",
	"Every member answers independently, side by side.":
		"各メンバーが個別に並んで回答します。",
};

afterEach(() => {
	registerLiteralCatalogLoader(null);
	document.body.removeAttribute("data-ryu-i18n");
	document.body.replaceChildren();
});

test("the coordination strategy and its description render in Japanese", async () => {
	registerLiteralCatalogLoader((locale) => (locale.startsWith("ja") ? JA : {}));
	// The dialog portals into <body>; switching the DOM localizer off there
	// leaves only the dialog's own translation to check.
	document.body.setAttribute("data-ryu-i18n", "off");
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	const render = (open: boolean) =>
		root.render(
			<I18nProvider initialLocale="ja" initialPackId={null}>
				<TeamDialog
					agents={[]}
					onClose={() => undefined}
					onSubmit={async () => undefined}
					open={open}
					team={null}
				/>
			</I18nProvider>
		);
	await act(async () => render(false));
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 50));
	});
	await act(async () => render(true));
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 20));
	});

	const text = document.body.textContent ?? "";
	expect(text).toContain("一斉送信");
	expect(text).toContain("各メンバーが個別に並んで回答します。");
	expect(text).not.toContain("Broadcast");
	expect(text).not.toContain("Every member answers independently");
	await act(async () => root.unmount());
});
