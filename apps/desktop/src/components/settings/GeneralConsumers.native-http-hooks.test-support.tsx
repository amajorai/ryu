// biome-ignore-all lint/suspicious/noMisplacedAssertion: Shared native-HTTP ledger and conservation helpers run only inside this file's real bun:test cases and hooks.
// The fresh privacy-gate boot and the per-test hooks of the GeneralConsumers
// suites.
import { afterAll, afterEach, beforeEach, expect } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { z } from "zod";
import {
	consumeAll,
	expectClean,
	first,
	observeDom,
	queryClient,
	savedNodeState,
	select,
	unmount,
	useNodeStore,
} from "./GeneralConsumers.native-http.test-support.tsx";
import {
	priorWindowFetchDescriptor,
	savedStorage,
	server,
	windowError,
	windowRejection,
} from "./GeneralConsumers.native-http-peer.test-support.tsx";
import {
	atomicWrite,
	calls,
	fixtureTimers,
	holds,
	live,
	localConservation,
	NativeResponse,
	nativeClearTimeout,
	nativeSetTimeout,
	ownedDirectory,
	ownsDom,
	priorActDescriptor,
	priorFetchDescriptor,
	restoreStorage,
	seedDocument,
	storageSnapshot,
	writeDocument,
} from "./GeneralConsumers.native-http-store.test-support.tsx";

export async function freshGateBoot() {
	const snapshot = storageSnapshot();
	const path = join(ownedDirectory, "saved-browser-storage.json");
	atomicWrite(path, JSON.stringify(snapshot));
	const child = Bun.spawn(
		[
			process.execPath,
			join(import.meta.dir, "privacy-gate-fresh-boot.ts"),
			path,
		],
		{
			cwd: join(import.meta.dir, "../../.."),
			stdout: "pipe",
			stderr: "pipe",
			env: { ...process.env, VITE_POSTHOG_KEY: "", VITE_SENTRY_DSN: "" },
		}
	);
	live.activeChild = child;
	const timeout = nativeSetTimeout(() => {
		child.kill();
	}, 8000);
	fixtureTimers.add(timeout);
	try {
		const [stdout, stderr, exit] = await Promise.all([
			new NativeResponse(child.stdout).text(),
			new NativeResponse(child.stderr).text(),
			child.exited,
		]);
		expect(exit).toBe(0);
		expect(stderr).toBe("");
		const result = z
			.object({
				analytics: z.boolean(),
				crash: z.boolean(),
				storage: z.record(z.string(), z.string()),
				unexpectedHttp: z.array(z.string()),
				ownedDomUnregistered: z.literal(true),
			})
			.strict()
			.parse(JSON.parse(stdout));
		expect(result.storage).toEqual(snapshot);
		expect(result.unexpectedHttp).toEqual([]);
		return result;
	} finally {
		nativeClearTimeout(timeout);
		fixtureTimers.delete(timeout);
		if (child.exitCode === null) {
			child.kill();
		}
		await child.exited;
		live.activeChild = null;
	}
}

/** The per-test setup and teardown every suite on this harness registers. */
export function registerGeneralConsumersHooks() {
	beforeEach(() => {
		expectClean();
		calls.length = 0;
		holds.length = 0;
		for (const node of ["a", "b"] as const) {
			writeDocument(node, seedDocument(node));
		}
		// Per-case initial conditions only. Reload/fresh-mount witnesses never clear
		// or reseed either peer documents or Storage.
		restoreStorage({
			...savedStorage,
			...localConservation,
			"ryu:product-analytics-enabled": "false",
			"ryu:crash-reports-enabled": "false",
		});
		localStorage.removeItem("ryu_session_token");
		localStorage.removeItem("ryu_oidc_user");
		queryClient.clear();
		select(first);
		observeDom();
	});
	afterEach(async () => {
		const failures: unknown[] = [];
		for (const hold of holds) {
			hold.release();
		}
		try {
			await consumeAll();
		} catch (error) {
			failures.push(error);
		}
		try {
			await unmount();
		} catch (error) {
			failures.push(error);
		}
		live.domObserver?.disconnect();
		live.domObserver = null;
		try {
			expect(
				queryClient
					.getQueryCache()
					.getAll()
					.every((query) => query.getObserversCount() === 0)
			).toBe(true);
		} catch (error) {
			failures.push(error);
		}
		queryClient.clear();
		try {
			expectClean();
		} catch (error) {
			failures.push(error);
		}
		useNodeStore.setState(savedNodeState);
		if (failures.length) {
			throw new AggregateError(
				failures,
				"Actual General consumer teardown failed"
			);
		}
	});
	afterAll(async () => {
		const failures: unknown[] = [];
		try {
			await server.stop();
			await consumeAll();
			expectClean();
		} catch (error) {
			failures.push(error);
		} finally {
			window.removeEventListener("error", windowError);
			window.removeEventListener("unhandledrejection", windowRejection);
			restoreStorage(savedStorage);
			if (priorWindowFetchDescriptor) {
				Object.defineProperty(window, "fetch", priorWindowFetchDescriptor);
			} else {
				Reflect.deleteProperty(window, "fetch");
			}
			if (priorFetchDescriptor) {
				Object.defineProperty(globalThis, "fetch", priorFetchDescriptor);
			} else {
				Reflect.deleteProperty(globalThis, "fetch");
			}
			if (priorActDescriptor) {
				Object.defineProperty(
					globalThis,
					"IS_REACT_ACT_ENVIRONMENT",
					priorActDescriptor
				);
			} else {
				Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
			}
			if (ownsDom) {
				await GlobalRegistrator.unregister();
			}
			rmSync(ownedDirectory, { recursive: true, force: true });
		}
		if (failures.length) {
			throw new AggregateError(
				failures,
				"Actual native peer final closure failed"
			);
		}
	});
}
