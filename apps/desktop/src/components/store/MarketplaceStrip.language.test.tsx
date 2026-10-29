// biome-ignore-all lint/suspicious/noMisplacedAssertion: Shared mount/settle/conservation helpers run only inside this file's real bun:test cases and afterEach.
import { afterAll, afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
	LANGUAGE_PACK_STORAGE_KEY,
	type LanguagePack,
	languagePackArchive,
	parseLanguagePackArchive,
} from "@ryu/i18n";
import { useI18n } from "@ryu/i18n/react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import type { PortablePackageState } from "@/src/lib/api/marketplace.ts";
import type { Node } from "@/src/store/useNodeStore.ts";

// Retain Bun's actual network stack across DOM registration. These are HTTP
// protocol peers, not replacements for the Marketplace host or business hooks.
const nativeFetch = globalThis.fetch;
const NativeResponse = globalThis.Response;
const nativeText = NativeResponse.prototype.text;
const ownsDomRegistration = globalThis.document === undefined;
const NativeAbortController = globalThis.AbortController;
const NativeAbortSignal = globalThis.AbortSignal;
if (ownsDomRegistration) {
	GlobalRegistrator.register();
}
// Bun's native fetch only accepts the runtime's own abort signals, not
// happy-dom's, and the shipping clients hand it the caller's signal.
globalThis.AbortController = NativeAbortController;
globalThis.AbortSignal = NativeAbortSignal;
globalThis.fetch = nativeFetch;
const previousActFlag = Object.getOwnPropertyDescriptor(
	globalThis,
	"IS_REACT_ACT_ENVIRONMENT"
);
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const previousNavigatorLanguage = Object.getOwnPropertyDescriptor(
	navigator,
	"language"
);
Object.defineProperty(navigator, "language", {
	configurable: true,
	value: "en-US",
});

