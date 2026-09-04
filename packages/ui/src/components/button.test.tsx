import { describe, expect, test } from "bun:test";
import { I18nProvider } from "@ryu/i18n/react";
import { renderToStaticMarkup } from "react-dom/server";
import { Button } from "./button.tsx";

describe("Button loading state", () => {
	test("renders a corner spinner and busy semantics for a custom variant", () => {
		const html = renderToStaticMarkup(
			<Button loading variant="outline">
				Save
			</Button>
		);

		expect(html).toContain("Save");
		expect(html).toContain('aria-busy="true"');
		expect(html).toContain("disabled");
		expect(html).toContain("absolute");
		expect(html).toContain("top-1.5");
	});

	test("treats the loading variant as a loading state", () => {
		const html = renderToStaticMarkup(
			<Button variant="loading">Loading action</Button>
		);

		expect(html).toContain('aria-busy="true"');
		expect(html).toContain("Loading action");
	});

	test("keeps progress semantics when it is not loading", () => {
		const html = renderToStaticMarkup(
			<Button progress={42} variant="progress">
				Downloading
			</Button>
		);

		expect(html).toContain('role="progressbar"');
		expect(html).toContain('aria-valuenow="42"');
		expect(html).toContain('data-slot="button-progress-fill"');
		expect(html).not.toContain('aria-busy="true"');
	});
});

describe("Button overflow labels", () => {
	test("wraps direct text children in the shared measured label", () => {
		const html = renderToStaticMarkup(
			<Button className="w-32" variant="outline">
				A label that can outgrow the button
			</Button>
		);

		expect(html).toContain("overflow-hidden");
		expect(html).toContain("whitespace-nowrap");
		expect(html).toContain("A label that can outgrow the button");
	});

	test("localizes direct labels through the shared runtime", () => {
		const html = renderToStaticMarkup(
			<I18nProvider
				initialPackId="community/test"
				packs={[
					{
						baseLocale: "en",
						direction: "ltr",
						id: "community/test",
						locale: "en",
						messages: { "common.save": "Ship it" },
						name: "Test voice",
						schemaVersion: 1,
						version: "1.0.0",
					},
				]}
			>
				<Button>Save</Button>
			</I18nProvider>
		);

		expect(html).toContain("Ship it");
		expect(html).not.toContain(">Save<");
	});
});
