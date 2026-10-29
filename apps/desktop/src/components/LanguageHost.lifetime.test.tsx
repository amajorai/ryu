// Actual renderer/provider/ExamplePluginPanel/ExtensionHost RPC lifetime.
// Happy DOM does not execute the sandboxed demo or implement port transfer:
// observe the real host's handoff and drive its native transferred MessagePort.
// This proves mounted wiring and consumer lifetime, not browser CSP/origin
// isolation, Core persistence, authentication, or execution of the demo bundle.
import { afterAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
	BUILT_IN_LANGUAGE_PACKS,
	type I18nHostSnapshot,
	I18nRuntime,
	LANGUAGE_PACK_STORAGE_KEY,
} from "@ryu/i18n";
import { I18nProvider, useI18n } from "@ryu/i18n/react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { z } from "zod";

const NativeMessageChannel = globalThis.MessageChannel;
const NativeMessagePort = globalThis.MessagePort;
const nativeFetch = globalThis.fetch;
const nativeSetTimeout = globalThis.setTimeout;
const nativeClearTimeout = globalThis.clearTimeout;
const previousChannel = Object.getOwnPropertyDescriptor(
	globalThis,
	"MessageChannel"
);
const previousPort = Object.getOwnPropertyDescriptor(globalThis, "MessagePort");
const previousFetch = Object.getOwnPropertyDescriptor(globalThis, "fetch");
const previousActFlag = Object.getOwnPropertyDescriptor(
	globalThis,
	"IS_REACT_ACT_ENVIRONMENT"
);
const translateDescriptor = Object.getOwnPropertyDescriptor(
	I18nRuntime.prototype,
	"translate"
)!;
const nativeTranslate = I18nRuntime.prototype.translate;
const postDescriptor = Object.getOwnPropertyDescriptor(
	NativeMessagePort.prototype,
	"postMessage"
)!;
const closeDescriptor = Object.getOwnPropertyDescriptor(
	NativeMessagePort.prototype,
	"close"
)!;
const nativePost = NativeMessagePort.prototype.postMessage;
const nativeClose = NativeMessagePort.prototype.close;
const ownsDomRegistration = globalThis.document === undefined;
if (ownsDomRegistration) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "MessageChannel", NativeMessageChannel);
Reflect.set(globalThis, "MessagePort", NativeMessagePort);
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const previousStorage = Array.from(
	{ length: localStorage.length },
	(_, index) => {
		const key = localStorage.key(index)!;
		return [key, localStorage.getItem(key)!] as const;
	}
);
const previousDocument = {
	lang: document.documentElement.lang,
	dir: document.documentElement.dir,
	locale: document.documentElement.style.getPropertyValue("--ryu-locale"),
};
localStorage.clear();

const runtimeErrors: string[] = [];
const unexpected: string[] = [];
const runtimes = new Set<I18nRuntime>();
const portLedger = new Map<MessagePort, { closes: number; posts: unknown[] }>();
function ledger(port: MessagePort) {
	let entry = portLedger.get(port);
	if (!entry) {
		entry = { closes: 0, posts: [] };
		portLedger.set(port, entry);
	}
	return entry;
}
// Unchanged delegates: these observers do not substitute a runtime, listener,
// transport, RPC response, language selection, or resource-disposal operation.
Object.defineProperty(I18nRuntime.prototype, "translate", {
	...translateDescriptor,
	value(this: I18nRuntime, ...args: Parameters<I18nRuntime["translate"]>) {
		runtimes.add(this);
		return Reflect.apply(nativeTranslate, this, args);
	},
});
Object.defineProperty(NativeMessagePort.prototype, "postMessage", {
	...postDescriptor,
	value(this: MessagePort, ...args: Parameters<MessagePort["postMessage"]>) {
		ledger(this).posts.push(args[0]);
		return Reflect.apply(nativePost, this, args);
	},
});
Object.defineProperty(NativeMessagePort.prototype, "close", {
	...closeDescriptor,
	value(this: MessagePort, ...args: Parameters<MessagePort["close"]>) {
		ledger(this).closes += 1;
		return Reflect.apply(nativeClose, this, args);
	},
});
// This case has no declared HTTP operation. Any accidental business request is
// an explicit failure, never a fabricated successful response.
globalThis.fetch = Object.assign(
	async (input: Parameters<typeof nativeFetch>[0]) => {
		const destination = typeof input === "string" ? input : String(input);
		unexpected.push(`undeclared HTTP ${destination}`);
		throw new Error(`language lifetime proof has no HTTP peer: ${destination}`);
	},
	nativeFetch
);
const onError = (event: ErrorEvent) => runtimeErrors.push(event.message);
const onRejection = (event: PromiseRejectionEvent) =>
	runtimeErrors.push(String(event.reason));