const archive = languagePackArchive({
	schemaVersion: 1,
	id: "coverage/market-language",
	name: "Marketplace French",
	version: "1.0.0",
	locale: "fr",
	baseLocale: "en",
	direction: "ltr",
	messages: { "common.install": "Installer réellement" },
});
const pack: LanguagePack = parseLanguagePackArchive(archive);
const archiveDigest = `sha256:${new Bun.CryptoHasher("sha256").update(archive).digest("hex")}`;
const unrelated: LanguagePack = {
	...pack,
	id: "coverage/retained-language",
	name: "Retained language",
	enabled: false,
};
type Owner = "a" | "b";
interface NodeState {
	packages: PortablePackageState[];
	packs: LanguagePack[];
}
interface Receipt {
	bearer: string | null;
	buyer: string | null;
	delegation: string | null;
	method: string;
	url: string;
}
const receipts: Receipt[] = [];
const catalogBodyReads: string[] = [];
const unexpected: string[] = [];
let states: Record<Owner, NodeState>;
let heldReply: (() => void) | null = null;
let holdFinalRead = false;
let finalBodyReads = 0;
let installWrites = 0;
let enableWrites = 0;
const allowed = new Set<string>();
const portable = (id: string, enabled: boolean): PortablePackageState => ({
	id,
	enabled,
	kind: "language_pack",
	installed_at_unix_ms: 1_791_504_000_000,
	package_digest: archiveDigest,
	version: "1.0.0",
});
const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	async fetch(request) {
		const url = new URL(request.url);
		const bearer = request.headers.get("authorization");
		const delegation = request.headers.get("x-ryu-user-jwt");
		const buyer = request.headers.get("x-ryu-buyer-token");
		receipts.push({
			url: request.url,
			method: request.method,
			bearer,
			delegation,
			buyer,
		});
		const rawBody = await request.text();
		if (url.pathname.startsWith("/api/marketplace/")) {
			if (
				bearer !== "Bearer marketplace-account" ||
				delegation !== null ||
				buyer !== null ||
				rawBody !== ""
			) {
				unexpected.push(
					`control admission/body ${bearer} ${delegation} ${buyer} ${rawBody}`
				);
				return NativeResponse.json(
					{ error: "account admission refused" },
					{ status: 401 }
				);
			}
			if (
				url.pathname === "/api/marketplace/licenses" &&
				request.method === "GET" &&
				url.search === ""
			) {
				return NativeResponse.json({ licenses: [] });
			}
			if (
				url.pathname === "/api/marketplace/catalog" &&
				request.method === "GET" &&
				url.search === "?kind=language_pack"
			) {
				return NativeResponse.json({
					items: [
						{
							id: pack.id,
							kind: "language_pack",
							name: pack.name,
							author: null,
							category: null,
							description: "A portable language pack",
							firstParty: false,
							iconUrl: null,
							installSource: null,
							pricing: null,
							ratingAverage: 0,
							ratingCount: 0,
							version: pack.version,
							likeCount: 0,
							likedByMe: false,
						},
					],
				});
			}
			unexpected.push(`${request.method} ${url.pathname}${url.search}`);
			return new NativeResponse("unexpected control route", { status: 404 });
		}
		const owner = url.pathname.startsWith("/a/")
			? "a"
			: url.pathname.startsWith("/b/")
				? "b"
				: null;
		if (!(owner && allowed.has(`${owner}|${bearer}|${delegation}`))) {
			unexpected.push(`node admission ${url.pathname} ${bearer} ${delegation}`);
			return NativeResponse.json(
				{ error: "node admission refused" },
				{ status: 401 }
			);
		}
		const state = states[owner];
		const route = url.pathname.slice(2);
		if (url.search !== "") {
			unexpected.push(`undeclared node query ${url.pathname}${url.search}`);
			return NativeResponse.json(
				{ error: "node query refused" },
				{ status: 422 }
			);
		}
		const isInstall =
			route === "/api/marketplace/packages/install" &&
			request.method === "POST";
		if (!isInstall && (rawBody !== "" || buyer !== null)) {
			unexpected.push(
				`undeclared node body/buyer ${url.pathname} ${rawBody} ${buyer}`
			);
			return NativeResponse.json(
				{ error: "node body or buyer refused" },
				{ status: 422 }
			);
		}
		if (route === "/api/language-packs/installed" && request.method === "GET") {
			return NativeResponse.json(
				{ packs: state.packs },
				{
					headers: {
						"x-proof-catalog-owner": `${owner}|${bearer}|${delegation}`,
					},
				}
			);
		}
		if (
			route === "/api/marketplace/packages/installed" &&
			request.method === "GET"
		) {
			const payload = JSON.stringify({ packages: state.packages });
			if (
				owner === "a" &&
				holdFinalRead &&
				installWrites > 0 &&
				enableWrites > 0
			) {
				holdFinalRead = false;
				return await new Promise<Response>((resolve) => {
					heldReply = () =>
						resolve(
							new NativeResponse(payload, {
								headers: {
									"content-type": "application/json",
									"x-proof-final-read": "1",
								},
							})
						);
				});
			}
			return new NativeResponse(payload, {
				headers: { "content-type": "application/json" },
			});
		}
		if (isInstall) {
			let body: unknown;
			try {
				body = JSON.parse(rawBody);
			} catch {
				body = null;
			}
			if (
				!body ||
				typeof body !== "object" ||
				Array.isArray(body) ||
				Object.keys(body).length !== 2 ||
				Reflect.get(body, "id") !== pack.id ||
				Reflect.get(body, "kind") !== "language_pack" ||
				buyer !== "marketplace-account"
			) {
				unexpected.push(`install request ${rawBody} ${buyer}`);
				return NativeResponse.json(
					{ error: "install request refused" },
					{ status: 422 }
				);
			}
			installWrites += 1;
			state.packages.push(portable(pack.id, false));
			state.packs.push({ ...pack, enabled: false });
			return NativeResponse.json({
				success: true,
				package: state.packages.at(-1),
			});
		}
		if (
			route ===
				`/api/marketplace/packages/language_pack/${encodeURIComponent(pack.id)}/enable` &&
			request.method === "POST"
		) {
			enableWrites += 1;
			state.packages = state.packages.map((value) =>
				value.id === pack.id ? { ...value, enabled: true } : value
			);
			state.packs = state.packs.map((value) =>
				value.id === pack.id ? { ...value, enabled: true } : value
			);
			return NativeResponse.json({
				success: true,
				package: state.packages.find((value) => value.id === pack.id),
			});
		}
		unexpected.push(`${request.method} ${url.pathname}`);
		return new NativeResponse("unexpected node route", { status: 404 });
	},
});
// Observe the genuine client's last awaited response, delegating byte-for-byte.
// This receipt is consumed in both the original and retired-operation paths.
NativeResponse.prototype.text = async function (this: Response) {
	const body = await nativeText.call(this);
	if (this.headers.get("x-proof-final-read") === "1") {
		finalBodyReads += 1;
	}
	const catalogOwner = this.headers.get("x-proof-catalog-owner");
	if (catalogOwner) {
		catalogBodyReads.push(catalogOwner);
	}
	return body;
};
const previousBackend = process.env.VITE_APP_BACKEND_URL;
process.env.VITE_APP_BACKEND_URL = server.url.origin;
const { BACKEND_URL, TOKEN_KEY, vaultHydrated } = await import(
	"@/lib/auth-client.ts"
);
// The production auth client migrates a legacy single token into its vault only
// after the startup Tauri-store probe reaches its bridge deadline. Finish that
// startup step before the fixture seeds the account token; otherwise the strict
// request ledger records a genuine but timing-dependent profile enrichment.
await vaultHydrated;
const { useNodeStore } = await import("@/src/store/useNodeStore.ts");
const { LANGUAGE_MODE_KEY, setLanguageMode, useLanguageMode } = await import(
	"@/src/hooks/useLanguageMode.ts"
);
const { DesktopMarketplaceHost } = await import("../marketplace/host.tsx");
const { LanguagePackBridge } = await import("../LanguagePackBridge.tsx");
const { default: MarketplaceStrip } = await import("./MarketplaceStrip.tsx");
const { SkillDistributionProvider } = await import(
	"../skills/SkillDistributionProvider.tsx"
);

