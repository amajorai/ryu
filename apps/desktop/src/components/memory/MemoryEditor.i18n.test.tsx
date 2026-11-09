import { afterAll, afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { Memory } from "@/src/lib/api/memory.ts";

// Keep Bun's own network stack across DOM registration: the editor saves to a
// real HTTP peer below, not a mocked API module.
const nativeFetch = globalThis.fetch;
const NativeResponse = globalThis.Response;
const NativeAbortController = globalThis.AbortController;
const NativeAbortSignal = globalThis.AbortSignal;
if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
globalThis.fetch = nativeFetch;
globalThis.AbortController = NativeAbortController;
globalThis.AbortSignal = NativeAbortSignal;
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { I18nProvider } = await import("@ryu/i18n/react");
const { registerLiteralCatalogLoader } = await import("@ryu/i18n/core");
const { MemoryEditor } = await import("./MemoryEditor.tsx");

const FALLBACK_JA = "このメモリを保存できませんでした。";
const JA: Record<string, string> = {
	"Failed to save this memory.": FALLBACK_JA,
};

// Core refuses every save; the "refusal" memory id carries a readable reason.
const core = Bun.serve({
	port: 0,
	fetch(request) {
		const { pathname } = new URL(request.url);
		if (pathname === "/api/memory/refusal") {
			return NativeResponse.json(
				{ error: "このメモリは長すぎます。" },
				{ status: 400 }
			);
		}
		return new NativeResponse("", { status: 400 });
	},
});

afterAll(() => {
	core.stop(true);
});

afterEach(() => {
	registerLiteralCatalogLoader(null);
	document.body.innerHTML = "";
});

function memory(id: string): Memory {
	return {
		authorAgentId: null,
		category: "preference",
		content: "Prefers metric units.",
		createdAt: 1,
		id,
		importance: 3,
		lifecycle: "active",
		scope: "user",
		scopeId: null,
		sensitiveTopics: [],
		tags: [],
		updatedAt: 1,
		whenToUse: null,
	};
}

async function saveInJapanese(id: string): Promise<string> {
	registerLiteralCatalogLoader((locale) => (locale.startsWith("ja") ? JA : {}));
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	await act(async () => {
		root.render(
			<I18nProvider
				autoLocalizeDom={false}
				initialLocale="ja"
				initialPackId={null}
				manageDocument={false}
			>
				<MemoryEditor
					memory={memory(id)}
					onClose={() => undefined}
					onSaved={() => undefined}
					open
					target={{ token: null, url: core.url.origin }}
				/>
			</I18nProvider>
		);
	});
	const form = document.querySelector("form");
	if (!form) {
		throw new Error("The memory editor form did not render");
	}
	await act(async () => {
		form.requestSubmit();
	});
	for (let attempt = 0; attempt < 50; attempt += 1) {
		if (document.querySelector("p.text-status-destructive")) {
			break;
		}
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 20));
		});
	}
	const text = document.body.textContent ?? "";
	await act(async () => root.unmount());
	return text;
}

test("a refused save without a reason shows the localized fallback", async () => {
	const text = await saveInJapanese("plain");
	expect(text).toContain(FALLBACK_JA);
	expect(text).not.toContain("/api/memory");
	expect(text).not.toContain("failed: 400");
});

test("a refused save shows Core's reason, not the request path", async () => {
	const text = await saveInJapanese("refusal");
	expect(text).toContain("このメモリは長すぎます。");
	expect(text).not.toContain("/api/memory");
});