window.addEventListener("error", onError);
window.addEventListener("unhandledrejection", onRejection);

const snapshotSchema = z
	.object({
		direction: z.enum(["ltr", "rtl"]),
		locale: z.string(),
		packId: z.string().nullable(),
		packName: z.string().nullable(),
		packVersion: z.string().nullable(),
	})
	.strict();
const replySchema = z.discriminatedUnion("kind", [
	z
		.object({
			kind: z.literal("ryu-plugin-rpc-chunk"),
			id: z.number().int(),
			delta: z.string(),
		})
		.strict(),
	z
		.object({
			kind: z.literal("ryu-plugin-rpc-result"),
			id: z.number().int(),
			result: z.unknown().optional(),
			error: z
				.union([
					z.string(),
					z.object({ code: z.string(), message: z.string() }).strict(),
				])
				.optional(),
		})
		.strict(),
]);
const handoffSchema = z
	.object({ kind: z.literal("ryu-plugin-host-port"), nonce: z.string() })
	.strict();
const spanish = BUILT_IN_LANGUAGE_PACKS.find(
	(pack) => pack.id === "official/es"
)!;
const arabic = BUILT_IN_LANGUAGE_PACKS.find(
	(pack) => pack.id === "official/ar"
)!;
function packSnapshot(pack: typeof spanish): I18nHostSnapshot {
	return {
		direction: pack.direction,
		locale: pack.locale,
		packId: pack.id,
		packName: pack.name,
		packVersion: pack.version,
	};
}
const englishSnapshot: I18nHostSnapshot = {
	direction: "ltr",
	locale: "en-US",
	packId: null,
	packName: null,
	packVersion: null,
};
function listenerCount(runtime: I18nRuntime) {
	// Resource ledger only: the production class owns this Set. Never mutate it
	// or expose a new disposal API; real React/RPC lifecycle must remove entries.
	const value: unknown = Object.getOwnPropertyDescriptor(
		runtime,
		"listeners"
	)?.value;
	if (!(value instanceof Set)) {
		throw new Error("actual runtime listener ledger is unavailable");
	}
	return value.size;
}

