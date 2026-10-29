// Current-integration candidate for the original runtime's callback Set contract.
// Two real hooks share one callback; a genuine language choice must notify it once.
// This mounted boundary does not prove browser delivery, SSR or Core persistence.
import { afterAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
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
globalThis.fetch = Object.assign(
	async (input: Parameters<typeof nativeFetch>[0]) => {
		const destination = input instanceof Request ? input.url : String(input);
		unexpected.push(`undeclared cross-hook lifecycle HTTP ${destination}`);
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
	// Observe the actual resource ledger without changing subscription behavior.
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
function unrelatedStorage() {
	return Array.from({ length: localStorage.length }, (_, index) => {
		const key = localStorage.key(index);
		if (key === null) {
			throw new Error("Actual storage enumeration lost a key");
		}
		return [key, localStorage.getItem(key)] as const;
	}).filter(([key]) => key !== LANGUAGE_PACK_STORAGE_KEY);
}
const facades = new Map<string, ReturnType<typeof useI18n>>();
let root: Root | null = null;
let container: HTMLDivElement | null = null;
function HookConsumer({ name }: { name: string }) {
	const language = useI18n();
	facades.set(name, language);
	return (
		<section
			data-ryu-i18n="off"
			data-testid={name}
			dir={language.direction}
			lang={language.locale}
		>
			<output>{language.t("common.install")}</output>
			<input
				aria-label={`${name} unsent draft`}
				defaultValue={`${name} retained draft`}
			/>
			<button onClick={() => language.selectPack("official/es")} type="button">
				Choose Spanish
			</button>
			<button onClick={() => language.selectPack("official/fr")} type="button">
				Choose French
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

test("two real hook consumers share the native callback registration and either disposer removes it", async () => {
	localStorage.setItem(
		"language-cross-hook-unrelated",
		'{"timezone":"Asia/Tokyo","draftRevision":17}'
	);
	const unrelatedBefore = unrelatedStorage();
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container, {
		onCaughtError: (error) => runtimeErrors.push(String(error)),
		onUncaughtError: (error) => runtimeErrors.push(String(error)),
	});
	await act(async () =>
		root!.render(
			<I18nProvider
				autoLocalizeDom={false}
				initialLocale="en-US"
				initialPackId={null}
			>
				<HookConsumer name="first" />
				<HookConsumer name="second" />
			</I18nProvider>
		)
	);
	const first = facades.get("first");
	const second = facades.get("second");
	const sections = [...container.querySelectorAll("section")];
	const draft = container.querySelector("input");
	if (!(first && second) || sections.length !== 2 || !draft) {
		throw new Error("Actual two language consumers did not mount");
	}
	draft.value = "An unsent draft survives shared subscription disposal";
	draft.focus();
	const liveRuntimes = [...runtimes].filter(
		(runtime) => listenerCount(runtime) > 0
	);
	expect(liveRuntimes).toHaveLength(1);
	const liveRuntime = liveRuntimes[0];
	if (!liveRuntime) {
		throw new Error("Actual current runtime is unavailable");
	}
	const listenersBefore = listenerCount(liveRuntime);
	const notifications: I18nHostSnapshot[] = [];
	const callback = () => notifications.push(first.getSnapshot());
	const firstDisposer = first.subscribe(callback);
	const secondDisposer = second.subscribe(callback);
	try {
		const spanishButton = sections[0]?.querySelector("button");
		if (!spanishButton) {
			throw new Error("Actual first consumer language action is unavailable");
		}
		await act(async () => spanishButton.click());
		// Establish the acknowledged current runtime and both real DOM consumers
		// before the first regression assertion about duplicated consumer effects.
		expect(first.getSnapshot()).toEqual(snapshotFor("official/es"));
		expect(second.getSnapshot()).toEqual(snapshotFor("official/es"));
		const spanish = BUILT_IN_LANGUAGE_PACKS.find(
			(pack) => pack.id === "official/es"
		);
		if (!spanish) {
			throw new Error("Actual bundled Spanish pack is unavailable");
		}
		for (const section of sections) {
			expect(section.querySelector("output")?.textContent).toBe(
				spanish.messages["common.install"]
			);
			expect(section.lang).toBe("es");
		}
		expect(notifications).toEqual([snapshotFor("official/es")]);
		expect(listenerCount(liveRuntime)).toBe(listenersBefore + 1);
		expect(disposalResult(secondDisposer)).toBe(true);
		expect(disposalResult(firstDisposer)).toBe(false);
		expect(listenerCount(liveRuntime)).toBe(listenersBefore);
		const frenchButton = sections[1]?.querySelectorAll("button")[1];
		if (!frenchButton) {
			throw new Error("Actual second consumer language action is unavailable");
		}
		await act(async () => frenchButton.click());
		const french = BUILT_IN_LANGUAGE_PACKS.find(
			(pack) => pack.id === "official/fr"
		);
		if (!french) {
			throw new Error("Actual bundled French pack is unavailable");
		}
		for (const section of sections) {
			expect(section.querySelector("output")?.textContent).toBe(
				french.messages["common.install"]
			);
		}
		expect(first.getSnapshot()).toEqual(snapshotFor("official/fr"));
		expect(second.getSnapshot()).toEqual(snapshotFor("official/fr"));
		expect(notifications).toEqual([snapshotFor("official/es")]);
		expect(localStorage.getItem(LANGUAGE_PACK_STORAGE_KEY)).toBe("official/fr");
		expect(document.documentElement.lang).toBe("fr");
		expect(container.querySelector("input")).toBe(draft);
		expect(draft.value).toBe(
			"An unsent draft survives shared subscription disposal"
		);
		expect(document.activeElement).toBe(draft);
		expect(unrelatedStorage()).toEqual(unrelatedBefore);
		expect(runtimeErrors).toEqual([]);
		expect(unexpected).toEqual([]);
	} finally {
		firstDisposer();
		secondDisposer();
		await unmount();
	}
	for (const runtime of runtimes) {
		expect(listenerCount(runtime)).toBe(0);
	}
	expect(runtimeErrors).toEqual([]);
	expect(unexpected).toEqual([]);
}, 10_000);
