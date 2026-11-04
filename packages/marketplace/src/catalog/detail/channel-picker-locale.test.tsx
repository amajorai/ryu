// The release-train picker under a Japanese UI: the closed trigger shows the
// selected train's translated name, not the raw channel token ("beta") that
// Base UI prints when the Select has no `items`.

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

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

const { I18nProvider } = await import("@ryu/i18n/react");
const { registerLiteralCatalogLoader } = await import("@ryu/i18n/core");
const { ChannelPicker } = await import("./channel-picker.tsx");

const JA: Record<string, string> = {
	Beta: "ベータ",
	"Pre-release": "プレリリース",
	"Pre-release · {version}": "プレリリース · {version}",
	Stable: "安定版",
};

const roots: Root[] = [];

afterEach(async () => {
	for (const root of roots.splice(0)) {
		await act(async () => {
			root.unmount();
		});
	}
	registerLiteralCatalogLoader(null);
	document.body.innerHTML = "";
});

async function mount(value: string | null): Promise<HTMLDivElement> {
	registerLiteralCatalogLoader(() => JA);
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	roots.push(root);
	await act(async () => {
		root.render(
			<I18nProvider
				autoLocalizeDom={false}
				initialLocale="ja"
				initialPackId={null}
			>
				<ChannelPicker
					channels={[
						{ channel: "stable", version: "1.2.0" },
						{ channel: "beta", version: "1.3.0-beta.2" },
					]}
					onChange={() => undefined}
					value={value}
				/>
			</I18nProvider>
		);
	});
	return host;
}

function triggerText(host: HTMLElement): string {
	return host.querySelector("button")?.textContent?.trim() ?? "";
}

describe("ChannelPicker under ja", () => {
	test("the closed trigger shows the translated train name", async () => {
		const host = await mount("beta");
		expect(triggerText(host)).toContain("ベータ");
		expect(triggerText(host)).not.toContain("beta");
		expect(host.textContent).toContain("プレリリース · 1.3.0-beta.2");
	});

	test("stable reads as the translated stable name", async () => {
		const host = await mount(null);
		expect(triggerText(host)).toContain("安定版");
		expect(triggerText(host)).not.toContain("stable");
	});
});
