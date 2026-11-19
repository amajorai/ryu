import { afterAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// Another file may have left happy-dom registered; only own what we start.
const ownsDom = !GlobalRegistrator.isRegistered;
if (ownsDom) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { I18nProvider } = await import("@ryu/i18n/react");
const { NestedOverflowToolbar } = await import("./nested-overflow-toolbar.tsx");

afterAll(async () => {
	if (ownsDom) {
		await GlobalRegistrator.unregister();
	}
});

// The back button only exists after a category is opened, so a static render
// never shows it: open a category and read the button's accessible name.
test("the back button that appears after opening a category is named in the UI language", async () => {
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	await act(async () => {
		root.render(
			<I18nProvider
				autoLocalizeDom={false}
				initialLocale="de"
				initialPackId={null}
				manageDocument={false}
				overlays={{
					de: { "Back to editor tools": "Zurück zu den Editorwerkzeugen" },
				}}
			>
				<NestedOverflowToolbar
					categories={[
						{
							content: <button type="button">Bold</button>,
							icon: null,
							id: "format",
							label: "Format",
						},
					]}
					defaultOpen
					expandedLayout="nested"
					primary={null}
				/>
			</I18nProvider>
		);
	});
	const category = [...host.querySelectorAll("button")].find((button) =>
		button.textContent?.includes("Format")
	);
	if (!category) {
		throw new Error("Could not find the Format category button.");
	}
	expect(
		host.querySelector('[aria-label="Zurück zu den Editorwerkzeugen"]')
	).toBeNull();
	await act(async () => {
		category.click();
	});
	const back = host.querySelector(
		'[aria-label="Zurück zu den Editorwerkzeugen"]'
	);
	expect(back?.tagName).toBe("BUTTON");
	expect(host.querySelector('[aria-label="Back to editor tools"]')).toBeNull();
	await act(async () => root.unmount());
	host.remove();
});
