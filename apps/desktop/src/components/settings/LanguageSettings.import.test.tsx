import { afterAll, afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
	LANGUAGE_PACKS_CHANGED_EVENT,
	type LanguagePack,
	languagePackArchive,
	parseLanguagePackArchive,
} from "@ryu/i18n";
import { useI18n } from "@ryu/i18n/react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";

const nativeFetch = globalThis.fetch;
const NativeResponse = globalThis.Response;
const NativeFile = globalThis.File;
const nativeResponseText = NativeResponse.prototype.text;
let importAcknowledgmentsRead = 0;
// Observe the real SDK transport's body consumption. Negative stale-response
// assertions must await the client, not merely a server release or fixed delay.
NativeResponse.prototype.text = async function (this: Response) {
	const text = await nativeResponseText.call(this);
	if (this.url.endsWith("/api/language-packs/import") && this.ok) {
		importAcknowledgmentsRead += 1;
	}
	return text;
};
const NativeAbortController = globalThis.AbortController;
const NativeAbortSignal = globalThis.AbortSignal;
if (globalThis.document === undefined) {
	GlobalRegistrator.register();
}
// Bun's native fetch only accepts the runtime's own abort signals, not
// happy-dom's, and the shipping clients hand it the caller's signal.
globalThis.AbortController = NativeAbortController;
globalThis.AbortSignal = NativeAbortSignal;
globalThis.fetch = nativeFetch;
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const { useNodeStore } = await import("@/src/store/useNodeStore.ts");
const { setLanguageMode } = await import("@/src/hooks/useLanguageMode.ts");
const { LanguagePackBridge } = await import("../LanguagePackBridge.tsx");
const { LanguageSettings } = await import("./LanguageSettings.tsx");
const imported: LanguagePack = {
	schemaVersion: 1,
	id: "coverage/imported",
	name: "Imported French",
	version: "1.0.0",
	locale: "fr",
	baseLocale: "en",
	direction: "ltr",
	messages: { "common.install": "Installer importé" },
};
const unrelated: LanguagePack = {
	...imported,
	id: "coverage/unrelated",
	name: "Unrelated",
	enabled: false,
};
let catalog = [{ ...unrelated }];
let refused = false;
let holdCatalog = false;
let releaseCatalog: (() => void) | null = null;
let importWrites = 0;
let catalogReads = 0;
let enableWrites = 0;
let holdImport = false;
let releaseImport: (() => void) | null = null;
let archiveBytes = new Uint8Array();
let bearer: string | null = null;
let userJwtHeader: string | null = null;
const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	async fetch(request) {
		bearer = request.headers.get("authorization");
		userJwtHeader = request.headers.get("x-ryu-user-jwt");
		const route = new URL(request.url).pathname;
		if (route === "/api/language-packs/installed") {
			catalogReads += 1;
			if (holdCatalog) {
				holdCatalog = false;
				return new Promise<Response>((resolve) => {
					releaseCatalog = () =>
						resolve(NativeResponse.json({ packs: catalog }));
				});
			}
			return NativeResponse.json({ packs: catalog });
		}
		if (
			route ===
			"/api/marketplace/packages/language_pack/coverage%2Funrelated/enable"
		) {
			enableWrites += 1;
			if (refused) {
				return NativeResponse.json(
					{ error: "enable write refused" },
					{ status: 503 }
				);
			}
			catalog = catalog.map((pack) =>
				pack.id === unrelated.id ? { ...pack, enabled: true } : pack
			);
			return NativeResponse.json({ ok: true });
		}
		if (route !== "/api/language-packs/import" || request.method !== "POST") {
			return new NativeResponse("wrong route", { status: 404 });
		}
		importWrites += 1;
		if (refused) {
			return NativeResponse.json({ error: "write refused" }, { status: 503 });
		}
		const body = (await request.json()) as { archive_base64: string };
		archiveBytes = Uint8Array.from(atob(body.archive_base64), (value) =>
			value.charCodeAt(0)
		);
		let pack: LanguagePack;
		try {
			pack = parseLanguagePackArchive(archiveBytes);
		} catch (error) {
			return NativeResponse.json(
				{ error: `archive rejected: ${String(error)}` },
				{ status: 422 }
			);
		}
		catalog = [
			...catalog.filter((current) => current.id !== pack.id),
			{ ...pack, enabled: true },
		];
		if (holdImport) {
			holdImport = false;
			return new Promise<Response>((resolve) => {
				releaseImport = () => resolve(NativeResponse.json({ pack }));
			});
		}
		return NativeResponse.json({ pack });
	},
});
useNodeStore.setState({
	autoSelect: false,
	defaultNode: "language-settings-proof",
	nodes: [
		{
			name: "language-settings-proof",
			url: server.url.origin,
			token: "language-settings-token",
		},
	],
});
let root: Root | null = null;
let element: HTMLDivElement | null = null;
function Consumer() {
	const { locale, t } = useI18n();
	return (
		<output data-import-consumer="">
			{locale}:{t("common.install")}
		</output>
	);
}
async function settle(predicate: () => boolean) {
	for (let count = 0; count < 100 && !predicate(); count += 1) {
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 10));
		});
	}
	// biome-ignore lint/suspicious/noMisplacedAssertion: settle runs only inside this file's real bun:test cases and fails the awaiting case on timeout.
	expect(predicate()).toBe(true);
}
async function mount() {
	element = document.createElement("div");
	document.body.append(element);
	root = createRoot(element);
	const before = catalogReads;
	await act(async () =>
		root!.render(
			<MemoryRouter>
				<LanguagePackBridge>
					<LanguageSettings />
					<Consumer />
				</LanguagePackBridge>
			</MemoryRouter>
		)
	);
	await settle(
		() => catalogReads > before && element!.textContent!.includes("Unrelated")
	);
}
async function choose(bytes: Uint8Array) {
	const input = element!.querySelector<HTMLInputElement>('input[type="file"]')!;
	const file = new NativeFile([new Uint8Array(bytes)], "proof.ryupack", {
		type: "application/zip",
	});
	Object.defineProperty(input, "files", { configurable: true, value: [file] });
	await act(async () =>
		input.dispatchEvent(new window.Event("change", { bubbles: true }))
	);
}
afterEach(async () => {
	releaseCatalog?.();
	releaseCatalog = null;
	releaseImport?.();
	releaseImport = null;
	holdImport = false;
	if (root) {
		await act(async () => root!.unmount());
	}
	root = null;
	element?.remove();
	element = null;
	localStorage.clear();
	setLanguageMode("auto");
	catalog = [{ ...unrelated }];
	refused = false;
	holdCatalog = false;
});
afterAll(async () => {
	try {
		await server.stop(true);
	} finally {
		NativeResponse.prototype.text = nativeResponseText;
	}
});

