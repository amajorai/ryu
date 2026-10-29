// Actual current-integration regression for retained subscriptions across
// committed runtime replacement. Root StrictMode proves real layout replay;
// duplicate callbacks retain the runtime's native Set cancellation semantics.
// Happy DOM does not establish browser, RPC, CSP or durable Core behavior.
import { afterAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, StrictMode, useLayoutEffect, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
	type I18nHostSnapshot,
	I18nRuntime,
	LANGUAGE_PACK_STORAGE_KEY,
} from "../../../../packages/i18n/src/core.ts";
import { BUILT_IN_LANGUAGE_PACKS } from "../../../../packages/i18n/src/messages.ts";
import { I18nProvider, useI18n } from "../../../../packages/i18n/src/react.tsx";

const ownsDomRegistration = globalThis.document === undefined;
const previousActFlag = Object.getOwnPropertyDescriptor(
	globalThis,
	"IS_REACT_ACT_ENVIRONMENT"
);
const previousFetch = Object.getOwnPropertyDescriptor(globalThis, "fetch");
const nativeFetch = globalThis.fetch;
const translateDescriptor = Object.getOwnPropertyDescriptor(
	I18nRuntime.prototype,
	"translate"
);
if (!translateDescriptor) {
	throw new Error("Actual runtime translation descriptor is unavailable");
}
const nativeTranslate = I18nRuntime.prototype.translate;
if (ownsDomRegistration) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const previousStorage = Array.from(
	{ length: localStorage.length },
	(_, index) => {
		const key = localStorage.key(index);
		if (key === null) {
			throw new Error("Actual storage enumeration lost a key");
		}
		const value = localStorage.getItem(key);
		if (value === null) {
			throw new Error("Actual storage enumeration lost a value");
		}
		return [key, value] as const;
	}
);
const previousDocument = {
	lang: document.documentElement.lang,
	dir: document.documentElement.dir,
	locale: document.documentElement.style.getPropertyValue("--ryu-locale"),
};
const runtimes = new Set<I18nRuntime>();
const runtimeErrors: string[] = [];
const unexpected: string[] = [];
Object.defineProperty(I18nRuntime.prototype, "translate", {
	...translateDescriptor,
	value(this: I18nRuntime, ...args: Parameters<I18nRuntime["translate"]>) {
		runtimes.add(this);
		return Reflect.apply(nativeTranslate, this, args);
	},
});
// The production runtime/provider has no declared HTTP work in this case.
// Refuse undeclared destinations rather than fabricate a business response.
globalThis.fetch = Object.assign(
	async (input: Parameters<typeof nativeFetch>[0]) => {
		const destination = input instanceof Request ? input.url : String(input);
		unexpected.push(`undeclared language lifecycle HTTP ${destination}`);
		throw new Error(`No HTTP peer is declared for ${destination}`);
	},
	nativeFetch
);
const onError = (event: ErrorEvent) => runtimeErrors.push(event.message);
const onRejection = (event: PromiseRejectionEvent) =>
	runtimeErrors.push(String(event.reason));
window.addEventListener("error", onError);
window.addEventListener("unhandledrejection", onRejection);

