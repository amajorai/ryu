import { afterEach, expect, test } from "bun:test";
import { act } from "react";

import { registerTestDom } from "./test-dom-env.ts";

await registerTestDom();
const { loadReactDomClient } = await import("./test-dom-env.ts");
const { createRoot } = await loadReactDomClient();
const { I18nProvider, useLiteralMessages } = await import("./react.tsx");
const { registerLiteralCatalogLoader } = await import("./literal-catalog.ts");

const SOURCE = "Applied {count, plural, one {# change} other {# changes}}.";

function Probe({ count }: { count: number }) {
	const tl = useLiteralMessages();
	return <output>{tl(SOURCE, { count })}</output>;
}

async function render(node: React.ReactNode): Promise<string> {
	const mount = document.createElement("div");
	document.body.append(mount);
	const root = createRoot(mount);
	await act(async () => {
		root.render(node);
	});
	const text = mount.querySelector("output")?.textContent ?? "";
	await act(async () => {
		root.unmount();
	});
	return text;
}

afterEach(() => {
	registerLiteralCatalogLoader(null);
	document.body.innerHTML = "";
});

test("formats English without a provider", async () => {
	expect(await render(<Probe count={2} />)).toBe("Applied 2 changes.");
});

test("translates the whole sentence when the catalog knows it", async () => {
	registerLiteralCatalogLoader(() => ({
		[SOURCE]:
			"{count, plural, one {# Änderung} other {# Änderungen}} angewendet.",
	}));
	expect(
		await render(
			<I18nProvider
				autoLocalizeDom={false}
				initialLocale="de"
				initialPackId={null}
			>
				<Probe count={3} />
			</I18nProvider>
		)
	).toBe("3 Änderungen angewendet.");
});

test("formats untranslated copy in English inside a provider", async () => {
	registerLiteralCatalogLoader(() => ({}));
	expect(
		await render(
			<I18nProvider
				autoLocalizeDom={false}
				initialLocale="de"
				initialPackId={null}
			>
				<Probe count={1} />
			</I18nProvider>
		)
	).toBe("Applied 1 change.");
});

test("keeps the same tl across re-renders so effects that depend on it run once", async () => {
	const seen: unknown[] = [];
	function Recorder({ tick }: { tick: number }) {
		const tl = useLiteralMessages();
		seen.push(tl);
		return <output>{tl(SOURCE, { count: tick })}</output>;
	}
	const mount = document.createElement("div");
	document.body.append(mount);
	const root = createRoot(mount);
	await act(async () => {
		root.render(<Recorder tick={1} />);
	});
	await act(async () => {
		root.render(<Recorder tick={2} />);
	});
	expect(mount.querySelector("output")?.textContent).toBe("Applied 2 changes.");
	expect(seen.length).toBeGreaterThanOrEqual(2);
	expect(new Set(seen).size).toBe(1);
	await act(async () => {
		root.unmount();
	});
});