let root: Root | null = null;
let element: HTMLDivElement | null = null;
function Consumer() {
	const { availablePacks, locale, selectedPackId, t } = useI18n();
	const [mode] = useLanguageMode();
	return (
		<>
			<output
				data-catalog={availablePacks.map((value) => value.name).join("|")}
				data-locale={locale}
				data-market-language=""
				data-mode={mode}
				data-pack={selectedPackId ?? ""}
			>
				{t("common.install")}
			</output>
			<input data-retained-draft="" defaultValue="Unsaved marketplace draft" />
		</>
	);
}
function node(
	owner: Owner,
	token = `market-${owner}-token`,
	userJwt = `market-${owner}-jwt`
): Node {
	allowed.add(`${owner}|Bearer ${token}|${userJwt}`);
	return {
		name: `market-${owner}`,
		url: `${server.url.origin}/${owner}`,
		token,
		userJwt,
	};
}
async function setNode(next: Node) {
	await act(async () =>
		useNodeStore.setState({
			autoSelect: false,
			defaultNode: next.name,
			nodes: [next],
		})
	);
}
async function settle(predicate: () => boolean) {
	for (let count = 0; count < 150 && !predicate(); count += 1) {
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 10));
		});
	}
	expect(predicate()).toBe(true);
}
function selection() {
	return element!.querySelector<HTMLOutputElement>("[data-market-language]")!;
}
function installButton() {
	return Array.from(
		element!.querySelectorAll<HTMLButtonElement>("button")
	).find((button) => /^(Install|Enable)$/.test(button.textContent!.trim()))!;
}
async function mount() {
	expect(BACKEND_URL).toBe(server.url.origin);
	element = document.createElement("div");
	document.body.append(element);
	root = createRoot(element);
	const before = receipts.length;
	await act(async () =>
		root!.render(
			<MemoryRouter>
				<LanguagePackBridge>
					<SkillDistributionProvider>
						<DesktopMarketplaceHost>
							<MarketplaceStrip kind="language_pack" />
							<Consumer />
						</DesktopMarketplaceHost>
					</SkillDistributionProvider>
				</LanguagePackBridge>
			</MemoryRouter>
		)
	);
	await settle(
		() =>
			element!.textContent!.includes(pack.name) &&
			receipts
				.slice(before)
				.some((entry) =>
					entry.url.endsWith("/a/api/marketplace/packages/installed")
				)
	);
}
async function unmount() {
	if (root) {
		await act(async () => root!.unmount());
	}
	root = null;
	element?.remove();
	element = null;
}
async function reset() {
	await unmount();
	localStorage.clear();
	localStorage.setItem(TOKEN_KEY, "marketplace-account");
	localStorage.setItem("ryu:timezone", "Asia/Tokyo");
	setLanguageMode("auto");
	states = {
		a: { packages: [portable(unrelated.id, false)], packs: [{ ...unrelated }] },
		b: {
			packages: [portable(unrelated.id, false), portable(pack.id, true)],
			packs: [
				{ ...unrelated },
				{
					...pack,
					locale: "de",
					name: "Node B German",
					messages: { "common.install": "Installieren B" },
					enabled: true,
				},
			],
		},
	};
	receipts.length = 0;
	catalogBodyReads.length = 0;
	unexpected.length = 0;
	allowed.clear();
	holdFinalRead = false;
	heldReply = null;
	finalBodyReads = 0;
	installWrites = 0;
	enableWrites = 0;
	await setNode(node("a"));
}
async function clickInstall() {
	expect(installButton()).toBeDefined();
	await act(async () => installButton().click());
}
async function beginHeldOperation() {
	holdFinalRead = true;
	await clickInstall();
	await settle(() => heldReply !== null);
	expect(installWrites).toBe(1);
	expect(enableWrites).toBe(1);
	expect(states.a.packages.find((value) => value.id === pack.id)?.enabled).toBe(
		true
	);
	return states.a.packages.map((value) => ({ ...value }));
}
async function acknowledgeHeldReply() {
	const before = finalBodyReads;
	expect(heldReply).not.toBeNull();
	const release = heldReply!;
	heldReply = null;
	await act(async () => release());
	await settle(() => finalBodyReads === before + 1);
	// The last body read resumes JSON validation and synchronous publication.
	await act(async () => {
		await Promise.resolve();
	});
}
function expectConserved(
	remote: PortablePackageState[],
	draft: HTMLInputElement
) {
	expect(selection().dataset.mode).toBe("auto");
	expect(selection().dataset.locale).toBe(navigator.language);
	expect(selection().textContent).toBe("Install");
	expect(selection().dataset.pack).toBe("");
	expect(localStorage.getItem(LANGUAGE_PACK_STORAGE_KEY)).toBeNull();
	expect(localStorage.getItem("ryu:timezone")).toBe("Asia/Tokyo");
	expect(states.a.packages).toEqual(remote);
	expect(states.a.packs.find((value) => value.id === unrelated.id)).toEqual(
		unrelated
	);
	expect(element!.querySelector("[data-retained-draft]")).toBe(draft);
	expect(draft.value).toBe("Unsaved marketplace draft");
	expect(document.activeElement).toBe(draft);
	expect(installButton()).toBeDefined();
	expect(installButton().disabled).toBe(false);
	expect(unexpected).toEqual([]);
}
afterEach(async () => {
	if (heldReply) {
		await acknowledgeHeldReply();
	}
	await unmount();
	expect(unexpected).toEqual([]);
});
afterAll(async () => {
	try {
		await server.stop(true);
	} finally {
		NativeResponse.prototype.text = nativeText;
		globalThis.fetch = nativeFetch;
		if (previousNavigatorLanguage) {
			Object.defineProperty(navigator, "language", previousNavigatorLanguage);
		} else {
			Reflect.deleteProperty(navigator, "language");
		}
		if (previousBackend === undefined) {
			delete process.env.VITE_APP_BACKEND_URL;
		} else {
			process.env.VITE_APP_BACKEND_URL = previousBackend;
		}
		if (previousActFlag) {
			Object.defineProperty(
				globalThis,
				"IS_REACT_ACT_ENVIRONMENT",
				previousActFlag
			);
		} else {
			Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
		}
		if (ownsDomRegistration) {
			await GlobalRegistrator.unregister();
		}
	}
});