function listenerCount(runtime: I18nRuntime) {
	// Passive resource ledger only; never replace/mutate actual listener logic.
	const listeners: unknown = Object.getOwnPropertyDescriptor(
		runtime,
		"listeners"
	)?.value;
	if (!(listeners instanceof Set)) {
		throw new Error("Actual runtime listener ledger is unavailable");
	}
	return listeners.size;
}
function disposalResult(
	unsubscribe: ReturnType<I18nRuntime["subscribe"]>
): unknown {
	// The public disposer type is void; observe its unchanged native return
	// value without asserting a Boolean contract in the production signature.
	return unsubscribe();
}
function snapshotFor(id: string): I18nHostSnapshot {
	const pack = BUILT_IN_LANGUAGE_PACKS.find((candidate) => candidate.id === id);
	if (!pack) {
		throw new Error(`Actual bundled pack is unavailable: ${id}`);
	}
	return {
		direction: pack.direction,
		locale: pack.locale,
		packId: pack.id,
		packName: pack.name,
		packVersion: pack.version,
	};
}
const english: I18nHostSnapshot = {
	direction: "ltr",
	locale: "en-US",
	packId: null,
	packName: null,
	packVersion: null,
};
const layoutReads: I18nHostSnapshot[] = [];
const listenerReads: I18nHostSnapshot[] = [];
const disposers: ReturnType<ReturnType<typeof useI18n>["subscribe"]>[] = [];
const cleanupReturns: unknown[] = [];
let currentLanguage: ReturnType<typeof useI18n> | null = null;
let root: Root | null = null;
let container: HTMLDivElement | null = null;

function ChildLayoutSubscriber({
	getSnapshot,
	subscribe,
}: Pick<ReturnType<typeof useI18n>, "getSnapshot" | "subscribe">) {
	// A real long-lived consumer retains the handed-off methods. It does not
	// replace its registration merely because the parent's render facade changes.
	const retainedMethods = useRef({ getSnapshot, subscribe });
	useLayoutEffect(() => {
		const methods = retainedMethods.current;
		layoutReads.push(methods.getSnapshot());
		const unsubscribe = methods.subscribe(() =>
			listenerReads.push(methods.getSnapshot())
		);
		disposers.push(unsubscribe);
		return () => {
			cleanupReturns.push(unsubscribe());
		};
	}, []);
	return (
		<input
			aria-label="Strict layout unsent draft"
			defaultValue="A retained unsent draft"
		/>
	);
}
function RelayOwner() {
	const language = useI18n();
	currentLanguage = language;
	return (
		<section data-ryu-i18n="off">
			<output data-testid="translated-consumer">
				{language.t("common.install")}
			</output>
			<ChildLayoutSubscriber
				getSnapshot={language.getSnapshot}
				subscribe={language.subscribe}
			/>
			<button onClick={() => language.selectPack("official/es")} type="button">
				Select actual Spanish
			</button>
		</section>
	);
}
function restore(
	object: object,
	key: PropertyKey,
	descriptor: PropertyDescriptor | undefined
) {
	if (descriptor) {
		Object.defineProperty(object, key, descriptor);
	} else {
		Reflect.deleteProperty(object, key);
	}
}
async function unmount() {
	const mounted = root;
	root = null;
	if (mounted) {
		await act(async () => mounted.unmount());
	}
	container?.remove();
	container = null;
}
afterAll(async () => {
	try {
		await unmount();
		for (const runtime of runtimes) {
			// biome-ignore lint/suspicious/noMisplacedAssertion: afterAll teardown proves every real case retired its listeners and ledgers.
			expect(listenerCount(runtime)).toBe(0);
		}
		// biome-ignore lint/suspicious/noMisplacedAssertion: afterAll teardown proves every real case retired its listeners and ledgers.
		expect(runtimeErrors).toEqual([]);
		// biome-ignore lint/suspicious/noMisplacedAssertion: afterAll teardown proves every real case retired its listeners and ledgers.
		expect(unexpected).toEqual([]);
	} finally {
		Object.defineProperty(
			I18nRuntime.prototype,
			"translate",
			translateDescriptor
		);
		window.removeEventListener("error", onError);
		window.removeEventListener("unhandledrejection", onRejection);
		localStorage.clear();
		for (const [key, value] of previousStorage) {
			localStorage.setItem(key, value);
		}
		document.documentElement.lang = previousDocument.lang;
		document.documentElement.dir = previousDocument.dir;
		if (previousDocument.locale) {
			document.documentElement.style.setProperty(
				"--ryu-locale",
				previousDocument.locale
			);
		} else {
			document.documentElement.style.removeProperty("--ryu-locale");
		}
		restore(globalThis, "fetch", previousFetch);
		restore(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousActFlag);
		if (ownsDomRegistration) {
			await GlobalRegistrator.unregister();
		}
	}
});

