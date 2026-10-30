import { afterEach, expect, test } from "bun:test";
import { act } from "react";

import { registerTestDom } from "./test-dom-env.ts";

await registerTestDom();
const { loadReactDomClient } = await import("./test-dom-env.ts");
const { createRoot } = await loadReactDomClient();
const { I18nProvider, useLocalizedString } = await import("./react.tsx");
const { registerLiteralCatalogLoader } = await import("./literal-catalog.ts");

function Probe({ value }: { value: string }) {
	return <output title={useLocalizedString(value)} />;
}

async function render(value: string): Promise<string | null> {
	const mount = document.createElement("div");
	document.body.append(mount);
	const root = createRoot(mount);
	await act(async () => {
		root.render(
			<I18nProvider
				autoLocalizeDom={false}
				initialLocale="de"
				initialPackId={null}
				manageDocument={false}
			>
				<Probe value={value} />
			</I18nProvider>
		);
	});
	const title = mount.querySelector("output")?.getAttribute("title") ?? null;
	await act(async () => {
		root.unmount();
	});
	return title;
}

afterEach(() => {
	registerLiteralCatalogLoader(null);
	document.body.innerHTML = "";
	// Leave the shared document as later test files expect it, including
	// state an earlier file's managed provider wrote.
	document.documentElement.removeAttribute("lang");
	document.documentElement.removeAttribute("dir");
	document.documentElement.style.removeProperty("--ryu-locale");
});

test("useLocalizedString translates a dynamic sentence through a template", async () => {
	registerLiteralCatalogLoader(() => ({
		"Deleted {name}": "{name} gelöscht",
	}));
	expect(await render("Deleted {name} (copy)")).toBe("{name} (copy) gelöscht");
	expect(await render("Renamed Q3")).toBe("Renamed Q3");
});
