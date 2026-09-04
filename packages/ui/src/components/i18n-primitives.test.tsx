import { describe, expect, test } from "bun:test";
import { I18nProvider, I18nText } from "@ryu/i18n/react";
import { renderToStaticMarkup } from "react-dom/server";
import { AlertDismiss } from "./alert.tsx";
import { Badge } from "./badge.tsx";
import { Input } from "./input.tsx";
import { Textarea } from "./textarea.tsx";

const PACK = {
	baseLocale: "en",
	direction: "ltr" as const,
	id: "community/controls",
	locale: "en",
	messages: {
		"common.dismiss": "Never mind",
		"common.search": "Find",
	},
	name: "Control labels",
	schemaVersion: 1 as const,
	version: "1.0.0",
};

describe("shared i18n controls", () => {
	test("localizes legacy input attributes and dismiss affordances", () => {
		const html = renderToStaticMarkup(
			<I18nProvider initialPackId={PACK.id} packs={[PACK]}>
				<div>
					<Input aria-label="Search" placeholder="Search" title="Search" />
					<Textarea placeholder="Search" />
					<AlertDismiss />
				</div>
			</I18nProvider>
		);

		expect(html).toContain('aria-label="Find"');
		expect(html).toContain('placeholder="Find"');
		expect(html).toContain('title="Find"');
		expect(html).toContain('aria-label="Never mind"');
		expect(html).not.toContain('placeholder="Search"');
	});

	test("keeps dynamic children literal until they opt into localization", () => {
		const dynamicLabel = "Search";
		const html = renderToStaticMarkup(
			<I18nProvider initialPackId={PACK.id} packs={[PACK]}>
				<div>
					<Badge>{dynamicLabel}</Badge>
					<I18nText id="common.search" />
				</div>
			</I18nProvider>
		);

		expect(html).toContain(">Search</span>");
		expect(html).toContain("Find");
	});
});
