// The Store detail panel's Permissions list must read in the reader's language,
// with no DOM localizer to rescue it: exact grant copy and family sentences
// ("Run the {command} command") both come back translated from the shared
// registry, and an unknown grant shows its raw id rather than a made-up English
// name such as "Tool execute".

import { afterAll, afterEach, expect, test } from "bun:test";
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
const { CatalogHostProvider } = await import("./host.tsx");
const { AppDetailPanel } = await import(
	"./apps-catalog-section-detail-panel.tsx"
);
const { VARIANT_COPY } = await import("./apps-catalog-section-variant-copy.ts");

const JA: Record<string, string> = {
	"Run its own code": "独自のコードを実行",
	"Run JavaScript code it ships, such as its tools and adapters, inside Ryu's sandbox. That code receives whatever an agent passes to those tools.":
		"ツールやアダプターなど、同梱の JavaScript コードを Ryu のサンドボックスで実行します。",
	"Run the {command} command": "{command} コマンドを実行",
	"Start the {command} program on this device, with the arguments its tools pass, when one of its tools is used.":
		"ツールの使用時に、このデバイスで {command} プログラムを起動します。",
	"Permission: {id}": "権限: {id}",
};

const GRANTS = ["tool:execute", "tool:command:rg", "example:unknown"];
/** Text that picks the grant rows out of the panel's list items: a word of the
 *  translated grant copy in each test catalog, the command name and the raw id. */
const GRANT_NEEDLES = new Set(["独自", "تشغيل", "rg", "example:unknown"]);
const ITEM = {
	enabled: false,
	entry: {
		description: "A plugin that does a specific, clearly explained thing.",
		id: "com.example.thing",
		kinds: ["tool"],
		name: "Thing",
		tags: [],
	},
	grants: GRANTS,
	installed: false,
};
const DETAIL = { description: ITEM.entry.description, origin: "community" };

const HOST = {
	ActiveModelControl: () => null,
	install: null,
	Markdown: ({ content }: { content: string }) => <p>{content}</p>,
	openExternal: () => undefined,
	renderAffordance: () => null,
	useActiveNode: () => ({ token: null, url: "" }),
	useInterfaceLevel: () => "expert",
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

async function renderGrantRows(
	locale: string,
	catalog: Record<string, string>
): Promise<string[]> {
	registerLiteralCatalogLoader((active) =>
		active.startsWith(locale) ? catalog : {}
	);
	const mount = document.createElement("div");
	document.body.append(mount);
	const root = createRoot(mount);
	roots.push(root);
	await act(async () => {
		root.render(
			<I18nProvider
				autoLocalizeDom={false}
				initialLocale={locale}
				initialPackId={null}
			>
				<CatalogHostProvider host={HOST as never}>
					<AppDetailPanel
						detail={DETAIL as never}
						detailError={null}
						detailLoading={false}
						error={null}
						install={() => Promise.resolve()}
						installLayer={null}
						isInstalling={() => false}
						item={ITEM as never}
						lifecyclePending={false}
						renderAffordance={() => null}
						selectedId={ITEM.entry.id}
						setEnabled={() => Promise.resolve()}
						settingsOpener={() => null}
						variantCopy={VARIANT_COPY.apps}
					/>
				</CatalogHostProvider>
			</I18nProvider>
		);
		await Bun.sleep(50);
	});
	return [...mount.querySelectorAll("li")]
		.map((row) => row.textContent ?? "")
		.filter((row) => [...GRANT_NEEDLES].some((needle) => row.includes(needle)));
}

test("the Permissions list renders grant copy in Japanese", async () => {
	const grantRows = await renderGrantRows("ja", JA);
	expect(grantRows).toHaveLength(GRANTS.length);
	const copy = grantRows.join("\n");
	expect(copy).toContain("独自のコードを実行");
	expect(copy).toContain("rg コマンドを実行");
	expect(copy).toContain("権限: \u2066example:unknown\u2069");
	for (const english of ["Tool execute", "Run its own code", "Run the rg"]) {
		expect(copy).not.toContain(english);
	}
});

const AR: Record<string, string> = {
	"Run its own code": "تشغيل الكود الخاص به",
	"Run JavaScript code it ships, such as its tools and adapters, inside Ryu's sandbox. That code receives whatever an agent passes to those tools.":
		"يشغّل كود JavaScript المرفق به داخل بيئة Ryu المعزولة.",
	"Run the {command} command": "تشغيل الأمر {command}",
	"Start the {command} program on this device, with the arguments its tools pass, when one of its tools is used.":
		"يبدأ البرنامج {command} على هذا الجهاز عند استخدام إحدى أدواته.",
	"Permission: {id}": "إذن: {id}",
};

test("the Permissions list renders grant copy in Arabic with the raw id isolated left-to-right", async () => {
	const grantRows = await renderGrantRows("ar", AR);
	expect(grantRows).toHaveLength(GRANTS.length);
	const copy = grantRows.join("\n");
	expect(copy).toContain("تشغيل الكود الخاص به");
	expect(copy).toContain("تشغيل الأمر \u2068rg\u2069");
	// The Latin id keeps its own reading order inside the right-to-left sentence.
	expect(copy).toContain("إذن: \u2066example:unknown\u2069");
	for (const english of ["Tool execute", "Run its own code", "Permission:"]) {
		expect(copy).not.toContain(english);
	}
});