test("mounted import rejects invalid archive then selects only after acknowledged catalog reload", async () => {
	setLanguageMode("auto");
	localStorage.setItem("import-unrelated", "preserved");
	await mount();
	const conserved = JSON.stringify(catalog[0]);
	await choose(new Uint8Array([1, 2, 3, 4]));
	await settle(() =>
		element!.textContent!.includes("/api/language-packs/import failed: 422")
	);
	expect(element!.querySelector('[role="alert"]')!.textContent).toBe(
		"/api/language-packs/import failed: 422"
	);
	expect(element!.querySelector("output")!.textContent).toBe("en-US:Install");
	expect(localStorage.getItem("ryu:language-pack")).toBeNull();
	expect(catalog.length).toBe(1);
	expect(JSON.stringify(catalog[0])).toBe(conserved);
	const archive = languagePackArchive(imported);
	holdCatalog = true;
	await choose(archive);
	await settle(() => releaseCatalog !== null);
	expect(
		element!.textContent!.includes("/api/language-packs/import failed: 422")
	).toBe(false);
	expect(element!.querySelector("output")!.textContent).toBe("en-US:Install");
	expect(localStorage.getItem("ryu:language-pack")).toBeNull();
	expect(Array.from(archiveBytes)).toEqual(Array.from(archive));
	expect(bearer).toBe("Bearer language-settings-token");
	await act(async () => {
		releaseCatalog!();
		releaseCatalog = null;
	});
	await settle(
		() =>
			element!.querySelector("output")!.textContent === "fr:Installer importé"
	);
	expect(localStorage.getItem("ryu:language-pack")).toBe(imported.id);
	expect(localStorage.getItem("ryu:language-mode")).toBe("fixed");
	expect(localStorage.getItem("import-unrelated")).toBe("preserved");
	expect(JSON.stringify(catalog[0])).toBe(conserved);
	await act(async () => root!.unmount());
	root = null;
	element!.remove();
	element = null;
	await mount();
	await settle(
		() =>
			element!.querySelector("output")!.textContent === "fr:Installer importé"
	);
	expect(localStorage.getItem("import-unrelated")).toBe("preserved");
});

