import { afterEach, expect, test } from "bun:test";
import { act } from "react";

import { registerTestDom } from "./test-dom-env.ts";

await registerTestDom();
const { loadReactDomClient } = await import("./test-dom-env.ts");
const { createRoot } = await loadReactDomClient();
const { I18nProvider } = await import("./core.ts").then(
	() => import("./react.tsx")
);
const { useRichLiteralMessages } = await import("./react-rich-text.tsx");
const { registerLiteralCatalogLoader } = await import("./literal-catalog.ts");

const SOURCE = "Step <b>{title}</b> was skipped.";

function Probe({ title }: { title: string }) {
	const tlRich = useRichLiteralMessages();
	return (
		<output>
			{tlRich(
				SOURCE,
				{ title },
				{ b: (children) => <strong>{children}</strong> }
			)}
		</output>
	);
}

async function render(node: React.ReactNode): Promise<string> {
	const mount = document.createElement("div");
	document.body.append(mount);
	const root = createRoot(mount);
	await act(async () => {
		root.render(node);
	});
	const html = mount.querySelector("output")?.innerHTML ?? "";
	await act(async () => {
		root.unmount();
	});
	return html;
}

afterEach(() => {
	registerLiteralCatalogLoader(null);
	document.body.replaceChildren();
});

test("renders English markup without a provider", async () => {
	expect(await render(<Probe title="Build" />)).toBe(
		"Step <strong>Build</strong> was skipped."
	);
});

test("lets the translation move the markup", async () => {
	registerLiteralCatalogLoader(() => ({
		[SOURCE]: "Schritt <b>{title}</b> wurde übersprungen.",
	}));
	expect(
		await render(
			<I18nProvider
				autoLocalizeDom={false}
				initialLocale="de"
				initialPackId={null}
			>
				<Probe title="Build" />
			</I18nProvider>
		)
	).toBe("Schritt <strong>Build</strong> wurde übersprungen.");
});

test("never turns a value into markup", async () => {
	expect(await render(<Probe title="<b>x</b>" />)).toBe(
		"Step <strong>&lt;b&gt;x&lt;/b&gt;</strong> was skipped."
	);
});
