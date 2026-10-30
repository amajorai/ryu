import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { RuntimeSettingsMenu } from "./runtime-controls.tsx";

const noop = () => undefined;

describe("RuntimeSettingsMenu", () => {
	test("lists every runtime with the screened guest lane and no model picker", () => {
		const html = renderToStaticMarkup(
			<RuntimeSettingsMenu
				busy={false}
				guestAvailable
				mode="guest"
				nodeConnected={false}
				onDisconnect={noop}
				onModeChange={noop}
			/>
		);

		expect(html).toContain('aria-label="Assistant runtime"');
		expect(html).toContain("Browser");
		expect(html).toContain("Ryu guest");
		expect(html).toContain("Local node");
		expect(html).toContain("Prompts go through Ryu&#x27;s hosted gateway");
		expect(html).not.toContain("OpenCode");
		expect(html).not.toContain("Disconnect this tab");
	});

	test("disables the guest lane when the site has none configured", () => {
		const html = renderToStaticMarkup(
			<RuntimeSettingsMenu
				busy={false}
				guestAvailable={false}
				mode="browser"
				nodeConnected={false}
				onDisconnect={noop}
				onModeChange={noop}
			/>
		);

		expect(html).toContain("Not available on this site");
		expect(html).toMatch(/<button[^>]*disabled=""[^>]*>.*?Ryu guest/u);
	});

	test("offers disconnect only for a connected node", () => {
		const html = renderToStaticMarkup(
			<RuntimeSettingsMenu
				busy={false}
				guestAvailable
				mode="node"
				nodeConnected
				onDisconnect={noop}
				onModeChange={noop}
			/>
		);

		expect(html).toContain("Disconnect this tab");
	});
});
