// Gateway status fetch + narrowing helpers, reused from the legacy read-only
// snapshot in src/tabs/gateway.tsx. One raw GET /api/gateway/status call (like the
// Rust client) returns `{ reachable, url, health, metrics, effective_config }`.
// `effective_config` is the on-disk gateway.toml and stays populated even when the
// gateway PROCESS is down, so every policy indicator is read from it with
// fall-to-false defaults. We deliberately do NOT use the typed fetchGatewayStatus
// (it normalizes effective_config away) or fetchGatewayConfig (it 502s when the
// gateway is down — the very state this overlay exists to report), instead doing
// the single raw fetch the Rust client does.

import { request } from "@ryuhq/core-client/client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useCore } from "../../core/CoreContext.tsx";

const REFRESH_INTERVAL_MS = 5000;

// Raw wire shape of GET /api/gateway/status. `health`, `metrics`, and
// `effective_config` are passed through verbatim by Core, so they stay
// `unknown`-typed and are read via the narrowing getters below.
export interface RawStatus {
	effective_config?: unknown;
	health?: unknown;
	metrics?: unknown;
	reachable?: boolean;
	url?: string;
}

export type LoadState =
	| { kind: "idle" }
	| { kind: "loading" }
	| { kind: "ready"; raw: RawStatus }
	| { kind: "error"; message: string };

export function errText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function asRecord(value: unknown): Record<string, unknown> | null {
	if (value && typeof value === "object" && !Array.isArray(value)) {
		return value as Record<string, unknown>;
	}
	return null;
}

// Walk an object path, returning the leaf value or undefined if any hop is missing
// or not an object. Mirrors the Rust chain of `.get(...).and_then(...)`.
export function getPath(root: unknown, ...keys: string[]): unknown {
	let current: unknown = root;
	for (const key of keys) {
		const record = asRecord(current);
		if (!record) {
			return;
		}
		current = record[key];
	}
	return current;
}

export function asBool(value: unknown): boolean {
	return value === true;
}

export function asString(value: unknown): string | null {
	return typeof value === "string" ? value : null;
}

export function asNumber(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function asStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) {
		return [];
	}
	return value.filter((item): item is string => typeof item === "string");
}

// routing.default_model, else routing.default_provider, else routing.default.
export function routingDefault(ec: unknown): string {
	return (
		asString(getPath(ec, "routing", "default_model")) ??
		asString(getPath(ec, "routing", "default_provider")) ??
		asString(getPath(ec, "routing", "default")) ??
		"—"
	);
}

// dlp.enabled, falling back to pii.enabled only when the dlp key is absent
// (matches the Rust `c.get("dlp").or_else(|| c.get("pii"))`).
export function dlpEnabled(ec: unknown): boolean {
	const dlp = getPath(ec, "dlp");
	const source = dlp === undefined ? getPath(ec, "pii") : dlp;
	return asBool(getPath(source, "enabled"));
}

// requests_total, else total_requests (flat keys), else the nested requests.total
// the gateway emits today.
export function requestsTotal(metrics: unknown): number | null {
	return (
		asNumber(getPath(metrics, "requests_total")) ??
		asNumber(getPath(metrics, "total_requests")) ??
		asNumber(getPath(metrics, "requests", "total"))
	);
}

export interface ModelMapEntry {
	model: string;
	provider: string;
}

// routing.model_map entries, read-only, from the on-disk config.
export function modelMapEntries(ec: unknown): ModelMapEntry[] {
	const map = asRecord(getPath(ec, "routing", "model_map"));
	if (!map) {
		return [];
	}
	const entries: ModelMapEntry[] = [];
	for (const [model, mapping] of Object.entries(map)) {
		entries.push({
			model,
			provider: asString(getPath(mapping, "provider")) ?? "—",
		});
	}
	return entries;
}

// auth.api_keys[].name — the gateway redacts every key value, so only the names
// are surfaced (matching the desktop GatewayKeysCard).
export function apiKeyNames(ec: unknown): string[] {
	const keys = getPath(ec, "auth", "api_keys");
	if (!Array.isArray(keys)) {
		return [];
	}
	const names: string[] = [];
	for (const entry of keys) {
		const name = asString(getPath(entry, "name"));
		if (name) {
			names.push(name);
		}
	}
	return names;
}

export interface GatewayStatusHandle {
	refresh: () => void;
	state: LoadState;
}

// Fetches the raw gateway status once on mount and background-refreshes while the
// overlay is open. Guarded so a slow request can't overwrite a fresher one and a
// refresh never flips an already-rendered panel back to loading. Reads the node
// via useCore() and passes the memoized target to the typed request().
export function useGatewayStatus(): GatewayStatusHandle {
	const { target } = useCore();
	const [state, setState] = useState<LoadState>({ kind: "idle" });
	const reqIdRef = useRef(0);

	const load = useCallback(
		async (background: boolean) => {
			const reqId = ++reqIdRef.current;
			if (!background) {
				setState({ kind: "loading" });
			}
			try {
				const raw = await request<RawStatus>(target, "/api/gateway/status");
				if (reqId === reqIdRef.current) {
					setState({ kind: "ready", raw });
				}
			} catch (err) {
				if (reqId === reqIdRef.current) {
					setState({ kind: "error", message: errText(err) });
				}
			}
		},
		[target]
	);

	useEffect(() => {
		load(false);
		const handle = setInterval(() => load(true), REFRESH_INTERVAL_MS);
		return () => clearInterval(handle);
	}, [load]);

	const refresh = useCallback(() => {
		load(false);
	}, [load]);

	return { state, refresh };
}
