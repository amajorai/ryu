import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { Root } from "react-dom/client";
import type { AvailableUpdate } from "@/src/hooks/useAvailableUpdates.ts";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
Reflect.set(Element.prototype, "getAnimations", () => []);

const pluginUpdate: AvailableUpdate = {
	currentVersion: "1.2.0",
	id: "@ryu/demo",
	key: "plugin:@ryu/demo",
	kind: "plugin",
	latestVersion: "1.3.0",
	name: "Demo",
};

mock.module("@/src/hooks/useAvailableUpdates.ts", () => ({
	useAvailableUpdates: () => ({
		updates: [pluginUpdate],
		applyingKeys: new Set<string>(),
		loading: false,
		refresh: () => undefined,
		applyUpdate: async () => undefined,
	}),
}));

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { I18nProvider } = await import("@ryu/i18n/react");
const { registerLiteralCatalogLoader } = await import("@ryu/i18n/core");
const { SkillDistributionProvider } = await import(
	"@/src/components/skills/SkillDistributionProvider.tsx"
);
const { AvailableUpdates } = await import("./AvailableUpdates.tsx");

// The Arabic catalog owns the arrow: it flips "→" to "←" so the line reads
// right to left, and each version is a bidi isolate so the numbers keep their
// order instead of reading as a downgrade.
const AR: Record<string, string> = { "{from} → {to}": "{from} ← {to}" };
const FSI = "\u2068";
const PDI = "\u2069";

const services = {
	distribute: mock(async () => ({ skillId: "", targets: [] })),
	fetchTargets: mock(async () => {
		throw new Error("unused");
	}),
	install: mock(async () => {
		throw new Error("unused");
	}),
};

const roots: Root[] = [];

beforeEach(() => {
	registerLiteralCatalogLoader((locale) => (locale === "ar" ? AR : {}));
});

afterEach(async () => {
	await act(async () => {
		for (const root of roots.splice(0)) {
			root.unmount();
		}
	});
	document.body.replaceChildren();
	registerLiteralCatalogLoader(null);
});

async function renderIn(locale: string): Promise<HTMLElement> {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	roots.push(root);
	await act(async () => {
		root.render(
			<I18nProvider
				autoLocalizeDom={false}
				initialLocale={locale}
				initialPackId={null}
			>
				<SkillDistributionProvider services={services}>
					<AvailableUpdates />
				</SkillDistributionProvider>
			</I18nProvider>
		);
	});
	await act(async () => {
		await Bun.sleep(50);
	});
	return container;
}

function versionLine(container: HTMLElement): string | undefined {
	return Array.from(container.querySelectorAll("span"))
		.map((span) => span.textContent ?? "")
		.find((text) => text.includes("1.2.0") && text.includes("1.3.0"));
}

test("keeps the from and to versions in order, isolated, in English", async () => {
	const container = await renderIn("en");
	expect(versionLine(container)).toBe(`${FSI}1.2.0${PDI} → ${FSI}1.3.0${PDI}`);
});

test("shows the version range with the catalog's arrow in Arabic", async () => {
	const container = await renderIn("ar");
	const line = versionLine(container);
	expect(line).toBe(`${FSI}1.2.0${PDI} ← ${FSI}1.3.0${PDI}`);
	// The current version stays first in logical order, so an RTL line reads
	// "1.2.0 ← 1.3.0" from the right: an upgrade, not a downgrade.
	expect(line?.indexOf("1.2.0")).toBeLessThan(line?.indexOf("1.3.0") ?? -1);
});
