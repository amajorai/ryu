// Model file and device sizes follow the UI language. Core sends each size as a
// byte count plus an English `*Human` string; the catalog words the count in the
// reader's locale ("4,9 GB" under German) and keeps Core's string only when the
// count is missing.

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { formatMessage, type MessageValuesInput } from "@ryu/i18n/core";
// The provider registers its runtime here; a test registers a stand-in.
import {
	registerActiveI18nRuntime,
	unregisterActiveI18nRuntime,
} from "../../../i18n/src/active-locale.ts";
import type { ModelDetail, ModelFile } from "./types.ts";

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

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { I18nProvider } = await import("@ryu/i18n/react");
const { registerLiteralCatalogLoader } = await import("@ryu/i18n/core");
const { FileSections } = await import(
	"./models-catalog-section-file-sections.tsx"
);
const { deviceSummaryLines } = await import(
	"./models-catalog-section-format.ts"
);

const FILE_BYTES = 5_261_334_937;

const device: ModelDetail["device"] = {
	diskFreeBytes: 128_849_018_880,
	diskFreeHuman: "120 GB",
	gpuName: "RTX 4090",
	os: "linux",
	ramHuman: "15.5 GB",
	totalRamBytes: 16_642_998_272,
	unifiedMemory: false,
	vramBytes: 4 * 1024 ** 3 + 300 * 1024 ** 2,
	vramHuman: "4.3 GB",
};

function file(over: Partial<ModelFile>): ModelFile {
	return {
		filename: "model-Q4_K_M.gguf",
		fit: "ok",
		fitLabel: "Runs on your GPU",
		installed: false,
		quant: "Q4_K_M",
		sizeBytes: FILE_BYTES,
		sizeHuman: "4.9 GB",
		...over,
	};
}

/** Intl puts a no-break space before the unit; compare on plain spaces. */
const plain = (text: string) => text.replace(/\s/gu, " ");

const mounts: Array<{ unmount: () => void; node: HTMLElement }> = [];

afterEach(async () => {
	for (const mount of mounts.splice(0)) {
		await act(async () => {
			mount.unmount();
		});
		mount.node.remove();
	}
	registerLiteralCatalogLoader(null);
});

async function renderFiles(locale: string, files: ModelFile[]) {
	const node = document.createElement("div");
	document.body.append(node);
	const root = createRoot(node);
	mounts.push({ node, unmount: () => root.unmount() });
	await act(async () => {
		root.render(
			<I18nProvider
				autoLocalizeDom={false}
				initialLocale={locale}
				initialPackId={null}
			>
				<FileSections
					device={device}
					files={files}
					fitStyle={() => ({ className: "", dot: "" })}
					friendly={false}
					InstallButton={({ children }) => (
						<button type="button">{children}</button>
					)}
					install={async () => undefined}
					installing={null}
					uninstall={async () => undefined}
					uninstalling={null}
				/>
			</I18nProvider>
		);
	});
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
	return plain(node.textContent ?? "");
}

describe("model file sizes", () => {
	test("read in English exactly as Core words them", async () => {
		const text = await renderFiles("en", [
			file({ filename: "added-Q8_0.gguf", installed: true, quant: "Q8_0" }),
			file({}),
		]);
		expect(text).toContain("Q8_04.9 GB");
		expect(text).toContain("Q4_K_M4.9 GB");
	});

	test("use the German decimal mark for added files and download options", async () => {
		registerLiteralCatalogLoader(() => ({}));
		const text = await renderFiles("de", [
			file({ filename: "added-Q8_0.gguf", installed: true, quant: "Q8_0" }),
			file({}),
		]);
		expect(text).toContain("Q8_04,9 GB");
		expect(text).toContain("Q4_K_M4,9 GB");
		expect(text).not.toContain("4.9 GB");
	});

	test("fall back to Core's string without a byte count", async () => {
		const text = await renderFiles("de", [
			file({ sizeBytes: null, sizeHuman: "4.9 GB" }),
		]);
		expect(text).toContain("Q4_K_M4.9 GB");
	});
});

const GERMAN_PACK: Record<string, string> = {
	"{diskFree} free disk": "{diskFree} freier Speicher",
	"{ram} system RAM": "{ram} Arbeitsspeicher",
	"{vram} GPU RAM": "{vram} GPU-Speicher",
};

const german = {
	direction: "ltr" as const,
	locale: "de",
	translate(id: string, values?: MessageValuesInput, fallback?: string) {
		const source = fallback ?? id;
		return formatMessage(GERMAN_PACK[source] ?? source, values, "de");
	},
};

describe("deviceSummaryLines under a German UI", () => {
	afterEach(() => {
		unregisterActiveI18nRuntime(german);
	});

	test("words every byte count with the German decimal mark", () => {
		registerActiveI18nRuntime(german);
		expect(deviceSummaryLines(device).map(plain)).toEqual([
			"RTX 4090",
			"4,3 GB GPU-Speicher",
			"15,5 GB Arbeitsspeicher",
			"120 GB freier Speicher",
		]);
	});

	test("keeps Core's strings when the byte counts are missing", () => {
		registerActiveI18nRuntime(german);
		expect(
			deviceSummaryLines({
				...device,
				diskFreeBytes: null,
				totalRamBytes: null,
				vramBytes: null,
			})
		).toEqual([
			"RTX 4090",
			"4.3 GB GPU-Speicher",
			"15.5 GB Arbeitsspeicher",
			"120 GB freier Speicher",
		]);
	});
});