test("Marketplace language choice commits fixed mode after native install/enable/catalog acknowledgments and survives a remount", async () => {
	await reset();
	await mount();
	expect(selection().dataset.mode).toBe("auto");
	const draft = element!.querySelector<HTMLInputElement>(
		"[data-retained-draft]"
	)!;
	draft.focus();
	await clickInstall();
	await settle(() => selection().dataset.locale === "fr");
	expect(selection().textContent).toBe("Installer réellement");
	expect(installWrites).toBe(1);
	expect(enableWrites).toBe(1);
	expect(
		receipts.filter((entry) =>
			entry.url.endsWith("/a/api/marketplace/packages/install")
		)
	).toEqual([
		{
			url: `${server.url.origin}/a/api/marketplace/packages/install`,
			method: "POST",
			bearer: "Bearer market-a-token",
			delegation: "market-a-jwt",
			buyer: "marketplace-account",
		},
	]);
	expect(localStorage.getItem(LANGUAGE_PACK_STORAGE_KEY)).toBe(pack.id);
	expect(selection().dataset.mode).toBe("fixed");
	expect(localStorage.getItem(LANGUAGE_MODE_KEY)).toBe("fixed");
	expect(element!.querySelector("[data-retained-draft]")).toBe(draft);
	expect(draft.value).toBe("Unsaved marketplace draft");
	expect(document.activeElement).toBe(draft);
	expect(states.a.packs.find((value) => value.id === unrelated.id)).toEqual(
		unrelated
	);
	expect(localStorage.getItem("ryu:timezone")).toBe("Asia/Tokyo");
	await unmount();
	// Fresh genuine module initialization reads durable keys. The producer and
	// remount remain in this JS realm; this assertion does not certify a browser reload.
	const independentlyInitialized = await import(
		`../../hooks/useLanguageMode.ts?marketplace-durable=${Date.now()}`
	);
	expect(independentlyInitialized.readLanguageMode()).toBe("fixed");
	await mount();
	await settle(() => selection().dataset.locale === "fr");
	expect(selection().textContent).toBe("Installer réellement");
	expect(selection().dataset.pack).toBe(pack.id);
	expect(selection().dataset.mode).toBe("fixed");
	expect(installWrites).toBe(1);
	expect(enableWrites).toBe(1);
});

