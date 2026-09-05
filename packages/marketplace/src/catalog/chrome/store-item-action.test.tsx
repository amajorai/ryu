import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import StoreItemAction from "./store-item-action.tsx";

describe("StoreItemAction lifecycle language", () => {
	test("starts with Get for an item that is not installed", () => {
		const html = renderToStaticMarkup(
			<StoreItemAction installed={false} onInstall={() => undefined} />
		);

		expect(html).toContain("Get");
		expect(html).not.toContain("Add");
	});

	test("shows the live installation percentage while busy", () => {
		const html = renderToStaticMarkup(
			<StoreItemAction
				busy
				installed={false}
				onInstall={() => undefined}
				percent={42}
			/>
		);

		expect(html).toContain("42%");
		expect(html).toContain('aria-valuenow="42"');
	});

	test("ends on an Installed state after the lifecycle completes", () => {
		const html = renderToStaticMarkup(
			<StoreItemAction
				enabled
				installed
				onDisable={() => undefined}
				onUninstall={() => undefined}
			/>
		);

		expect(html).toContain("Installed");
		expect(html).toContain('aria-label="Manage"');
	});
});
