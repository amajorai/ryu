// Counted catalog facts under a non-English UI. "{count} tokens" and
// "{count} downloads" are whole ICU plural messages that receive the already
// locale-grouped number as text, so a German "32.768" stays 32,768 instead of
// being re-read as a decimal (32.768 → "32,768"). The model list's
// "(updated {ago})" suffix is one whole message too, so it is never left as
// an English "(updated" around a translated age.

import { afterAll, afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { ReactNode } from "react";
import type { CatalogEntry, ModelCard } from "./types.ts";

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

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { I18nProvider } = await import("@ryu/i18n/react");
const { registerLiteralCatalogLoader } = await import("@ryu/i18n/core");
const { ModelSpecsRow } = await import(
	"./models-catalog-section-detail-header.tsx"
);
const { ModelList } = await import("./models-catalog-section-list.tsx");
const { DetailMetaStrip } = await import("./detail/detail-meta-strip.tsx");

const TOKENS =
	"{count, plural, one {{countText} token} other {{countText} tokens}}";
const DOWNLOADS =
	"{count, plural, one {{countText} download} other {{countText} downloads}}";
const UPDATED = "(updated {ago})";

const card: ModelCard = {
	architecture: null,
	author: "google",
	compatible: true,
	contextLength: 32_768,
	createdAt: null,
	downloads: 12_345,
	format: "gguf",
	gated: false,
	id: "google/gemma-4b",
	installed: false,
	lastModified: new Date(Date.now() - 3 * 86_400_000).toISOString(),
	likes: 0,
	name: "Gemma-4B-Instruct",
	needsEngine: null,
	params: null,
	pipelineTag: "text-generation",
	tags: [],
};

const entry: CatalogEntry = {
	description: "A listing",
	id: "@ryu/example",
	kinds: ["app"],
	name: "Example",
	tags: [],
};

const mounts: Array<{ unmount: () => void; node: HTMLElement }> = [];

afterEach(async () => {
	for (const mount of mounts.splice(0)) {
		await act(async () => {
			mount.unmount();
		});
		mount.node.remove();
	}
	registerLiteralCatalogLoader(null);
});

async function renderIn(locale: string, children: ReactNode): Promise<string> {
	const node = document.createElement("div");
	document.body.append(node);
	const root = createRoot(node);
	mounts.push({ node, unmount: () => root.unmount() });
	await act(async () => {
		root.render(
			<I18nProvider
				autoLocalizeDom={false}
				initialLocale={locale}
				initialPackId={null}
			>
				{children}
			</I18nProvider>
		);
	});
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
	return node.textContent ?? "";
}

test("the context window reads as whole English plural copy", async () => {
	const text = await renderIn("en", <ModelSpecsRow card={card} />);
	expect(text).toContain("32,768 tokens");
});

test("the context window keeps the German grouped number intact", async () => {
	registerLiteralCatalogLoader(() => ({
		[TOKENS]:
			"{count, plural, one {{countText} Token} other {{countText} Tokens}}",
	}));
	const text = await renderIn("de", <ModelSpecsRow card={card} />);
	expect(text).toContain("32.768 Tokens");
	expect(text).not.toContain("32,768");
});

test("the download count keeps the German grouped number intact", async () => {
	registerLiteralCatalogLoader(() => ({
		[DOWNLOADS]:
			"{count, plural, one {{countText} Download} other {{countText} Downloads}}",
	}));
	const text = await renderIn(
		"de",
		<DetailMetaStrip detail={{ downloads: 12_345 }} entry={entry} />
	);
	expect(text).toContain("12.345 Downloads");
	expect(text).not.toContain("12,345");
});

test("a single download reads in the singular", async () => {
	const text = await renderIn(
		"en",
		<DetailMetaStrip detail={{ downloads: 1 }} entry={entry} />
	);
	expect(text).toContain("1 download");
	expect(text).not.toContain("1 downloads");
});

test("the model list update suffix is one translated message", async () => {
	registerLiteralCatalogLoader(() => ({ [UPDATED]: "({ago}に更新)" }));
	const text = await renderIn(
		"ja",
		<ModelList
			error={null}
			fetchNextPage={() => undefined}
			friendly={false}
			hasNextPage={false}
			installedOnly={false}
			loading={false}
			loadingMore={false}
			models={[card]}
			onClearFilters={() => undefined}
			onRetry={() => undefined}
			onSelect={() => undefined}
			selectedId={null}
			showTags={false}
		/>
	);
	expect(text).toContain("に更新)");
	expect(text).not.toContain("(updated");
});
