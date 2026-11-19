// The wiki's table of contents and the library reader's chapter list are
// table-of-contents headings and read through the keyed `nav.tableOfContents`
// (ja 目次). The bare catalog "Contents" is what something holds (ja 内容).
import { expect, test } from "bun:test";
import { I18nProvider } from "@ryu/i18n/react";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { LibraryBook } from "./library-model.ts";
import { ContentsMenu } from "./library-reader.tsx";
import { WikiNavProvider, WikiToc } from "./wiki-parts.tsx";

function render(locale: string, node: ReactNode): string {
	return renderToStaticMarkup(
		<I18nProvider
			autoLocalizeDom={false}
			initialLocale={locale}
			initialPackId={locale === "en" ? null : `official/${locale}`}
			manageDocument={false}
			overlays={{ ja: { Contents: "内容" } }}
		>
			{node}
		</I18nProvider>
	);
}

const wikiToc = (
	<WikiNavProvider
		value={{
			current: { kind: "home" } as never,
			go: () => undefined,
			idPrefix: "w",
		}}
	>
		<WikiToc
			sections={[
				{ id: "threads", label: "Threads" },
				{ id: "members", label: "Members" },
			]}
		/>
	</WikiNavProvider>
);

const book = {
	agentId: null,
	authors: [],
	chapters: [],
	description: "",
	finishedCount: 0,
	groupId: null,
	id: "book-1",
	kind: "agent",
	title: "Field notes",
	updatedAt: null,
	waiting: [],
	working: false,
} as unknown as LibraryBook;

test("the Japanese wiki heads its table of contents 目次", () => {
	const html = render("ja", wikiToc);
	expect(html).toContain('aria-label="目次"');
	expect(html).toContain(">目次</h2>");
	expect(html).not.toContain("内容");
});

test("the Japanese reader labels its chapter list 目次", () => {
	const html = render(
		"ja",
		<ContentsMenu
			book={book}
			currentId={null}
			onOpenChapter={() => undefined}
		/>
	);
	expect(html).toContain('aria-label="目次"');
});

test("English keeps Contents", () => {
	expect(render("en", wikiToc)).toContain(">Contents</h2>");
});
