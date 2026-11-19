import { afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { SystemInfo } from "@ryuhq/core-client/system.ts";
import type { Root } from "react-dom/client";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { I18nProvider } = await import("@ryu/i18n/react");
const { registerLiteralCatalogLoader } = await import("@ryu/i18n/core");
const { NodeStats } = await import("./NodeSelector-hardware.tsx");

// Intl puts a no-break space between a German number and its unit.
const NBSP = String.fromCodePoint(0xa0);
const GIB = 1024 ** 3;

// The sidebar's usage line and VRAM spec follow the UI language's number
// format, not Core's English `*_human` strings.
const CATALOGS: Record<string, Record<string, string>> = {
	de: {
		"{used} / {total}": "{used} von {total}",
		"{vram} VRAM": "{vram} Grafikspeicher",
	},
	ja: {
		"{used} / {total}": "{used} / {total} 使用中",
	},
};

const INFO: SystemInfo = {
	cpuCores: null,
	cpuName: null,
	diskHuman: "",
	gpuName: null,
	hostname: null,
	managed: false,
	orgId: null,
	orgName: null,
	os: "",
	physicalCores: null,
	ramHuman: "63.7 GB",
	totalDiskBytes: null,
	totalRamBytes: Math.round(63.7 * GIB),
	unifiedMemory: false,
	usedDiskBytes: null,
	usedDiskHuman: "",
	usedRamBytes: Math.round(41.3 * GIB),
	usedRamHuman: "41.3 GB",
	vramBytes: 24 * GIB,
	vramHuman: "24.0 GB",
};

const roots: Root[] = [];

afterEach(async () => {
	await act(async () => {
		for (const root of roots.splice(0)) {
			root.unmount();
		}
	});
	document.body.replaceChildren();
	registerLiteralCatalogLoader(null);
});

async function renderStats(locale: string, info: SystemInfo): Promise<string> {
	registerLiteralCatalogLoader((tag) => CATALOGS[tag.split("-")[0]] ?? {});
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
				<NodeStats info={info} />
			</I18nProvider>
		);
	});
	await act(async () => {
		await Promise.resolve();
	});
	return container.textContent ?? "";
}

test("German shows German decimals and the translated usage sentence", async () => {
	const text = await renderStats("de", INFO);
	expect(text).toContain(`41,3${NBSP}GB von 63,7${NBSP}GB`);
	expect(text).toContain(`24,0${NBSP}GB Grafikspeicher`);
	expect(text).not.toContain("41.3");
});

test("Japanese wraps the sizes in its own usage sentence", async () => {
	expect(await renderStats("ja", INFO)).toContain("41.3 GB / 63.7 GB 使用中");
});

test("English keeps the source sizes", async () => {
	const text = await renderStats("en", INFO);
	expect(text).toContain("41.3 GB / 63.7 GB");
	expect(text).toContain("24.0 GB VRAM");
});

test("falls back to Core's strings when byte counts are missing", async () => {
	const text = await renderStats("de", {
		...INFO,
		totalRamBytes: null,
		usedRamBytes: null,
		vramBytes: null,
	});
	expect(text).toContain("41.3 GB von 63.7 GB");
	expect(text).toContain("24.0 GB Grafikspeicher");
});
