// Status and adjective uses of "New" (an unread book's progress, a
// freelancer with no job-success score yet) must not reuse the bare "New" key, which several languages
// translate as the create action ("Создать", "新建", "새로 만들기").

import { afterAll, afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { ReactElement } from "react";
import type { Root } from "react-dom/client";

const ownsDom = typeof document === "undefined";
if (ownsDom) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { registerLiteralCatalogLoader } = await import("@ryu/i18n/core");
const { I18nProvider } = await import("@ryu/i18n/react");
const { BookTile } = await import("./library-shelf.tsx");

const RUSSIAN_CATALOG: Record<string, string> = JSON.parse(
	readFileSync(
		new URL("../../../../i18n/locales/ru.json", import.meta.url),
		"utf8"
	)
);
const CREATE_ACTION = RUSSIAN_CATALOG.New ?? "New";

const noop = () => undefined;

let mounted: { container: HTMLElement; root: Root } | undefined;
afterEach(async () => {
	registerLiteralCatalogLoader(null);
	if (mounted) {
		const { container, root } = mounted;
		await act(async () => {
			root.unmount();
		});
		container.remove();
		mounted = undefined;
	}
});
afterAll(async () => {
	if (ownsDom) {
		await GlobalRegistrator.unregister();
	}
});

async function renderRussian(element: ReactElement): Promise<HTMLElement> {
	registerLiteralCatalogLoader((requested) =>
		requested.startsWith("ru") ? RUSSIAN_CATALOG : {}
	);
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	mounted = { container, root };
	await act(async () => {
		root.render(
			<I18nProvider initialLocale="ru" initialPackId={null}>
				{element}
			</I18nProvider>
		);
	});
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 20));
	});
	return container;
}

test("the catalog's bare New is the create action this guards against", () => {
	expect(CREATE_ACTION).toBe("Создать");
});

test("an unread book's progress does not read as Create in Russian", async () => {
	const container = await renderRussian(
		<ul>
			<BookTile
				book={{
					agentId: null,
					authors: [],
					chapters: [],
					description: "",
					finishedCount: 0,
					groupId: null,
					id: "book-empty",
					kind: "unassigned",
					title: "Field notes",
					updatedAt: null,
					waiting: [],
					working: false,
				}}
				onOpen={noop}
			/>
		</ul>
	);
	const text = container.textContent ?? "";
	expect(text).not.toContain(CREATE_ACTION);
	expect(text).toContain(RUSSIAN_CATALOG["Not started"] ?? "Not started");
});

// The replacement messages across the status sites (blocks, desktop, web and
// the Feedback Board), checked against the bare "New" in each catalog. New
// keys are skipped until the catalogs carry them.
const STATUS_MESSAGES = [
	"Not started",
	"Not rated yet",
	"New freelancer",
	"Draft",
	"No conversations yet",
	"New plan",
	"New request",
	"New application",
];

for (const locale of ["ru", "zh-CN", "ko", "ja", "ar", "de"]) {
	test(`${locale} status messages never reuse the bare New translation`, () => {
		const catalog: Record<string, string> = JSON.parse(
			readFileSync(
				new URL(`../../../../i18n/locales/${locale}.json`, import.meta.url),
				"utf8"
			)
		);
		expect(catalog.New).toBeDefined();
		for (const message of STATUS_MESSAGES) {
			const translated = catalog[message];
			if (translated !== undefined) {
				expect(translated).not.toBe(catalog.New);
			}
		}
	});
}