test("Marketplace final acknowledgment from node A cannot select the same-id language from node B", async () => {
	await reset();
	await mount();
	const draft = element!.querySelector<HTMLInputElement>(
		"[data-retained-draft]"
	)!;
	draft.focus();
	const remote = await beginHeldOperation();
	const before = catalogBodyReads.length;
	await setNode(node("b"));
	await settle(
		() =>
			catalogBodyReads
				.slice(before)
				.includes("b|Bearer market-b-token|market-b-jwt") &&
			selection().dataset.catalog?.includes("Node B German") === true &&
			installButton()?.textContent?.trim() === "Enable"
	);
	const nodeB = structuredClone(states.b);
	await acknowledgeHeldReply();
	expectConserved(remote, draft);
	expect(states.b).toEqual(nodeB);
	expect(useNodeStore.getState().getActiveNode().name).toBe("market-b");
	expect(
		receipts
			.filter((entry) => entry.method === "POST")
			.every((entry) => entry.url.startsWith(`${server.url.origin}/a/`))
	).toBe(true);
});

test("Marketplace credential token and delegation ABA each retire the old final acknowledgment", async () => {
	for (const field of ["token", "userJwt"] as const) {
		await reset();
		await mount();
		const draft = element!.querySelector<HTMLInputElement>(
			"[data-retained-draft]"
		)!;
		draft.focus();
		const remote = await beginHeldOperation();
		const original = node("a");
		const rotated = { ...original, [field]: `${original[field]}-rotated` };
		allowed.add(`a|Bearer ${rotated.token}|${rotated.userJwt}`);
		let before = catalogBodyReads.length;
		await setNode(rotated);
		await settle(() =>
			catalogBodyReads
				.slice(before)
				.includes(`a|Bearer ${rotated.token}|${rotated.userJwt}`)
		);
		before = catalogBodyReads.length;
		await setNode(original);
		await settle(
			() =>
				catalogBodyReads
					.slice(before)
					.includes("a|Bearer market-a-token|market-a-jwt") &&
				selection().dataset.catalog?.includes(pack.name) === true
		);
		await acknowledgeHeldReply();
		expectConserved(remote, draft);
		expect(useNodeStore.getState().getActiveNode()).toEqual(original);
		expect(
			receipts
				.filter((entry) => entry.method === "POST")
				.every(
					(entry) =>
						entry.bearer === "Bearer market-a-token" &&
						entry.delegation === "market-a-jwt"
				)
		).toBe(true);
	}
});

