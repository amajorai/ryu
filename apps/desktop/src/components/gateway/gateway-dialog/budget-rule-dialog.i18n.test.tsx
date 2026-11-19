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
const { BudgetRuleDialog } = await import("./budget-rule-dialog.tsx");

// Stub catalog: the real translations land with the catalog merge. The DOM
// localizer is off, so only the dialog's own translator can produce this.
const JA: Record<string, string> = {
	"Agent ID is required.": "エージェント ID は必須です。",
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

async function saveEmptyRuleInJapanese(idRequiredError?: string) {
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
				<BudgetRuleDialog
					description="Cap one agent's spend."
					idRequiredError={idRequiredError}
					onSave={() => Promise.resolve()}
					target={{ token: null, url: "http://127.0.0.1:9" }}
					title="Add agent budget"
					trigger={<button type="button">Open budget</button>}
				/>
			</I18nProvider>
		);
	});
	await act(async () => {
		await Bun.sleep(50);
	});
	const opener = [...container.querySelectorAll("button")].find(
		(button) => button.textContent === "Open budget"
	);
	await act(async () => {
		opener?.click();
		await Bun.sleep(50);
	});
	// The footer's last action is Save (its label comes from the shared pack).
	const save = [
		...document.body.querySelectorAll<HTMLButtonElement>(
			'[data-slot="dialog-footer"] button'
		),
	].at(-1);
	await act(async () => {
		save?.click();
		await Bun.sleep(20);
	});
	return document.body.querySelector('[role="alert"]')?.textContent ?? "";
}

test("saving an agent budget with no agent ID alerts in Japanese", async () => {
	expect(await saveEmptyRuleInJapanese()).toBe("エージェント ID は必須です。");
});

test("a caller's own required-ID message still wins over the default", async () => {
	expect(await saveEmptyRuleInJapanese("User ID is required.")).toBe(
		"User ID is required."
	);
});
