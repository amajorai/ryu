import { afterAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
	LANGUAGE_PACK_STORAGE_KEY,
	LANGUAGE_PACKS_CHANGED_EVENT,
	type LanguagePack,
	languagePackArchive,
	parseLanguagePackArchive,
} from "@ryu/i18n";
import { useI18n } from "@ryu/i18n/react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Node } from "@/src/store/useNodeStore.ts";

const nativeFetch = globalThis.fetch;
const NativeResponse = globalThis.Response;
const NativeRequest = globalThis.Request;
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

const initialArchive = languagePackArchive({
	schemaVersion: 1,
	id: "coverage/catalog-replacement",
	name: "Initial Spanish catalog",
	version: "1.0.0",
	locale: "es",
	baseLocale: "en",
	direction: "ltr",
	messages: { "common.install": "Instalar la versión original" },
});
const initialPack = parseLanguagePackArchive(initialArchive);
const replacementArchive = languagePackArchive({
	...initialPack,
	name: "Replacement Arabic catalog",
	locale: "ar",
	direction: "rtl",
	messages: { "common.install": "تثبيت النسخة المعدلة" },
});
const replacementPack = parseLanguagePackArchive(replacementArchive);
const unrelated: LanguagePack = {
	...initialPack,
	id: "coverage/unchanged-catalog",
	name: "Unchanged catalog",
	enabled: false,
};
const digest = (archive: Uint8Array) =>
	new Bun.CryptoHasher("sha256").update(archive).digest("hex");
let catalog = [{ ...initialPack, enabled: true }, { ...unrelated }];
let revision = 0;
let writes = 0;
const unexpected: string[] = [];
const runtimeErrors: string[] = [];
const onWindowError = (event: ErrorEvent) => runtimeErrors.push(event.message);
const onWindowRejection = (event: PromiseRejectionEvent) =>
	runtimeErrors.push(String(event.reason));