test("Marketplace language adoption under refused local storage stays selected for the session without changing durable choices", async () => {
	await reset();
	await mount();
	const draft = element!.querySelector<HTMLInputElement>(
		"[data-retained-draft]"
	)!;
	draft.focus();
	// Refuse only the two language writes, as a quota-limited webview does; any
	// other write still reaches the durable store.
	const durable = localStorage;
	const nativeStorage = Object.getOwnPropertyDescriptor(
		globalThis,
		"localStorage"
	)!;
	const refused: string[] = [];
	Object.defineProperty(globalThis, "localStorage", {
		configurable: true,
		value: new Proxy(durable, {
			get(target, property) {
				if (property === "setItem") {
					return (key: string, value: string) => {
						if (
							key !== LANGUAGE_MODE_KEY &&
							key !== LANGUAGE_PACK_STORAGE_KEY
						) {
							return target.setItem(key, value);
						}
						refused.push(key);
						throw new DOMException("denied", "QuotaExceededError");
					};
				}
				const value = Reflect.get(target, property, target);
				return typeof value === "function" ? value.bind(target) : value;
			},
		}),
	});
	try {
		await clickInstall();
		await settle(() => selection().dataset.locale === "fr");
		expect(selection().textContent).toBe("Installer réellement");
		expect(selection().dataset.mode).toBe("fixed");
		expect(selection().dataset.pack).toBe(pack.id);
		expect(refused).toEqual([LANGUAGE_MODE_KEY, LANGUAGE_PACK_STORAGE_KEY]);
		expect(durable.getItem(LANGUAGE_MODE_KEY)).toBe("auto");
		expect(durable.getItem(LANGUAGE_PACK_STORAGE_KEY)).toBeNull();
		expect(durable.getItem("ryu:timezone")).toBe("Asia/Tokyo");
		expect(installWrites).toBe(1);
		expect(enableWrites).toBe(1);
		expect(
			states.a.packages.find((value) => value.id === pack.id)?.enabled
		).toBe(true);
		expect(states.a.packs.find((value) => value.id === unrelated.id)).toEqual(
			unrelated
		);
		expect(element!.querySelector("[data-retained-draft]")).toBe(draft);
		expect(draft.value).toBe("Unsaved marketplace draft");
		expect(document.activeElement).toBe(draft);
	} finally {
		Object.defineProperty(globalThis, "localStorage", nativeStorage);
	}
	const durableReload = await import(
		`../../hooks/useLanguageMode.ts?marketplace-refused=${Date.now()}`
	);
	expect(durableReload.readLanguageMode()).toBe("auto");
	// Clearing local settings in another window supersedes the unsaved choice.
	localStorage.removeItem(LANGUAGE_MODE_KEY);
	await act(async () =>
		window.dispatchEvent(
			new StorageEvent("storage", { key: null, storageArea: localStorage })
		)
	);
	await settle(() => selection().dataset.mode === "auto");
	expect(selection().textContent).toBe("Install");
	expect(selection().dataset.pack).toBe("");
});