test("mounted refused import conserves durable selection and allows explicit same-file retry", async () => {
	setLanguageMode("auto");
	localStorage.setItem("import-unrelated", "preserved");
	await mount();
	const archive = languagePackArchive(imported);
	const beforeWrites = importWrites;
	refused = true;
	await choose(archive);
	await settle(() =>
		element!.textContent!.includes("/api/language-packs/import failed: 503")
	);
	expect(element!.querySelector('[role="alert"]')!.textContent).toBe(
		"/api/language-packs/import failed: 503"
	);
	expect(importWrites).toBe(beforeWrites + 1);
	expect(catalog).toEqual([{ ...unrelated }]);
	expect(localStorage.getItem("ryu:language-pack")).toBeNull();
	expect(localStorage.getItem("ryu:language-mode")).toBe("auto");
	expect(localStorage.getItem("import-unrelated")).toBe("preserved");
	expect(element!.querySelector("output")!.textContent).toBe("en-US:Install");
	refused = false;
	await choose(archive);
	await settle(
		() =>
			element!.querySelector("output")!.textContent === "fr:Installer importé"
	);
	expect(importWrites).toBe(beforeWrites + 2);
	expect(
		element!.textContent!.includes("/api/language-packs/import failed: 503")
	).toBe(false);
	expect(localStorage.getItem("ryu:language-pack")).toBe(imported.id);
	expect(JSON.stringify(catalog[0])).toBe(JSON.stringify(unrelated));
	expect(localStorage.getItem("import-unrelated")).toBe("preserved");
});

test("mounted disabled-pack write failure is visible, conserves selection, and retries acknowledged enable", async () => {
	const untouched = {
		...imported,
		id: "coverage/untouched",
		name: "Untouched",
		enabled: false,
	};
	catalog = [{ ...unrelated }, untouched];
	setLanguageMode("auto");
	localStorage.setItem("enable-unrelated", "preserved");
	await mount();
	const selectDisabled = async () => {
		const trigger =
			element!.querySelector<HTMLButtonElement>('[role="combobox"]')!;
		await act(async () => trigger.click());
		await settle(() =>
			Array.from(document.querySelectorAll('[role="option"]')).some(
				(option) => option.textContent === unrelated.name
			)
		);
		const option = Array.from(
			document.querySelectorAll<HTMLElement>('[role="option"]')
		).find((candidate) => candidate.textContent === unrelated.name)!;
		await act(async () => option.click());
	};
	const beforeWrites = enableWrites;
	refused = true;
	await selectDisabled();
	await settle(() => enableWrites === beforeWrites + 1);
	await settle(() =>
		element!.textContent!.includes(
			"/api/marketplace/packages/language_pack/coverage%2Funrelated/enable failed: 503"
		)
	);
	expect(element!.querySelector('[role="alert"]')!.textContent).toBe(
		"/api/marketplace/packages/language_pack/coverage%2Funrelated/enable failed: 503"
	);
	expect(element!.querySelector("output")!.textContent).toBe("en-US:Install");
	expect(localStorage.getItem("ryu:language-pack")).toBeNull();
	expect(localStorage.getItem("ryu:language-mode")).toBe("auto");
	expect(catalog).toEqual([{ ...unrelated }, untouched]);
	expect(localStorage.getItem("enable-unrelated")).toBe("preserved");
	refused = false;
	await selectDisabled();
	await settle(
		() =>
			element!.querySelector("output")!.textContent === "fr:Installer importé"
	);
	expect(enableWrites).toBe(beforeWrites + 2);
	expect(localStorage.getItem("ryu:language-pack")).toBe(unrelated.id);
	expect(element!.textContent!.includes("failed: 503")).toBe(false);
	expect(element!.querySelector('[role="alert"]')).toBeNull();
	expect(catalog.find((pack) => pack.id === untouched.id)).toEqual(untouched);
	expect(localStorage.getItem("enable-unrelated")).toBe("preserved");
});

async function holdAcknowledgedImport() {
	holdImport = true;
	await choose(languagePackArchive(imported));
	await settle(() => releaseImport !== null);
}
async function completeHeldImport() {
	const before = importAcknowledgmentsRead;
	await act(async () => {
		releaseImport!();
		releaseImport = null;
	});
	await settle(() => importAcknowledgmentsRead === before + 1);
}

