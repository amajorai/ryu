import { afterAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { LanguagePack } from "@ryu/i18n";
import { I18nProvider, useI18n } from "@ryu/i18n/react";
import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";

const nativeFetch = globalThis.fetch;
const NativeResponse = globalThis.Response;
if (globalThis.document === undefined) {
	GlobalRegistrator.register();
}
globalThis.fetch = nativeFetch;
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const { useNodeStore } = await import("@/src/store/useNodeStore.ts");
const { setLanguageMode } = await import("@/src/hooks/useLanguageMode.ts");
const { UiLanguagePreferenceSync } = await import(
	"./UiLanguagePreferenceSync.tsx"
);

const pack: LanguagePack = {
	schemaVersion: 1,
	id: "coverage/sync",
	name: "Sync",
	version: "1.0.0",
	locale: "es",
	baseLocale: "en",
	direction: "ltr",
	messages: {},
};
let stored: string | null = null;
const writes: string[] = [];
const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	async fetch(request) {
		if (new URL(request.url).pathname !== "/api/preferences/ui-language") {
			return new NativeResponse("wrong route", { status: 404 });
		}
		if (request.method === "PUT") {
			const body = (await request.json()) as { value: string };
			stored = body.value;
			writes.push(body.value);
			return NativeResponse.json({ ok: true });
		}
		return NativeResponse.json({ key: "ui-language", value: stored });
	},
});
afterAll(() => server.stop(true));

let select: ((id: string | null) => void) | null = null;
function Picker() {
	const { selectPack } = useI18n();
	useEffect(() => {
		select = selectPack;
	}, [selectPack]);
	return null;
}

async function settle(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 100 && !predicate(); attempt += 1) {
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 10));
		});
	}
}

test("Desktop's language choice is mirrored to the Island's ui-language preference", async () => {
	useNodeStore.setState({
		autoSelect: false,
		defaultNode: "fixture",
		nodes: [
			{ name: "fixture", url: server.url.origin, token: "fixture-token" },
		],
	});
	setLanguageMode("auto");
	const element = document.createElement("div");
	document.body.append(element);
	const root = createRoot(element);
	await act(async () => {
		root.render(
			<I18nProvider initialPackId={null} packs={[pack]}>
				<UiLanguagePreferenceSync />
				<Picker />
			</I18nProvider>
		);
	});
	await settle(() => writes.length === 1);
	expect(JSON.parse(writes[0] ?? "null")).toEqual({
		mode: "auto",
		packId: null,
	});

	await act(async () => {
		setLanguageMode("fixed");
		select?.(pack.id);
	});
	await settle(() => writes.length === 2);
	expect(JSON.parse(stored ?? "null")).toEqual({
		mode: "fixed",
		packId: pack.id,
	});
	await act(async () => root.unmount());
	element.remove();
});
