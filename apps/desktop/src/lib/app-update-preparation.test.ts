import { describe, expect, it } from "bun:test";
import type { AppResponseValue } from "@ryuhq/core-client/app-request-json.ts";
import {
	createAppUpdatePreparationCoordinator,
	type PrepareAppUpdateRequest,
	type PreparedAppUpdate,
} from "./app-update-preparation.ts";

function prepared(version = "0.2.1"): PreparedAppUpdate {
	return {
		artifactFile: `ryu-update-${version}.bin`,
		artifactSize: 4096,
		schemaVersion: 1,
		signature: "signed-fixture",
		source: { kind: "stable" },
		version,
	};
}

describe("app update preparation coordinator", () => {
	it("rejects a completion for another release without publishing it and permits explicit retry", async () => {
		const original = prepared("0.2.1");
		const wanted = prepared("0.3.0");
		let attempts = 0;
		const coordinator = createAppUpdatePreparationCoordinator((command) => {
			if (command === "get_prepared_app_update") {
				return Promise.resolve(original);
			}
			attempts += 1;
			return Promise.resolve(attempts === 1 ? original : wanted);
		});
		await coordinator.refresh();
		const seen: string[] = [];
		const unsubscribe = coordinator.subscribe(() =>
			seen.push(coordinator.getSnapshot().kind)
		);
		const request = {
			expectedVersion: "0.3.0",
			source: { kind: "stable" },
		} satisfies PrepareAppUpdateRequest;
		await expect(coordinator.prepare(request)).rejects.toThrow(
			"different version"
		);
		expect(coordinator.getSnapshot()).toEqual({
			kind: "ready",
			update: original,
		});
		expect(seen).toEqual([]);
		await expect(coordinator.prepare(request)).resolves.toEqual(wanted);
		expect(attempts).toBe(2);
		expect(seen).toEqual(["ready"]);
		unsubscribe();
		await coordinator.refresh();
		expect(seen).toEqual(["ready"]);
	});

	it("defaults automatic downloading on when Tauri is unavailable", async () => {
		const coordinator = createAppUpdatePreparationCoordinator(() =>
			Promise.reject(new Error("not running in Tauri"))
		);

		await expect(coordinator.getAutomaticDownload()).resolves.toBe(true);
	});

	it("deduplicates concurrent preparation of the same version", async () => {
		const calls: string[] = [];
		let finish: ((value: AppResponseValue) => void) | undefined;
		const coordinator = createAppUpdatePreparationCoordinator((command) => {
			calls.push(command);
			return new Promise((resolve) => {
				finish = resolve;
			});
		});
		const request = {
			expectedVersion: "0.2.1",
			source: { kind: "stable" },
		} satisfies PrepareAppUpdateRequest;

		const first = coordinator.prepare(request);
		const second = coordinator.prepare(request);
		expect(first).toBe(second);
		finish?.(prepared());

		await expect(first).resolves.toEqual(prepared());
		expect(calls).toEqual(["prepare_app_update"]);
		expect(coordinator.getSnapshot()).toEqual({
			kind: "ready",
			update: prepared(),
		});
	});

	it("rejects malformed prepared state at the IPC boundary", async () => {
		const coordinator = createAppUpdatePreparationCoordinator(() =>
			Promise.resolve({
				artifactFile: "../../outside",
				artifactSize: 1,
				kind: "stable",
			})
		);

		await expect(coordinator.refresh()).rejects.toThrow(
			"Invalid prepared app update"
		);
	});

	it("installs only the already prepared artifact", async () => {
		const calls: string[] = [];
		const coordinator = createAppUpdatePreparationCoordinator((command) => {
			calls.push(command);
			return Promise.resolve(command === "install_prepared_app_update");
		});

		await expect(coordinator.install()).resolves.toBe(true);
		expect(calls).toEqual(["install_prepared_app_update"]);
		expect(coordinator.getSnapshot()).toEqual({ kind: "empty" });
	});

	it("keeps a prepared update when installation is cancelled", async () => {
		const coordinator = createAppUpdatePreparationCoordinator((command) =>
			Promise.resolve(command === "get_prepared_app_update" ? prepared() : null)
		);
		await coordinator.refresh();
		await expect(coordinator.install()).resolves.toBeNull();
		expect(coordinator.getSnapshot()).toEqual({
			kind: "ready",
			update: prepared(),
		});
	});

	it("keeps a prepared update after an installer failure", async () => {
		const coordinator = createAppUpdatePreparationCoordinator((command) => {
			if (command === "get_prepared_app_update") {
				return Promise.resolve(prepared());
			}
			return Promise.reject(new Error("Installer failed"));
		});
		await coordinator.refresh();
		await expect(coordinator.install()).rejects.toThrow("Installer failed");
		expect(coordinator.getSnapshot()).toEqual({
			kind: "ready",
			update: prepared(),
		});
	});

	it("publishes ready and cleared state changes to subscribers", async () => {
		const coordinator = createAppUpdatePreparationCoordinator((command) => {
			if (command === "get_prepared_app_update") {
				return Promise.resolve(prepared());
			}
			return Promise.resolve(null);
		});
		const seen: string[] = [];
		const unsubscribe = coordinator.subscribe(() => {
			seen.push(coordinator.getSnapshot().kind);
		});

		await coordinator.refresh();
		await coordinator.clear();
		unsubscribe();

		expect(seen).toEqual(["ready", "empty"]);
	});

	it("a refresh begun before a newer preparation cannot publish the stale artifact", async () => {
		let finishRefresh: ((value: AppResponseValue) => void) | undefined;
		const calls: string[] = [];
		const coordinator = createAppUpdatePreparationCoordinator((command) => {
			calls.push(command);
			if (command === "get_prepared_app_update") {
				return new Promise((resolve) => {
					finishRefresh = resolve;
				});
			}
			return Promise.resolve(prepared("0.3.0"));
		});
		const staleRefresh = coordinator.refresh();
		await coordinator.prepare({
			expectedVersion: "0.3.0",
			source: { kind: "stable" },
		});
		finishRefresh?.(prepared("0.2.1"));
		await staleRefresh;
		expect(coordinator.getSnapshot()).toEqual({
			kind: "ready",
			update: prepared("0.3.0"),
		});
		expect(calls).toEqual(["get_prepared_app_update", "prepare_app_update"]);
	});

	it("successful clearing supersedes an earlier pending preparation", async () => {
		let finishPrepare: ((value: AppResponseValue) => void) | undefined;
		const seen: string[] = [];
		const coordinator = createAppUpdatePreparationCoordinator((command) => {
			if (command === "prepare_app_update") {
				return new Promise((resolve) => {
					finishPrepare = resolve;
				});
			}
			return Promise.resolve(null);
		});
		coordinator.subscribe(() => {
			seen.push(coordinator.getSnapshot().kind);
		});
		const stalePreparation = coordinator.prepare({
			expectedVersion: "0.2.1",
			source: { kind: "stable" },
		});
		expect(await coordinator.clear()).toBe(true);
		finishPrepare?.(prepared());
		await stalePreparation;
		expect(coordinator.getSnapshot()).toEqual({ kind: "empty" });
		expect(seen).toEqual(["empty"]);
	});

	it("failed clearing preserves ready state and leaves installation retryable", async () => {
		const calls: string[] = [];
		const coordinator = createAppUpdatePreparationCoordinator((command) => {
			calls.push(command);
			if (command === "get_prepared_app_update") {
				return Promise.resolve(prepared());
			}
			if (command === "clear_prepared_app_update") {
				return Promise.reject(new Error("cache busy"));
			}
			return Promise.resolve(null);
		});
		await coordinator.refresh();
		expect(await coordinator.clear()).toBe(false);
		expect(coordinator.getSnapshot()).toEqual({
			kind: "ready",
			update: prepared(),
		});
		expect(await coordinator.install()).toBeNull();
		expect(coordinator.getSnapshot()).toEqual({
			kind: "ready",
			update: prepared(),
		});
		expect(calls).toEqual([
			"get_prepared_app_update",
			"clear_prepared_app_update",
			"install_prepared_app_update",
		]);
	});

	it("failed clearing does not suppress a pending successful preparation", async () => {
		let finishPrepare: ((value: AppResponseValue) => void) | undefined;
		const coordinator = createAppUpdatePreparationCoordinator((command) => {
			if (command === "prepare_app_update") {
				return new Promise((resolve) => {
					finishPrepare = resolve;
				});
			}
			return Promise.reject(new Error("could not clear"));
		});
		const preparation = coordinator.prepare({
			expectedVersion: "0.2.1",
			source: { kind: "stable" },
		});
		expect(await coordinator.clear()).toBe(false);
		finishPrepare?.(prepared());
		expect(await preparation).toEqual(prepared());
		expect(coordinator.getSnapshot()).toEqual({
			kind: "ready",
			update: prepared(),
		});
	});

	it("a preparation started after successful clearing may publish its ready artifact", async () => {
		let finishPrepare: ((value: AppResponseValue) => void) | undefined;
		const coordinator = createAppUpdatePreparationCoordinator((command) => {
			if (command === "prepare_app_update") {
				return new Promise((resolve) => {
					finishPrepare = resolve;
				});
			}
			return Promise.resolve(null);
		});
		expect(await coordinator.clear()).toBe(true);
		const preparation = coordinator.prepare({
			expectedVersion: "0.3.0",
			source: { kind: "stable" },
		});
		finishPrepare?.(prepared("0.3.0"));
		expect(await preparation).toEqual(prepared("0.3.0"));
		expect(coordinator.getSnapshot()).toEqual({
			kind: "ready",
			update: prepared("0.3.0"),
		});
	});

	it("preparing the same release after clearing does not reuse its superseded promise", async () => {
		const finishes: ((value: AppResponseValue) => void)[] = [];
		const coordinator = createAppUpdatePreparationCoordinator((command) => {
			if (command === "prepare_app_update") {
				return new Promise((resolve) => {
					finishes.push(resolve);
				});
			}
			return Promise.resolve(null);
		});
		const request = {
			expectedVersion: "0.2.1",
			source: { kind: "stable" },
		} satisfies PrepareAppUpdateRequest;
		const before = coordinator.prepare(request);
		expect(await coordinator.clear()).toBe(true);
		const after = coordinator.prepare(request);
		expect(after).not.toBe(before);
		expect(finishes).toHaveLength(2);
		finishes[0]?.(prepared());
		expect(await before).toBeNull();
		expect(coordinator.getSnapshot()).toEqual({ kind: "empty" });
		finishes[1]?.(prepared());
		expect(await after).toEqual(prepared());
		expect(coordinator.getSnapshot()).toEqual({
			kind: "ready",
			update: prepared(),
		});
	});
});