test("late import acknowledgment from another node cannot select a same-id current-node pack", async () => {
	const originalState = useNodeStore.getState();
	let alternateReads = 0;
	const alternateIdentity = { bearer: "", userJwt: "" };
	const alternatePack = {
		...imported,
		name: "Node B imported",
		locale: "de",
		messages: { "common.install": "Installieren auf Knoten B" },
		enabled: true,
	};
	const conserved = JSON.stringify(alternatePack);
	const alternate = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request) {
			alternateReads += 1;
			alternateIdentity.bearer = request.headers.get("authorization") ?? "";
			alternateIdentity.userJwt = request.headers.get("x-ryu-user-jwt") ?? "";
			return NativeResponse.json({ packs: [alternatePack] });
		},
	});
	try {
		setLanguageMode("auto");
		localStorage.setItem("node-switch-unrelated", "preserved");
		await mount();
		await holdAcknowledgedImport();
		await act(async () =>
			useNodeStore.setState({
				defaultNode: "alternate",
				nodes: [
					{
						name: "alternate",
						url: alternate.url.origin,
						token: "node-B-token",
						userJwt: "user-B-jwt",
					},
				],
			})
		);
		await settle(() => element!.textContent!.includes("Node B imported"));
		expect(element!.querySelector("output")!.textContent).toBe("en-US:Install");
		const acknowledgedAlternateReads = alternateReads;
		await completeHeldImport();
		expect(element!.querySelector("output")!.textContent).toBe("en-US:Install");
		expect(localStorage.getItem("ryu:language-mode")).toBe("auto");
		expect(localStorage.getItem("ryu:language-pack")).toBeNull();
		expect(alternateReads).toBe(acknowledgedAlternateReads);
		expect(alternateIdentity).toEqual({
			bearer: "Bearer node-B-token",
			userJwt: "user-B-jwt",
		});
		expect(JSON.stringify(alternatePack)).toBe(conserved);
		expect(catalog.find((pack) => pack.id === imported.id)?.enabled).toBe(true);
		expect(localStorage.getItem("node-switch-unrelated")).toBe("preserved");
	} finally {
		releaseImport?.();
		releaseImport = null;
		await act(async () => useNodeStore.setState(originalState));
		await alternate.stop(true);
	}
});

test("credential owner rotation and return cannot revive an earlier pending import", async () => {
	const originalState = useNodeStore.getState();
	try {
		// Two configurations of the same ownership assertion independently prove
		// node-token and user-JWT changes; changing both at once cannot do that.
		for (const identity of [
			{ token: "rotated-token", userJwt: null },
			{ token: "language-settings-token", userJwt: "rotated-user-jwt" },
		]) {
			catalog = [{ ...unrelated }];
			setLanguageMode("auto");
			await mount();
			await holdAcknowledgedImport();
			const beforeRotationReads = catalogReads;
			await act(async () =>
				useNodeStore.setState({
					nodes: [
						{
							name: "language-settings-proof",
							url: server.url.origin,
							...identity,
						},
					],
				})
			);
			await settle(
				() =>
					catalogReads > beforeRotationReads &&
					element!.textContent!.includes(imported.name)
			);
			expect(bearer).toBe(`Bearer ${identity.token}`);
			expect(userJwtHeader).toBe(identity.userJwt);
			const rotatedReads = catalogReads;
			await act(async () => useNodeStore.setState(originalState));
			await settle(() => catalogReads > rotatedReads);
			expect(bearer).toBe("Bearer language-settings-token");
			await completeHeldImport();
			expect(element!.querySelector("output")!.textContent).toBe(
				"en-US:Install"
			);
			expect(localStorage.getItem("ryu:language-mode")).toBe("auto");
			expect(localStorage.getItem("ryu:language-pack")).toBeNull();
			await act(async () => root!.unmount());
			root = null;
			element!.remove();
			element = null;
		}
	} finally {
		releaseImport?.();
		releaseImport = null;
		await act(async () => useNodeStore.setState(originalState));
	}
});

test("acknowledged later language choices retire import selection even when mode returns to auto", async () => {
	setLanguageMode("auto");
	await mount();
	await holdAcknowledgedImport();
	await act(async () => setLanguageMode("fixed"));
	await settle(
		() => element!.querySelector("output")!.textContent === "en:Install"
	);
	await act(async () => setLanguageMode("auto"));
	await settle(
		() => element!.querySelector("output")!.textContent === "en-US:Install"
	);
	await completeHeldImport();
	// A real acknowledged refresh is also required: an import's client body
	// can finish before its consequent catalog HTTP request returns. Both old
	// and current implementations must see the imported entry before we assert
	// that the later mode choice still owns selection.
	const beforeRefreshReads = catalogReads;
	await act(async () =>
		window.dispatchEvent(new Event(LANGUAGE_PACKS_CHANGED_EVENT))
	);
	await settle(
		() =>
			catalogReads > beforeRefreshReads &&
			element!.textContent!.includes(imported.name)
	);
	expect(element!.querySelector("output")!.textContent).toBe("en-US:Install");
	expect(localStorage.getItem("ryu:language-mode")).toBe("auto");
	expect(localStorage.getItem("ryu:language-pack")).toBeNull();
	expect(catalog.find((pack) => pack.id === imported.id)?.enabled).toBe(true);
});
