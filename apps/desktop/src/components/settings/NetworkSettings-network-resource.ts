// apps/desktop/src/components/settings/NetworkSettings-network-resource.ts
//
// Shared node-scoped lifetime and write-serialization helpers for the network
// settings cards (split out of NetworkSettings.tsx).

import { useEffect, useRef } from "react";
import { useActiveTarget } from "@/src/hooks/useActiveNode.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";

export function isValidHeadscaleUrl(value: string): boolean {
	const trimmed = value.trim();
	if (!trimmed) {
		return false;
	}
	try {
		const url = new URL(trimmed);
		return (
			(url.protocol === "http:" || url.protocol === "https:") &&
			url.hostname.length > 0
		);
	} catch {
		return false;
	}
}

export function useNetworkTarget(): ApiTarget {
	return useActiveTarget();
}

export function useNetworkOwner() {
	const active = useRef(true);
	useEffect(() => {
		active.current = true;
		return () => {
			active.current = false;
		};
	}, []);
	return active;
}

// Only private queue identities contain credentials. React keys are opaque lifetimes.
function networkResourceKey(target: ApiTarget): string {
	return JSON.stringify([
		target.url.replace(/\/$/, ""),
		target.token,
		target.userJwt ?? null,
	]);
}

export function useNetworkLifetime(target: ApiTarget): number {
	const lifetime = useRef({
		identity: networkResourceKey(target),
		generation: 0,
	});
	const identity = networkResourceKey(target);
	if (lifetime.current.identity !== identity) {
		lifetime.current = {
			identity,
			generation: lifetime.current.generation + 1,
		};
	}
	return lifetime.current.generation;
}

// A settings dialog can disappear while Core is still acknowledging its write.
// Keep those acknowledgments across remounts and serialize the two network cards.
const pendingNetworkWrites = new Map<string, Promise<void>>();
export function writeNetworkResource<T>(
	target: ApiTarget,
	write: () => Promise<T>
): Promise<T> {
	const key = networkResourceKey(target);
	const result = (pendingNetworkWrites.get(key) ?? Promise.resolve()).then(
		write
	);
	const settled = result.then(
		() => undefined,
		() => undefined
	);
	pendingNetworkWrites.set(key, settled);
	void settled.then(() => {
		if (pendingNetworkWrites.get(key) === settled) {
			pendingNetworkWrites.delete(key);
		}
	});
	return result;
}
export async function waitForNetworkWrites(target: ApiTarget): Promise<void> {
	const key = networkResourceKey(target);
	while (pendingNetworkWrites.has(key)) {
		await pendingNetworkWrites.get(key);
	}
}