let currentLanguage: ReturnType<typeof useI18n> | null = null;
function LanguageConsumer() {
	const language = useI18n();
	currentLanguage = language;
	return (
		<section data-ryu-i18n="off">
			<output data-testid="language-consumer">
				{language.t("common.install")}
			</output>
			<input
				aria-label="Unsent language lifetime draft"
				defaultValue="Unsent draft survives the language change"
			/>
			<button
				id="select-current-arabic"
				onClick={() => language.selectPack(arabic.id)}
				type="button"
			>
				Choose Arabic
			</button>
		</section>
	);
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let peer: MessagePort | null = null;
let frameWindow: Window | null = null;
let previousFramePost: PropertyDescriptor | undefined;
const waiters = new Map<
	number,
	{
		resolve: (value: unknown) => void;
		reject: (error: Error) => void;
		timer: ReturnType<typeof nativeSetTimeout> | null;
	}
>();
let nextId = 1;
let streamId = 0;
const snapshots: I18nHostSnapshot[] = [];
const results: Array<{ id: number; result: unknown }> = [];
function receive(event: MessageEvent) {
	const parsed = replySchema.safeParse(event.data);
	if (!parsed.success) {
		unexpected.push(`invalid native RPC reply ${JSON.stringify(event.data)}`);
		return;
	}
	const reply = parsed.data;
	if (reply.kind === "ryu-plugin-rpc-chunk") {
		if (reply.id !== streamId) {
			unexpected.push(`unowned native stream ${reply.id}`);
			return;
		}
		try {
			snapshots.push(snapshotSchema.parse(JSON.parse(reply.delta)));
		} catch (error) {
			unexpected.push(`invalid streamed snapshot ${String(error)}`);
		}
		return;
	}
	results.push({ id: reply.id, result: reply.result });
	const waiter = waiters.get(reply.id);
	if (!waiter) {
		unexpected.push(`unowned terminal result ${reply.id}`);
		return;
	}
	waiters.delete(reply.id);
	if (waiter.timer !== null) {
		nativeClearTimeout(waiter.timer);
	}
	if (reply.error === undefined) {
		waiter.resolve(reply.result);
	} else {
		waiter.reject(new Error(JSON.stringify(reply.error)));
	}
}
function terminal(id: number, hasDeadline = true): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const timer = hasDeadline
			? nativeSetTimeout(() => {
					waiters.delete(id);
					reject(new Error(`actual RPC terminal result ${id} did not arrive`));
				}, 3000)
			: null;
		waiters.set(id, { resolve, reject, timer });
	});
}
function call(
	method: "i18n.get" | "i18n.translate" | "agent.cancel",
	args: unknown[] = []
) {
	if (!peer) {
		throw new Error("actual host transferred no peer port");
	}
	const id = nextId++;
	const pending = terminal(id);
	peer.postMessage({ kind: "ryu-plugin-rpc", id, method, args });
	return pending;
}
async function getSnapshot() {
	// Native same-port FIFO receipt drains preceding synchronous stream emits.
	// Negative conservation assertions never depend on a fixed settling delay.
	let value: unknown;
	await act(async () => {
		value = await call("i18n.get");
	});
	return snapshotSchema.parse(value);
}
function restore(
	target: object,
	key: string,
	descriptor: PropertyDescriptor | undefined
) {
	if (descriptor) {
		Object.defineProperty(target, key, descriptor);
	} else {
		Reflect.deleteProperty(target, key);
	}
}

