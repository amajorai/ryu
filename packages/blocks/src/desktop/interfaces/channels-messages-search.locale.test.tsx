import { afterAll, afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { I18nProvider } from "@ryu/i18n/react";
import type { InterfaceSnapshot } from "@ryuhq/protocol/interfaces";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

// "No messages in #x match y" is one translatable sentence with the channel
// and the query as tags, so a locale can reorder them and add its own words
// around them instead of stitching "No messages in" + "match" together.
const ownsDom = typeof document === "undefined";
if (ownsDom) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const { registerLiteralCatalogLoader } = await import("@ryu/i18n/core");
const { SearchEmpty } = await import("./channels-messages-search.tsx");

const SOURCE =
	"No messages in <channel>{channelLabel}</channel> match <query>{query}</query>";
const PACKS: Record<string, Record<string, string>> = {
	ar: {
		[SOURCE]:
			"لا توجد رسائل في <channel>{channelLabel}</channel> تطابق <query>{query}</query>",
	},
	de: {
		[SOURCE]:
			"Keine Nachrichten in <channel>{channelLabel}</channel> passen zu <query>{query}</query>",
	},
	ja: {
		[SOURCE]:
			"<channel>{channelLabel}</channel> に <query>{query}</query> と一致するメッセージはありません",
	},
};

let mounted: { container: HTMLElement; root: Root } | undefined;
async function unmount(): Promise<void> {
	if (mounted) {
		const { container, root } = mounted;
		await act(async () => {
			root.unmount();
		});
		container.remove();
		mounted = undefined;
	}
}
afterEach(async () => {
	registerLiteralCatalogLoader(null);
	await unmount();
});
afterAll(async () => {
	if (ownsDom) {
		await GlobalRegistrator.unregister();
	}
});

async function renderTitle(locale: string): Promise<HTMLElement> {
	registerLiteralCatalogLoader(
		(requested) => PACKS[requested.split("-")[0] ?? ""] ?? {}
	);
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	mounted = { container, root };
	await act(async () => {
		root.render(
			<I18nProvider initialLocale={locale} initialPackId={null}>
				<SearchEmpty
					channelLabel="#site-refresh"
					hits={[]}
					onClear={() => undefined}
					onSelectChannel={() => undefined}
					query="release"
					snapshot={{} as InterfaceSnapshot}
				/>
			</I18nProvider>
		);
	});
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 20));
	});
	const title = container.querySelector("h3");
	if (!title) {
		throw new Error("search-empty title not rendered");
	}
	return title;
}

test("English keeps the sentence with the channel and query marked up", async () => {
	const title = await renderTitle("en");
	expect(title.textContent).toBe("No messages in #site-refresh match release");
	expect(title.querySelector("span.whitespace-nowrap")?.textContent).toBe(
		"#site-refresh"
	);
	expect(title.querySelector("mark")?.textContent).toBe("release");
});

test("German renders one grammatical sentence with its own preposition", async () => {
	const title = await renderTitle("de");
	expect(title.textContent).toBe(
		"Keine Nachrichten in #site-refresh passen zu release"
	);
	expect(title.textContent).not.toContain("No messages");
	expect(title.textContent).not.toContain(" match ");
	expect(title.querySelector("mark")?.textContent).toBe("release");
});

test("Japanese moves the channel and query ahead of the verb", async () => {
	const title = await renderTitle("ja");
	expect(title.textContent).toBe(
		"#site-refresh に release と一致するメッセージはありません"
	);
	expect(title.querySelector("span.whitespace-nowrap")?.textContent).toBe(
		"#site-refresh"
	);
	expect(title.querySelector("mark")?.textContent).toBe("release");
});

test("Arabic isolates the channel and query inside its own sentence", async () => {
	const title = await renderTitle("ar");
	// U+2068/U+2069 keep "#site-refresh" and "release" left-to-right runs.
	expect(title.textContent).toBe(
		"لا توجد رسائل في \u2068#site-refresh\u2069 تطابق \u2068release\u2069"
	);
	expect(title.querySelector("mark")?.textContent).toBe("\u2068release\u2069");
});
