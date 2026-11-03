// Shared by the useApps.http suites: the mounted roster consumer, its
// teardown, and the transport helpers the native fixture is built from.
import { afterEach } from "bun:test";
import {
	closeSync,
	fsyncSync,
	openSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

/** Module state other suites' modules write, kept on one shared object. */
export const live = {
	latest: undefined as unknown as ReturnType<typeof useApps>,
	root: undefined as unknown as ReturnType<typeof createRoot> | undefined,
	container: undefined as unknown as HTMLDivElement | undefined,
	dispose: undefined as unknown as (() => Promise<void>) | undefined,
	settleBeforeUnmount: undefined as unknown as
		| (() => Promise<void>)
		| undefined,
	runtimeErrors: [] as string[],
	fixtureReceiptId: 0,
};

export const native = {
	fetch: globalThis.fetch,
	Response: globalThis.Response,
	Request: globalThis.Request,
	Headers: globalThis.Headers,
	AbortController: globalThis.AbortController,
	AbortSignal: globalThis.AbortSignal,
};
export const nativeResponseText = native.Response.prototype.text;
export const nativeResponseJson = native.Response.prototype.json;
export const nativeSetTimeout = globalThis.setTimeout;
export const nativeClearTimeout = globalThis.clearTimeout;
if (typeof document === "undefined") {
	GlobalRegistrator.register();
}
Object.assign(globalThis, native);
export const NativeResponse = native.Response;
export const NativeRequest = native.Request;
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
export const { useApps } = await import("./useApps.ts");
export const { useNodeStore } = await import("../store/useNodeStore.ts");
export const { queryClient } = await import("../lib/query-client.ts");
export const { QueryClientProvider } = await import("@tanstack/react-query");
export const previousNodes = useNodeStore.getState();
export function Consumer() {
	live.latest = useApps();
	return createElement(
		"output",
		null,
		JSON.stringify({
			apps: live.latest.apps.map(({ id, name, enabled }) => ({
				id,
				name,
				enabled,
			})),
			error: live.latest.toggleError,
		})
	);
}
export async function mount() {
	live.container = document.createElement("div");
	document.body.append(live.container);
	live.root = createRoot(live.container, {
		onCaughtError: (error) => live.runtimeErrors.push(String(error)),
		onUncaughtError: (error) => live.runtimeErrors.push(String(error)),
		onRecoverableError: (error) => live.runtimeErrors.push(String(error)),
	});
	await act(async () =>
		live.root?.render(
			createElement(
				QueryClientProvider,
				{ client: queryClient },
				createElement(Consumer)
			)
		)
	);
}
export async function settle(predicate: () => boolean) {
	for (let attempt = 0; attempt < 300; attempt += 1) {
		if (predicate()) {
			return;
		}
		await act(async () => {
			await Bun.sleep(10);
		});
	}
	throw new Error("App roster consumer did not acknowledge the operation");
}

/** The two node authorities whose app rosters the fixture serves. */
export type Authority = "a" | "b";
/** One installed app as authority `authority`'s roster stores it. */
export const appRecord = (authority: Authority, id: string) => ({
	id,
	name: `${id} ${authority}`,
	built_in: false,
	enabled: true,
	installed: true,
	installed_version: "1.0.0",
	version: "1.0.0",
	local_only: false,
	windows_first: false,
	permission_grants: [],
	runnables: [],
	sidecar_name: null,
});
export type AppRecord = ReturnType<typeof appRecord>;

/** Why `request` is not the shipping Desktop transport, or null when it is. */
export const validateHeaders = (request: Request): string | null => {
	const clientId = localStorage.getItem("ryu_client_id");
	if (!clientId || request.headers.get("x-ryu-client-id") !== clientId) {
		return "Wrong or missing persisted Desktop client identity";
	}
	if (
		request.headers.get("content-type") !== "application/json" ||
		request.headers.get("x-ryu-client-label") !== "Desktop" ||
		request.headers.get("x-ryu-surface") !== "desktop" ||
		request.headers.has("cookie") ||
		request.headers.has("origin")
	) {
		return "Unexpected native transport or Desktop identity headers";
	}
	const identityNames = [...request.headers.keys()]
		.filter((name) => name.startsWith("x-ryu-"))
		.sort();
	if (
		JSON.stringify(identityNames) !==
		JSON.stringify(["x-ryu-client-id", "x-ryu-client-label", "x-ryu-surface"])
	) {
		return "Undeclared delegation, buyer or attribution header";
	}
	if (
		!["Bearer token-a", "Bearer token-b"].includes(
			request.headers.get("authorization") ?? ""
		)
	) {
		return "Undeclared node admission credential";
	}
	return null;
};

/** Whether `error` is the native fetch abort. */
export const isNativeAbort = (error: unknown): boolean =>
	typeof error === "object" &&
	error !== null &&
	"name" in error &&
	error.name === "AbortError";

/** The fsynced JSON roster files of both authorities under `directory`. */
export function rosterStore(directory: string) {
	type Record = AppRecord;
	const raw = (authority: Authority) =>
		readFileSync(path.join(directory, `${authority}.json`), "utf8");
	const read = (authority: Authority): Record[] => JSON.parse(raw(authority));
	const store = (authority: Authority, records: Record[]) => {
		const file = path.join(directory, `${authority}.json`);
		writeFileSync(`${file}.new`, JSON.stringify(records));
		// Read-write: Windows refuses to flush a read-only handle (EPERM).
		const fd = openSync(`${file}.new`, "r+");
		try {
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		renameSync(`${file}.new`, file);
		// Windows cannot fsync a directory handle (EPERM); NTFS journals the
		// rename, so only POSIX hosts sync the parent directory.
		if (process.platform !== "win32") {
			const parent = openSync(directory, "r");
			try {
				fsyncSync(parent);
			} finally {
				closeSync(parent);
			}
		}
	};
	return { raw, read, store };
}

/** Select authority `authority` of the peer at `origin` as the only node. */
export function selectAuthority(origin: string, authority: Authority) {
	const node = {
		name: authority,
		url: `${origin.replace(/\/$/, "")}/${authority}`,
		token: `token-${authority}`,
	};
	useNodeStore.setState({
		nodes: [node],
		localNodes: [node],
		cloudNodes: [],
		defaultNode: authority,
		autoSelect: false,
		autoSelectedNode: null,
		tabOverrides: {},
	});
}

/**
 * The owned native transport's ledger: handlers, exchanges and body reads in
 * flight, their receipts, and a wait for all of them (and the query cache) to
 * go idle.
 */
export function createTransportLedger() {
	const activeHandlers = new Set<number>();
	const handlerReceipts: Array<{
		id: number;
		url: string;
		method: string;
		authorization: string | null;
		terminal: boolean;
	}> = [];
	const cancellations: Array<{
		id: number | null;
		url: string;
		method: string;
		authorization: string | null;
		stage: "exchange" | "body";
		nativeErrorName: "AbortError";
		suppliedSignalAborted: true;
		requestSignalAborted: true;
	}> = [];
	const nativeExchanges = new Set<Promise<Response>>();
	const bodyObservations = new Set<Promise<unknown>>();
	const unreadBodies = new Set<number>();
	const bodyReceipts: Array<{
		id: number;
		status: number;
		method: "text" | "json";
		body: unknown;
	}> = [];
	const transportErrors: string[] = [];
	const transportChanged = new Set<() => void>();
	const changed = () => {
		for (const notify of transportChanged) {
			notify();
		}
	};
	const unsubscribeQuery = queryClient.getQueryCache().subscribe(changed);
	const counters = () => ({
		activeHandlers: activeHandlers.size,
		nativeExchanges: nativeExchanges.size,
		bodyObservations: bodyObservations.size,
		unreadBodies: [...unreadBodies],
		queryFetching: queryClient.isFetching(),
		queryObservers: queryClient
			.getQueryCache()
			.findAll()
			.reduce((sum, query) => sum + query.getObserversCount(), 0),
	});
	const idle = () =>
		activeHandlers.size === 0 &&
		nativeExchanges.size === 0 &&
		bodyObservations.size === 0 &&
		unreadBodies.size === 0 &&
		queryClient.isFetching() === 0;
	async function settleNativeTransport() {
		if (idle()) {
			return;
		}
		await new Promise<void>((resolve, reject) => {
			const finish = () => {
				if (!idle()) {
					return;
				}
				transportChanged.delete(finish);
				nativeClearTimeout(deadline);
				resolve();
			};
			const deadline = nativeSetTimeout(() => {
				transportChanged.delete(finish);
				reject(
					new Error(
						`Owned native transport did not settle: ${JSON.stringify(counters())}`
					)
				);
			}, 3000);
			transportChanged.add(finish);
			finish();
		});
	}
	return {
		activeHandlers,
		handlerReceipts,
		cancellations,
		nativeExchanges,
		bodyObservations,
		unreadBodies,
		bodyReceipts,
		transportErrors,
		changed,
		unsubscribeQuery,
		counters,
		settleNativeTransport,
	};
}

/** The per-test setup and teardown every suite on this harness registers. */
export function registerUseAppsHooks() {
	afterEach(async () => {
		const cleanupErrors: unknown[] = [];
		try {
			await live.settleBeforeUnmount?.();
		} catch (error) {
			cleanupErrors.push(error);
		}
		try {
			await act(async () => live.root?.unmount());
		} catch (error) {
			cleanupErrors.push(error);
		}
		live.root = undefined;
		live.container?.remove();
		live.container = undefined;
		try {
			await queryClient.cancelQueries();
		} catch (error) {
			cleanupErrors.push(error);
		}
		try {
			await live.dispose?.();
		} catch (error) {
			cleanupErrors.push(error);
		} finally {
			live.dispose = undefined;
			live.settleBeforeUnmount = undefined;
			queryClient.clear();
			useNodeStore.setState(previousNodes);
		}
		if (cleanupErrors.length) {
			throw new AggregateError(
				cleanupErrors,
				"Actual mounted consumer cleanup failed"
			);
		}
	});
}
