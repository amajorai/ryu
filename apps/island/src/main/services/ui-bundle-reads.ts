import { z } from "zod";
import type { PluginUiBundleResult } from "../../shared/ipc.ts";
import { coreConfigGeneration } from "./config.ts";
import { pluginUiBundle } from "./plugin-host.ts";

interface ReadOwner {
	id: number;
	once(event: "destroyed", listener: () => void): void;
	removeListener(event: "destroyed", listener: () => void): void;
}
interface OwnerReads {
	destroyed: () => void;
	owner: ReadOwner;
	reads: Map<string, AbortController>;
}
const owners = new Map<number, OwnerReads>();
const UI_BUNDLE_CACHE_MS = 60_000;
interface CachedUiBundle {
	expiresAt: number;
	value: PluginUiBundleResult;
}
const uiBundleCache = new Map<string, CachedUiBundle>();
let cacheGeneration = -1;

function currentGeneration(): number {
	const generation = coreConfigGeneration();
	if (generation !== cacheGeneration) {
		uiBundleCache.clear();
		cacheGeneration = generation;
	}
	return generation;
}

function cachedUiBundle(pluginId: string): PluginUiBundleResult | undefined {
	const entry = uiBundleCache.get(pluginId);
	if (!entry) {
		return undefined;
	}
	if (entry.expiresAt <= Date.now()) {
		uiBundleCache.delete(pluginId);
		return undefined;
	}
	return entry.value;
}

function rememberUiBundle(
	pluginId: string,
	value: PluginUiBundleResult,
	generation: number
): PluginUiBundleResult {
	if (currentGeneration() !== generation) {
		return { available: false, reason: "Core configuration changed" };
	}
	if (value.available && value.code !== null) {
		uiBundleCache.set(pluginId, {
			expiresAt: Date.now() + UI_BUNDLE_CACHE_MS,
			value,
		});
	}
	return value;
}

/** Cancellation is scoped to the IPC sender, never another window's request. */
export function abortUiBundleRead(ownerId: number, requestId: string): void {
	owners.get(ownerId)?.reads.get(requestId)?.abort();
}

export async function readUiBundle(
	owner: ReadOwner,
	pluginId: string,
	requestId?: string
): Promise<PluginUiBundleResult> {
	const generation = currentGeneration();
	if (requestId === undefined) {
		const cached = cachedUiBundle(pluginId);
		if (cached) {
			return cached;
		}
		const value = await pluginUiBundle(pluginId);
		return rememberUiBundle(pluginId, value, generation);
	}
	if (!z.string().min(1).max(128).safeParse(requestId).success) {
		return { available: false, reason: "invalid request id" };
	}
	const cached = cachedUiBundle(pluginId);
	if (cached) {
		return cached;
	}
	let entry = owners.get(owner.id);
	if (!entry) {
		const reads = new Map<string, AbortController>();
		const destroyed = () => {
			for (const controller of reads.values()) {
				controller.abort();
			}
			owners.delete(owner.id);
		};
		entry = { owner, reads, destroyed };
		owners.set(owner.id, entry);
		owner.once("destroyed", destroyed);
	}
	if (entry.reads.has(requestId)) {
		return { available: false, reason: "duplicate request id" };
	}
	const controller = new AbortController();
	entry.reads.set(requestId, controller);
	try {
		const value = await pluginUiBundle(pluginId, controller.signal);
		return rememberUiBundle(pluginId, value, generation);
	} finally {
		entry.reads.delete(requestId);
		if (entry.reads.size === 0) {
			entry.owner.removeListener("destroyed", entry.destroyed);
			if (owners.get(owner.id) === entry) {
				owners.delete(owner.id);
			}
		}
	}
}