afterAll(async () => {
	try {
		if (root) {
			await act(async () => root!.unmount());
		}
		root = null;
		container?.remove();
		if (peer) {
			peer.onmessage = null;
			if (ledger(peer).closes === 0) {
				peer.close();
			}
		}
		for (const [port, entry] of portLedger) {
			if (entry.closes === 0) {
				port.close();
			}
		}
		for (const waiter of waiters.values()) {
			if (waiter.timer !== null) {
				nativeClearTimeout(waiter.timer);
			}
			waiter.reject(new Error("language lifetime proof cleanup"));
		}
		waiters.clear();
	} finally {
		if (frameWindow) {
			restore(frameWindow, "postMessage", previousFramePost);
		}
		Object.defineProperty(
			I18nRuntime.prototype,
			"translate",
			translateDescriptor
		);
		Object.defineProperty(
			NativeMessagePort.prototype,
			"postMessage",
			postDescriptor
		);
		Object.defineProperty(
			NativeMessagePort.prototype,
			"close",
			closeDescriptor
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
		restore(globalThis, "MessageChannel", previousChannel);
		restore(globalThis, "MessagePort", previousPort);
		restore(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousActFlag);
		if (ownsDomRegistration) {
			await GlobalRegistrator.unregister();
		}
	}
	// biome-ignore lint/suspicious/noMisplacedAssertion: afterAll teardown proves every real case retired its listeners and ledgers.
	expect(runtimeErrors).toEqual([]);
	// biome-ignore lint/suspicious/noMisplacedAssertion: afterAll teardown proves every real case retired its listeners and ledgers.
	expect(unexpected).toEqual([]);
});

test("a mounted Companion locale stream follows provider runtime replacement and retires on cancel/unmount", async () => {
	// Import the actual panel after the native transport survives DOM registration.
	// Its original srcdoc, generated nonce, grants and business callbacks remain.
	const { ExamplePluginPanel } = await import(
		"@/src/contributions/host/ExamplePluginPanel.tsx"
	);
	const { vaultHydrated } = await import("@/lib/auth-client.ts");
	await vaultHydrated;
	localStorage.setItem(
		"language-lifetime-unrelated",
		'{"timezone":"Asia/Tokyo","draftRevision":7}'
	);
	const conservedStorage = Array.from(
		{ length: localStorage.length },
		(_, index) => {
			const key = localStorage.key(index)!;
			return [key, localStorage.getItem(key)!] as const;
		}
	).filter(([key]) => key !== LANGUAGE_PACK_STORAGE_KEY);
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container, {
		onCaughtError: (error) => runtimeErrors.push(String(error)),
		onUncaughtError: (error) => runtimeErrors.push(String(error)),
	});
	const render = (selectionKey: string, initialPackId: string | null) => (
		<I18nProvider
			initialLocale="en-US"
			initialPackId={initialPackId}
			selectionKey={selectionKey}
		>
			<ExamplePluginPanel />
			<LanguageConsumer />
		</I18nProvider>
	);
	await act(async () => root!.render(render("fixed-initial", spanish.id)));
	const iframe = container.querySelector("iframe")!;
	const originalSrcdoc = iframe.srcdoc;
	const nonceLiteral = originalSrcdoc.match(/var NONCE = ("[^"\n]+");/u)?.[1];
	if (!nonceLiteral) {
		throw new Error("actual demo srcdoc has no generated nonce");
	}
	const nonce = z.string().min(1).parse(JSON.parse(nonceLiteral));
	frameWindow = iframe.contentWindow;
	if (!frameWindow) {
		throw new Error("actual ExamplePluginPanel rendered no frame window");
	}
	previousFramePost = Object.getOwnPropertyDescriptor(
		frameWindow,
		"postMessage"
	);
	const framePost = frameWindow.postMessage;
	let handoffs = 0;
	Object.defineProperty(frameWindow, "postMessage", {
		configurable: true,
		value(this: Window, ...args: unknown[]) {
			const handoff = handoffSchema.safeParse(args[0]);
			if (handoff.success) {
				handoffs += 1;
				if (
					handoff.data.nonce !== nonce ||
					!Array.isArray(args[2]) ||
					args[2].length !== 1 ||
					!(args[2][0] instanceof NativeMessagePort)
				) {
					throw new Error(
						"actual host handoff violated native transport/nonce shape"
					);
				}
				peer = args[2][0];
				peer.onmessage = receive;
				peer.start();
			}
			return Reflect.apply(framePost, this, args);
		},
	});
	await act(async () =>
		window.dispatchEvent(
			new window.MessageEvent("message", {
				data: { kind: "ryu-plugin-ready", nonce },
				source: frameWindow,
			})
		)
	);
	expect(handoffs).toBe(1);
	expect(peer).toBeInstanceOf(NativeMessagePort);
	expect(iframe.getAttribute("sandbox")).toBe("allow-scripts");
	const draft = container.querySelector("input")!;
	draft.focus();
	const draftValue = draft.value;
	const span = container.querySelector('[data-testid="language-consumer"]')!;
	expect(span.textContent).toBe(spanish.messages["common.install"]);
	expect(document.documentElement.lang).toBe("es");
	expect(document.activeElement).toBe(draft);
	const initialRuntime = [...runtimes][0]!;
	const initialReactListeners = listenerCount(initialRuntime);
	expect(initialReactListeners).toBeGreaterThan(0);
	streamId = nextId++;
	// A live subscription is intentionally nonterminal until cancellation.
	const streamTerminal = terminal(streamId, false);
	// Observe failures immediately even if a preceding primary assertion fails.
	void streamTerminal.catch(() => undefined);
	peer!.postMessage({
		kind: "ryu-plugin-rpc",
		id: streamId,
		method: "i18n.subscribe",
		args: [{}],
	});
	expect(await getSnapshot()).toEqual(packSnapshot(spanish));
	expect(snapshots).toEqual([packSnapshot(spanish)]);
	expect(listenerCount(initialRuntime)).toBe(initialReactListeners + 1);
	const hostPort = [...portLedger.keys()].find((port) => port !== peer)!;
	expect(hostPort).toBeInstanceOf(NativeMessagePort);

	await act(async () => root!.render(render("automatic-replacement", null)));
	expect(container.querySelector("iframe")).toBe(iframe);
	expect(iframe.srcdoc).toBe(originalSrcdoc);
	expect(handoffs).toBe(1);
	expect(container.querySelector("input")).toBe(draft);
	expect(draft.value).toBe(draftValue);
	expect(document.activeElement).toBe(draft);
	expect(span.textContent).toBe("Install");
	expect(document.documentElement.lang).toBe("en-US");
	expect(await getSnapshot()).toEqual(englishSnapshot);
	expect(snapshots.at(-1)).toEqual(englishSnapshot);
	expect(listenerCount(initialRuntime)).toBe(0);

	await act(async () =>
		container!
			.querySelector<HTMLButtonElement>("#select-current-arabic")!
			.click()
	);
	expect(await getSnapshot()).toEqual(packSnapshot(arabic));
	expect(snapshots.at(-1)).toEqual(packSnapshot(arabic));
	let translated: unknown;
	await act(async () => {
		translated = await call("i18n.translate", [
			{ id: "common.install", defaultMessage: "Install" },
		]);
	});
	expect(translated).toBe(arabic.messages["common.install"]);
	expect(span.textContent).toBe(arabic.messages["common.install"]);
	expect(document.documentElement.dir).toBe("rtl");
	expect(container.querySelector("input")).toBe(draft);
	expect(draft.value).toBe(draftValue);
	expect(document.activeElement).toBe(draft);
	expect(handoffs).toBe(1);
	expect(ledger(hostPort).closes).toBe(0);
	const liveRuntime = [...runtimes].at(-1)!;
	expect(liveRuntime).not.toBe(initialRuntime);
	const listenersBeforeCancel = listenerCount(liveRuntime);
	expect(listenersBeforeCancel).toBeGreaterThan(1);
	const snapshotsBeforeCancel = snapshots.length;
	await act(async () => {
		expect(await call("agent.cancel", [streamId])).toBeNull();
		expect(await streamTerminal).toBeNull();
	});
	expect(results.filter((result) => result.id === streamId)).toEqual([
		{ id: streamId, result: null },
	]);
	expect(listenerCount(liveRuntime)).toBe(listenersBeforeCancel - 1);
	await act(async () => currentLanguage!.selectPack(spanish.id));
	expect(await getSnapshot()).toEqual(packSnapshot(spanish));
	expect(snapshots).toHaveLength(snapshotsBeforeCancel);
	expect(span.textContent).toBe(spanish.messages["common.install"]);
	// Start a second genuine subscription so unmount must release an active
	// runtime listener, rather than merely closing an already-cancelled stream.
	const listenersBeforeUnmountStream = listenerCount(liveRuntime);
	streamId = nextId++;
	peer!.postMessage({
		kind: "ryu-plugin-rpc",
		id: streamId,
		method: "i18n.subscribe",
		args: [{}],
	});
	expect(await getSnapshot()).toEqual(packSnapshot(spanish));
	expect(snapshots).toHaveLength(snapshotsBeforeCancel + 1);
	expect(snapshots.at(-1)).toEqual(packSnapshot(spanish));
	expect(listenerCount(liveRuntime)).toBe(listenersBeforeUnmountStream + 1);
	const snapshotsBeforeUnmount = snapshots.length;
	const nativePostsBeforeUnmount = ledger(hostPort).posts.length;
	const retiredSelection = currentLanguage!.selectPack;
	await act(async () => root!.unmount());
	root = null;
	expect(container.childNodes).toHaveLength(0);
	for (const runtime of runtimes) {
		expect(listenerCount(runtime)).toBe(0);
	}
	expect(ledger(hostPort).closes).toBe(1);
	expect(hostPort.onmessage).toBeNull();
	await act(async () => retiredSelection(arabic.id));
	expect(ledger(hostPort).posts).toHaveLength(nativePostsBeforeUnmount);
	expect(snapshots).toHaveLength(snapshotsBeforeUnmount);
	for (const runtime of runtimes) {
		expect(listenerCount(runtime)).toBe(0);
	}
	peer!.onmessage = null;
	peer!.close();
	expect(portLedger.size).toBe(2);
	for (const entry of portLedger.values()) {
		expect(entry.closes).toBe(1);
	}
	expect(waiters.size).toBe(0);
	const currentStorage = Array.from(
		{ length: localStorage.length },
		(_, index) => {
			const key = localStorage.key(index)!;
			return [key, localStorage.getItem(key)!] as const;
		}
	).filter(([key]) => key !== LANGUAGE_PACK_STORAGE_KEY);
	expect(currentStorage).toEqual(conservedStorage);
	expect(runtimeErrors).toEqual([]);
	expect(unexpected).toEqual([]);
}, 15_000);
