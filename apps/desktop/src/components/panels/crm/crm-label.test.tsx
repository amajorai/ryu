import { afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (globalThis.document === undefined) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { I18nProvider } = await import("@ryu/i18n/react");
const { formatMessage, registerLiteralCatalogLoader } = await import(
	"@ryu/i18n/core"
);
const { CrmSelectOption, CrmUserText, crmLabel } = await import(
	"./crm-label.tsx"
);

import type { LiteralMessage } from "@ryu/i18n/react";
import type { ReactNode } from "react";

// The catalog's one-word "Deal" and "Lead" are the verb and leadership; a CRM
// object or stage named that must never take those senses.
const JA: Record<string, string> = {
	Deal: "配る",
	"Deal (CRM record)": "取引",
	Lead: "リーダー",
	"Lead stage": "見込み客",
	Healthcare: "医療",
	Settings: "設定",
};

function stubTl(catalog: Record<string, string>): LiteralMessage {
	return (source, values) => formatMessage(catalog[source] ?? source, values);
}

async function mountInJapanese(node: ReactNode): Promise<{
	container: HTMLDivElement;
	unmount: () => Promise<void>;
}> {
	registerLiteralCatalogLoader((locale) => (locale.startsWith("ja") ? JA : {}));
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	await act(async () => {
		root.render(
			<I18nProvider initialLocale="ja" initialPackId={null}>
				{node}
			</I18nProvider>
		);
	});
	// Let the catalog load and the DOM localizer pass settle.
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 50));
	});
	return {
		container,
		unmount: async () => {
			await act(async () => root.unmount());
			container.remove();
		},
	};
}

afterEach(() => {
	registerLiteralCatalogLoader(null);
	document.body.innerHTML = "";
});

test("a seed Deal or Lead label takes its CRM sense, not the verb", () => {
	const tl = stubTl(JA);
	expect(crmLabel("Deal", tl)).toBe("取引");
	expect(crmLabel("Lead", tl)).toBe("見込み客");
});

test("English, or a locale without the message, keeps the label as typed", () => {
	expect(crmLabel("Deal", stubTl({}))).toBe("Deal");
	expect(crmLabel("Lead", stubTl({}))).toBe("Lead");
	expect(crmLabel("Settings", stubTl(JA))).toBe("Settings");
});

test("a Deal object name renders its CRM sense in Japanese", async () => {
	const { container, unmount } = await mountInJapanese(
		<p>
			<CrmUserText text="Deal" withTitle />
		</p>
	);
	const span = container.querySelector("span");
	expect(span?.textContent).toBe("取引");
	expect(span?.getAttribute("title")).toBe("取引");
	expect(container.innerHTML).not.toContain("配る");
	await unmount();
});

test("a label the user typed is never rewritten by the localizer", async () => {
	const { container, unmount } = await mountInJapanese(
		<p>
			<CrmUserText text="Settings" />
		</p>
	);
	const span = container.querySelector("span");
	expect(span?.textContent).toBe("Settings");
	expect(span?.getAttribute("data-ryu-i18n")).toBe("off");
	expect(container.innerHTML).not.toContain("設定");
	await unmount();
});

test("select options show the stage's CRM sense and keep user labels", async () => {
	const { container, unmount } = await mountInJapanese(
		<select aria-label="Stage" defaultValue="lead">
			<CrmSelectOption label="Lead" value="lead" />
			<CrmSelectOption label="Settings" value="settings" />
		</select>
	);
	const options = [...container.querySelectorAll("option")].map(
		(option) => option.textContent
	);
	expect(options).toEqual(["見込み客", "Settings"]);
	expect(container.innerHTML).not.toContain("リーダー");
	expect(container.innerHTML).not.toContain("設定");
	await unmount();
});

test("a seed label the catalog translates correctly still reads in Japanese", async () => {
	const { container, unmount } = await mountInJapanese(
		<div>
			<p>
				<CrmUserText text="Healthcare" />
			</p>
			<select aria-label="Industry" defaultValue="healthcare">
				<CrmSelectOption label="Healthcare" value="healthcare" />
			</select>
		</div>
	);
	expect(container.querySelector("span")?.textContent).toBe("医療");
	expect(container.querySelector("span")?.getAttribute("data-ryu-i18n")).toBe(
		null
	);
	expect(container.querySelector("option")?.textContent).toBe("医療");
	await unmount();
});
