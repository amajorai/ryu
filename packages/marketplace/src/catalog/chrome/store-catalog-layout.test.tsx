import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
	StoreCardGrid,
	StoreViewModeProvider,
} from "./store-catalog-layout.tsx";

describe("StoreCardGrid", () => {
	test("follows the active Store List preference", () => {
		const html = renderToStaticMarkup(
			<StoreViewModeProvider mode="list">
				<StoreCardGrid>
					<span>One</span>
				</StoreCardGrid>
			</StoreViewModeProvider>
		);

		expect(html).toContain("flex flex-col gap-1.5");
		expect(html).not.toContain("sm:grid-cols-2");
	});

	test("keeps Showcase on the card grid geometry", () => {
		const html = renderToStaticMarkup(
			<StoreViewModeProvider mode="showcase">
				<StoreCardGrid>
					<span>One</span>
				</StoreCardGrid>
			</StoreViewModeProvider>
		);

		expect(html).toContain("sm:grid-cols-2");
	});
});
