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
const { LaunchContextHardwareGroup } = await import(
	"./ModelLaunchConfigSection-hardware.tsx"
);
const { launchNumberError } = await import(
	"./ModelLaunchConfigSection-rules.ts"
);

import type { LaunchFieldsApi } from "./ModelLaunchConfigSection-rules.ts";

// The CPU thread-count field was labelled with the bare "Threads" key, which
// most of the app uses for conversation threads ("Беседы" in Russian), so a
// launch setting read as a chat feature. It now has its own "CPU threads" key.
const RU: Record<string, string> = {
	"CPU threads": "Потоки",
	Threads: "Беседы",
	"{label} must be a whole number.": "{label}: нужно целое число.",
};

const FIELDS: LaunchFieldsApi = {
	bool: () => undefined,
	num: () => undefined,
	set: () => undefined,
	setNumber: () => undefined,
	str: () => undefined,
};

const ENGINES = {
	llamaCppEngine: false,
	meshLlmEngine: false,
	mlxServeEngine: false,
	ollamaEngine: false,
	sglangEngine: false,
	vllmEngine: false,
	whisperEngine: false,
};

async function labelsInRussian(
	engine: keyof typeof ENGINES
): Promise<{ labels: string[]; unmount: () => Promise<void> }> {
	registerLiteralCatalogLoader((locale) => (locale.startsWith("ru") ? RU : {}));
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	await act(async () => {
		root.render(
			<I18nProvider initialLocale="ru" initialPackId={null}>
				<LaunchContextHardwareGroup
					fields={FIELDS}
					{...ENGINES}
					{...{ [engine]: true }}
				/>
			</I18nProvider>
		);
	});
	// Let the catalog load and the DOM localizer pass settle.
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 50));
	});
	const labels = Array.from(container.querySelectorAll("label"), (label) =>
		(label.textContent ?? "").trim()
	);
	return {
		labels,
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

test("the llama.cpp thread count reads as CPU threads in Russian", async () => {
	const { labels, unmount } = await labelsInRussian("llamaCppEngine");
	expect(labels).toContain("Потоки");
	expect(labels).not.toContain("Беседы");
	await unmount();
});

test("the whisper thread count reads as CPU threads in Russian", async () => {
	const { labels, unmount } = await labelsInRussian("whisperEngine");
	expect(labels).toContain("Потоки");
	expect(labels).not.toContain("Беседы");
	await unmount();
});

test("a thread-count error names the CPU threads field", () => {
	const message = launchNumberError(
		"threads",
		1.5,
		undefined,
		(source, values) => formatMessage(source, values)
	);
	expect(message).toBe("CPU threads must be a whole number.");
});

test("a thread-count error names the CPU threads field in Russian", () => {
	const message = launchNumberError(
		"threads",
		1.5,
		undefined,
		(source, values) => formatMessage(RU[source] ?? source, values)
	);
	expect(message).toBe("Потоки: нужно целое число.");
});