window.addEventListener("error", onWindowError);
window.addEventListener("unhandledrejection", onWindowRejection);
const reads: Array<{ body: string; revision: string }> = [];
const producerCalls: Array<{
	method: string;
	url: string;
	body: unknown;
	bearer: string | null;
	delegation: string | null;
	buyer: string | null;
}> = [];
function packageRecord(archive: Uint8Array) {
	const pack = parseLanguagePackArchive(archive);
	return {
		id: pack.id,
		kind: "language_pack",
		version: pack.version,
		enabled: true,
		package_digest: digest(archive),
		runtime_ids: [],
		installed_at_unix_ms: 1_791_504_000_000,
	};
}
const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	maxRequestBodySize: 1024,
	async fetch(request) {
		const url = new URL(request.url);
		const raw = await request.text();
		const bearer = request.headers.get("authorization");
		const delegation = request.headers.get("x-ryu-user-jwt");
		const buyer = request.headers.get("x-ryu-buyer-token");
		if (
			url.search !== "" ||
			bearer !== "Bearer replacement-node-token" ||
			delegation !== "replacement-node-jwt"
		) {
			unexpected.push(
				`admission ${request.method} ${url.href} ${bearer} ${delegation}`
			);
			return NativeResponse.json(
				{ error: "fixture admission refused" },
				{ status: 401 }
			);
		}
		if (
			url.pathname === "/api/language-packs/installed" &&
			request.method === "GET" &&
			raw === "" &&
			buyer === null
		) {
			return NativeResponse.json(
				{ packs: catalog },
				{ headers: { "x-proof-catalog-revision": String(revision) } }
			);
		}
		// Core's explicit update=true producer permits replacing an existing
		// package with the same version; ordinary duplicate import is refused.
		if (
			url.pathname === "/api/marketplace/packages/update" &&
			request.method === "POST"
		) {
			let body: unknown;
			try {
				body = JSON.parse(raw);
			} catch {
				body = null;
			}
			producerCalls.push({
				method: request.method,
				url: request.url,
				body,
				bearer,
				delegation,
				buyer,
			});
			if (
				!body ||
				typeof body !== "object" ||
				Array.isArray(body) ||
				Object.keys(body).length !== 3 ||
				Reflect.get(body, "kind") !== "language_pack" ||
				Reflect.get(body, "id") !== initialPack.id ||
				Reflect.get(body, "version") !== initialPack.version ||
				buyer !== "replacement-buyer" ||
				request.headers.get("content-type") !== "application/json"
			) {
				unexpected.push(`update body ${raw} buyer ${buyer}`);
				return NativeResponse.json(
					{ error: "fixture update refused" },
					{ status: 422 }
				);
			}
			const acknowledged = parseLanguagePackArchive(replacementArchive);
			catalog = [{ ...acknowledged, enabled: true }, { ...unrelated }];
			revision += 1;
			writes += 1;
			return NativeResponse.json({
				success: true,
				package: packageRecord(replacementArchive),
			});
		}
		unexpected.push(`${request.method} ${url.pathname} ${raw}`);
		return NativeResponse.json(
			{ error: "undeclared fixture route" },
			{ status: 404 }
		);
	},
});
NativeResponse.prototype.text = async function (this: Response) {
	const body = await nativeText.call(this);
	const revision = this.headers.get("x-proof-catalog-revision");
	if (revision !== null) {
		reads.push({ body, revision });
	}
	return body;
};
// Preserve the genuine Bun transport for the one owned HTTP peer. A wrongly
// addressed client must fail closed, rather than reaching an unowned service.
globalThis.fetch = Object.assign(
	async (
		input: Parameters<typeof nativeFetch>[0],
		init?: Parameters<typeof nativeFetch>[1]
	) => {
		const requested =
			input instanceof NativeRequest ? input.url : String(input);
		let url: URL;
		try {
			url = new URL(requested);
		} catch {
			unexpected.push(`invalid destination ${requested}`);
			return NativeResponse.json(
				{ error: "invalid fixture destination" },
				{ status: 403 }
			);
		}
		if (url.origin !== server.url.origin) {
			unexpected.push(`unowned destination ${url.href}`);
			return NativeResponse.json(
				{ error: "unowned fixture destination" },
				{ status: 403 }
			);
		}
		return nativeFetch(input, init);
	},
	nativeFetch
);
const { TOKEN_KEY } = await import("@/lib/auth-client.ts");
const { useNodeStore } = await import("@/src/store/useNodeStore.ts");
const { LANGUAGE_MODE_KEY, readLanguageMode, setLanguageMode } = await import(
	"@/src/hooks/useLanguageMode.ts"
);
const { toTarget } = await import("@/src/lib/api/client.ts");
const { installPortablePackage } = await import("@/src/lib/api/marketplace.ts");
const { LanguagePackBridge } = await import("./LanguagePackBridge.tsx");
const previousNodeState = useNodeStore.getState();
const previousLanguageMode = readLanguageMode();
const previousStorage = Array.from(
	{ length: localStorage.length },
	(_, index) => {
		const key = localStorage.key(index)!;
		return [key, localStorage.getItem(key)!] as const;
	}
);
const previousDocument = {
	lang: document.documentElement.getAttribute("lang"),
	dir: document.documentElement.getAttribute("dir"),
	locale: document.documentElement.style.getPropertyValue("--ryu-locale"),
};
let root: Root | null = null;
let container: HTMLDivElement | null = null;
function Consumer() {
	const { locale, selectedPackId, t } = useI18n();
	return (
		<>
			<input
				aria-label="Unsent catalog replacement draft"
				defaultValue="retained unsent words"
			/>
			<button data-raw-catalog-control="" data-ryu-i18n="on">
				Install
			</button>
			<output data-selected-pack={selectedPackId ?? ""}>
				{locale}:{t("common.install")}
			</output>
		</>
	);
}
async function settle(predicate: () => boolean) {
	for (let attempt = 0; attempt < 150 && !predicate(); attempt += 1) {
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 10));
		});
	}
	// biome-ignore lint/suspicious/noMisplacedAssertion: settle runs only inside this file's real bun:test cases and fails the awaiting case on timeout.
	expect(predicate()).toBe(true);
}
async function unmount() {
	if (root) {
		await act(async () => root!.unmount());
	}
	root = null;
	container?.remove();
	container = null;
}
afterAll(async () => {
	try {
		await unmount();
	} finally {
		try {
			await server.stop(true);
		} finally {
			NativeResponse.prototype.text = nativeText;
			globalThis.fetch = nativeFetch;
			window.removeEventListener("error", onWindowError);
			window.removeEventListener("unhandledrejection", onWindowRejection);
			useNodeStore.setState(previousNodeState);
			setLanguageMode(previousLanguageMode);
			localStorage.clear();
			for (const [key, value] of previousStorage) {
				localStorage.setItem(key, value);
			}
			for (const attribute of ["lang", "dir"] as const) {
				const value = previousDocument[attribute];
				if (value === null) {
					document.documentElement.removeAttribute(attribute);
				} else {
					document.documentElement.setAttribute(attribute, value);
				}
			}
			if (previousDocument.locale) {
				document.documentElement.style.setProperty(
					"--ryu-locale",
					previousDocument.locale
				);
			} else {
				document.documentElement.style.removeProperty("--ryu-locale");
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
	}
	// biome-ignore lint/suspicious/noMisplacedAssertion: afterAll teardown proves every real case retired its listeners and ledgers.
	expect(runtimeErrors).toEqual([]);
	// biome-ignore lint/suspicious/noMisplacedAssertion: afterAll teardown proves every real case retired its listeners and ledgers.
	expect(unexpected).toEqual([]);
});

test("acknowledged same-id/version package update replaces translated catalog content without remounting the draft", async () => {
	const node: Node = {
		name: "catalog-replacement",
		url: server.url.origin,
		token: "replacement-node-token",
		userJwt: "replacement-node-jwt",
	};
	localStorage.clear();
	localStorage.setItem(TOKEN_KEY, "replacement-buyer");
	localStorage.setItem(LANGUAGE_PACK_STORAGE_KEY, initialPack.id);
	localStorage.setItem("ryu:timezone", "Asia/Tokyo");
	localStorage.setItem("replacement-unrelated", "preserved");
	setLanguageMode("fixed");
	useNodeStore.setState({
		autoSelect: false,
		defaultNode: node.name,
		nodes: [node],
	});
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container, {
		onCaughtError: (error) => runtimeErrors.push(String(error)),
		onUncaughtError: (error) => runtimeErrors.push(String(error)),
	});
	try {
		await act(async () =>
			root!.render(
				<LanguagePackBridge>
					<Consumer />
				</LanguagePackBridge>
			)
		);
		await settle(
			() =>
				container!.querySelector("output")?.textContent ===
				"es:Instalar la versión original"
		);
		const raw = container.querySelector<HTMLButtonElement>(
			"[data-raw-catalog-control]"
		)!;
		await settle(() => raw.textContent === "Instalar la versión original");
		expect(reads.map((read) => read.revision)).toEqual(["0"]);
		const draft = container.querySelector<HTMLInputElement>("input")!;
		draft.focus();
		const selectionKeys = {
			mode: localStorage.getItem(LANGUAGE_MODE_KEY),
			pack: localStorage.getItem(LANGUAGE_PACK_STORAGE_KEY),
		};
		const acknowledged = await installPortablePackage(
			toTarget(node),
			{
				kind: "language_pack",
				id: initialPack.id,
			},
			{ update: true, version: initialPack.version }
		);
		expect(acknowledged).toEqual(packageRecord(replacementArchive));
		expect(initialPack.id).toBe(replacementPack.id);
		expect(initialPack.version).toBe(replacementPack.version);
		expect(digest(initialArchive)).not.toBe(digest(replacementArchive));
		expect(writes).toBe(1);
		expect(producerCalls).toEqual([
			{
				method: "POST",
				url: `${server.url.origin}/api/marketplace/packages/update`,
				body: {
					kind: "language_pack",
					id: initialPack.id,
					version: initialPack.version,
				},
				bearer: "Bearer replacement-node-token",
				delegation: "replacement-node-jwt",
				buyer: "replacement-buyer",
			},
		]);
		await act(async () =>
			window.dispatchEvent(new window.Event(LANGUAGE_PACKS_CHANGED_EVENT))
		);
		await settle(() => reads.some((read) => read.revision === "1"));
		expect(
			JSON.parse(reads.find((read) => read.revision === "1")!.body)
		).toEqual({
			packs: [{ ...replacementPack, enabled: true }, unrelated],
		});
		// The real client has consumed the new body. Flush its parser and React
		// publication before asserting the selected consumer and static DOM.
		await act(async () => {
			await Promise.resolve();
		});
		expect(runtimeErrors).toEqual([]);
		expect(unexpected).toEqual([]);
		expect(container.querySelector("output")!.textContent).toBe(
			"ar:تثبيت النسخة المعدلة"
		);
		await settle(() => raw.textContent === "تثبيت النسخة المعدلة");
		expect(container.querySelector("output")!.dataset.selectedPack).toBe(
			initialPack.id
		);
		expect(document.documentElement.lang).toBe("ar");
		expect(document.documentElement.dir).toBe("rtl");
		expect(container.querySelector("input")).toBe(draft);
		expect(draft.value).toBe("retained unsent words");
		expect(document.activeElement).toBe(draft);
		expect(container.querySelector("[data-raw-catalog-control]")).toBe(raw);
		expect(localStorage.getItem(LANGUAGE_MODE_KEY)).toBe(selectionKeys.mode);
		expect(localStorage.getItem(LANGUAGE_PACK_STORAGE_KEY)).toBe(
			selectionKeys.pack
		);
		expect(localStorage.getItem("replacement-unrelated")).toBe("preserved");
		expect(localStorage.getItem("ryu:timezone")).toBe("Asia/Tokyo");
		expect(catalog[1]).toEqual(unrelated);
		expect(unexpected).toEqual([]);
	} finally {
		await unmount();
	}
});
