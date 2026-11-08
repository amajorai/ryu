import { afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { I18nProvider } = await import("@ryu/i18n/react");
const { registerLiteralCatalogLoader } = await import("@ryu/i18n/core");
const { NativeSelectOption } = await import(
	"@ryu/ui/components/native-select.tsx"
);
const { VersionLabelOption } = await import("./VersionLabelOption.tsx");

// "Save" is a catalog string, so a user who names a snapshot "Save" is the
// case a catalog-translating option gets wrong.
const CATALOGS: Record<string, Record<string, string>> = {
	ar: { "Before restore": "قبل الاستعادة", Save: "حفظ" },
	de: { "Before restore": "Vor der Wiederherstellung", Save: "Speichern" },
	ja: { "Before restore": "復元前", Save: "保存" },
};

afterEach(() => {
	registerLiteralCatalogLoader(null);
	document.body.replaceChildren();
});

async function renderOptions(
	locale: string,
	children: React.ReactNode
): Promise<string[]> {
	registerLiteralCatalogLoader((target) => CATALOGS[target.slice(0, 2)] ?? {});
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	await act(async () => {
		root.render(
			<I18nProvider
				autoLocalizeDom={false}
				initialLocale={locale}
				initialPackId={null}
			>
				<select>{children}</select>
			</I18nProvider>
		);
	});
	const texts = [...container.querySelectorAll("option")].map(
		(option) => option.textContent ?? ""
	);
	await act(async () => {
		root.unmount();
	});
	return texts;
}

for (const locale of ["ja", "ar", "de"]) {
	test(`${locale}: system label translated, user label and date verbatim`, async () => {
		const catalog = CATALOGS[locale] ?? {};
		expect(
			await renderOptions(
				locale,
				<>
					<VersionLabelOption fallback="x" label="Before restore" value="1" />
					<VersionLabelOption fallback="x" label="Save" value="2" />
					<VersionLabelOption fallback="2026-11-06 10:00" value="3" />
				</>
			)
		).toEqual([catalog["Before restore"], "Save", "2026-11-06 10:00"]);
	});
}

test("the catalog-translating option would rewrite the user label", async () => {
	expect(
		await renderOptions(
			"ja",
			<NativeSelectOption value="2">Save</NativeSelectOption>
		)
	).toEqual(["保存"]);
});