test("StrictMode child layouts retain a live language subscription through replay and committed runtime replacement", async () => {
	localStorage.setItem(
		"language-strict-layout-unrelated",
		'{"timezone":"Asia/Tokyo","draftRevision":11}'
	);
	const unrelatedBefore = Array.from(
		{ length: localStorage.length },
		(_, index) => {
			const key = localStorage.key(index);
			if (key === null) {
				throw new Error("Actual storage enumeration lost a key");
			}
			return [key, localStorage.getItem(key)] as const;
		}
	).filter(([key]) => key !== LANGUAGE_PACK_STORAGE_KEY);
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container, {
		onCaughtError: (error) => runtimeErrors.push(String(error)),
		onUncaughtError: (error) => runtimeErrors.push(String(error)),
	});
	const render = (selectionKey: string, initialPackId: string | null) => (
		<StrictMode>
			<I18nProvider
				autoLocalizeDom={false}
				initialLocale="en-US"
				initialPackId={initialPackId}
				selectionKey={selectionKey}
			>
				<RelayOwner />
			</I18nProvider>
		</StrictMode>
	);
	await act(async () => root!.render(render("strict-initial", null)));
	// These exact setup/cleanup observations prove that real root StrictMode
	// replay occurred. A production build without replay cannot silently pass.
	expect(layoutReads).toEqual([english, english]);
	expect(disposers).toHaveLength(2);
	expect(cleanupReturns).toEqual([true]);
	expect(runtimeErrors).toEqual([]);
	const retiredInitialDisposer = disposers[0];
	if (!retiredInitialDisposer) {
		throw new Error("StrictMode did not create its first real subscription");
	}
	expect(disposalResult(retiredInitialDisposer)).toBe(false);
	const input = container.querySelector("input");
	const output = container.querySelector('[data-testid="translated-consumer"]');
	if (!(input && output)) {
		throw new Error("Actual language consumer did not mount");
	}
	input.value = "An edited unsent draft survives replay and replacement";
	input.focus();
	expect(output.textContent).toBe("Install");
	expect(document.activeElement).toBe(input);
	const initialRuntimes = [...runtimes];
	expect(initialRuntimes.some((runtime) => listenerCount(runtime) > 0)).toBe(
		true
	);
	// Preserve the real runtime's public Set semantics before exercising the
	// integration replacement. Two identical callbacks register/notify once;
	// either disposer removes that shared callback, and the other returns false.
	const initialLanguage = currentLanguage;
	if (!initialLanguage) {
		throw new Error("Actual initial language service is unavailable");
	}
	const liveInitialRuntimes = initialRuntimes.filter(
		(runtime) => listenerCount(runtime) > 0
	);
	expect(liveInitialRuntimes).toHaveLength(1);
	const liveInitialRuntime = liveInitialRuntimes[0];
	if (!liveInitialRuntime) {
		throw new Error("Actual current runtime listener owner is unavailable");
	}
	const listenersBeforeDuplicate = listenerCount(liveInitialRuntime);
	const duplicateSnapshots: I18nHostSnapshot[] = [];
	const duplicateListener = () =>
		duplicateSnapshots.push(initialLanguage.getSnapshot());
	const firstDuplicateDisposer = initialLanguage.subscribe(duplicateListener);
	const secondDuplicateDisposer = initialLanguage.subscribe(duplicateListener);
	try {
		expect(listenerCount(liveInitialRuntime)).toBe(
			listenersBeforeDuplicate + 1
		);
		await act(async () => initialLanguage.selectPack("official/es"));
		expect(duplicateSnapshots).toEqual([snapshotFor("official/es")]);
		expect(disposalResult(firstDuplicateDisposer)).toBe(true);
		expect(disposalResult(secondDuplicateDisposer)).toBe(false);
		expect(listenerCount(liveInitialRuntime)).toBe(listenersBeforeDuplicate);
		await act(async () => initialLanguage.selectPack(null));
		expect(duplicateSnapshots).toEqual([snapshotFor("official/es")]);
		expect(output.textContent).toBe("Install");
		expect(document.activeElement).toBe(input);
		const reRegisteredDisposer = initialLanguage.subscribe(duplicateListener);
		try {
			expect(listenerCount(liveInitialRuntime)).toBe(
				listenersBeforeDuplicate + 1
			);
			// The original runtime's disposer removes by callback identity,
			// including this actual later registration of that same callback.
			expect(disposalResult(firstDuplicateDisposer)).toBe(true);
			expect(disposalResult(reRegisteredDisposer)).toBe(false);
			expect(listenerCount(liveInitialRuntime)).toBe(listenersBeforeDuplicate);
		} finally {
			reRegisteredDisposer();
		}
	} finally {
		firstDuplicateDisposer();
		secondDuplicateDisposer();
	}
	listenerReads.length = 0;
	await act(async () =>
		root!.render(render("strict-replacement", "official/ar"))
	);
	expect(layoutReads).toEqual([english, english]);
	expect(cleanupReturns).toEqual([true]);
	expect(disposers).toHaveLength(2);
	expect(listenerReads.length).toBeGreaterThan(0);
	for (const snapshot of listenerReads) {
		expect(snapshot).toEqual(snapshotFor("official/ar"));
	}
	const arabic = BUILT_IN_LANGUAGE_PACKS.find(
		(pack) => pack.id === "official/ar"
	);
	if (!arabic) {
		throw new Error("Actual bundled Arabic pack is unavailable");
	}
	expect(output.textContent).toBe(arabic.messages["common.install"]);
	expect(document.documentElement.lang).toBe("ar");
	expect(document.documentElement.dir).toBe("rtl");
	for (const runtime of initialRuntimes) {
		expect(listenerCount(runtime)).toBe(0);
	}
	expect(container.querySelector("input")).toBe(input);
	expect(input.value).toBe(
		"An edited unsent draft survives replay and replacement"
	);
	expect(document.activeElement).toBe(input);
	const button = container.querySelector("button");
	if (!button) {
		throw new Error("Actual language choice action is unavailable");
	}
	await act(async () => button.click());
	expect(listenerReads.at(-1)).toEqual(snapshotFor("official/es"));
	expect(document.documentElement.lang).toBe("es");
	expect(document.documentElement.dir).toBe("ltr");
	expect(localStorage.getItem(LANGUAGE_PACK_STORAGE_KEY)).toBe("official/es");
	const retiredChoice = currentLanguage?.selectPack;
	if (!retiredChoice) {
		throw new Error("Actual current language action is unavailable");
	}
	await act(async () => root!.unmount());
	root = null;
	expect(container.childNodes).toHaveLength(0);
	expect(cleanupReturns).toEqual([true, true]);
	for (const unsubscribe of disposers) {
		expect(disposalResult(unsubscribe)).toBe(false);
	}
	for (const runtime of runtimes) {
		expect(listenerCount(runtime)).toBe(0);
	}
	const notificationsAtUnmount = listenerReads.length;
	await act(async () => retiredChoice("official/ar"));
	expect(listenerReads).toHaveLength(notificationsAtUnmount);
	for (const runtime of runtimes) {
		expect(listenerCount(runtime)).toBe(0);
	}
	const unrelatedAfter = Array.from(
		{ length: localStorage.length },
		(_, index) => {
			const key = localStorage.key(index);
			if (key === null) {
				throw new Error("Actual storage enumeration lost a key");
			}
			return [key, localStorage.getItem(key)] as const;
		}
	).filter(([key]) => key !== LANGUAGE_PACK_STORAGE_KEY);
	expect(unrelatedAfter).toEqual(unrelatedBefore);
	expect(runtimeErrors).toEqual([]);
	expect(unexpected).toEqual([]);
}, 10_000);