it("validates every prepared native field and retains the established metadata projection", async () => {
	const valid = {
		...prepared(),
		source: { channel: "stable", kind: "tag", tag: " tag " },
		privateNativeField: "excluded",
	} satisfies AppResponseValue;
	const coordinator = createAppUpdatePreparationCoordinator(() =>
		Promise.resolve(valid)
	);
	await expect(coordinator.refresh()).resolves.toEqual({
		...prepared(),
		source: { channel: "stable", kind: "tag", tag: " tag " },
	});
	for (const invalid of [
		{ ...prepared(), artifactFile: "outside\\artifact" },
		{ ...prepared(), artifactSize: 9_007_199_254_740_992 },
		{ ...prepared(), signature: "" },
		{ ...prepared(), source: { kind: "channel", channel: "future" } },
	]) {
		await expect(
			createAppUpdatePreparationCoordinator(() =>
				Promise.resolve(invalid)
			).refresh()
		).rejects.toThrow("Invalid prepared app update returned by Tauri");
	}
});

it("preserves download-preference defaults and rejects invalid native install replies", async () => {
	for (const value of [true, false, null, "false", 1]) {
		const coordinator = createAppUpdatePreparationCoordinator(() =>
			Promise.resolve(value)
		);
		await expect(coordinator.getAutomaticDownload()).resolves.toBe(
			value !== false
		);
	}
	await expect(
		createAppUpdatePreparationCoordinator(() =>
			Promise.resolve("yes")
		).install()
	).rejects.toThrow("Invalid prepared app update install result from Tauri");
});
