import { afterEach, expect, test } from "bun:test";
import { registerLiteralCatalogLoader } from "@ryu/i18n/core";
import { I18nProvider } from "@ryu/i18n/react";
import { renderToStaticMarkup } from "react-dom/server";
import { ModelDetailHeader } from "./models-catalog-section-detail-header.tsx";
import type { ModelCard } from "./types.ts";

const CARD: ModelCard = {
	architecture: null,
	author: "meta-llama",
	compatible: true,
	contextLength: null,
	createdAt: null,
	downloads: 0,
	format: "gguf",
	gated: false,
	id: "meta-llama/Llama-3",
	installed: false,
	lastModified: null,
	likes: 0,
	name: "Llama-3",
	needsEngine: null,
	params: null,
	pipelineTag: null,
	tags: [],
};

afterEach(() => {
	registerLiteralCatalogLoader(null);
});

function renderJapanese(card: ModelCard): string {
	registerLiteralCatalogLoader(() => ({
		"by <author>{author}</author>": "<author>{author}</author> 提供",
		"by an unknown author": "提供元不明",
	}));
	return renderToStaticMarkup(
		<I18nProvider
			autoLocalizeDom={false}
			initialLocale="ja"
			initialPackId={null}
		>
			<ModelDetailHeader
				activeTokens={new Set()}
				card={card}
				friendly={false}
				onSelectOrg={() => undefined}
				onToggleToken={() => undefined}
			/>
		</I18nProvider>
	);
}

test("the author line is one translated sentence with the author as a link", () => {
	const html = renderJapanese(CARD);
	expect(html).toMatch(/<button[^>]*>meta-llama<\/button> 提供/u);
	expect(html).not.toContain("by ");
});

test("a model with no author says so in the reader's language", () => {
	expect(renderJapanese({ ...CARD, author: "" })).toContain("提供元不明");
});
