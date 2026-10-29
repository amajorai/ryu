// Gateway status fetch + narrowing helpers, reused from the legacy read-only
// snapshot in src/tabs/gateway.tsx. One raw GET /api/gateway/status call (like the
// Rust client) returns `{ reachable, url, health, metrics, effective_config }`.
// `effective_config` is the credential-redacted on-disk gateway.toml and stays
// populated even when the gateway PROCESS is down, so every policy indicator is
// read from it with fall-to-false defaults. We deliberately do NOT use the typed fetchGatewayStatus
// (it normalizes effective_config away) or fetchGatewayConfig (it 502s when the
// gateway is down — the very state this overlay exists to report), instead doing
// the single raw fetch the Rust client does.

import { appResponseValueSchema } from "@ryuhq/core-client/app-request-json";
import { request } from "@ryuhq/core-client/client";
import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";
import { useCore } from "../../core/CoreContext.tsx";

const REFRESH_INTERVAL_MS = 5000;

// Core owns these evolving JSON payloads; preserve their fields at the I/O boundary.
const gatewayStatusJsonSchema = z.json();
export type GatewayStatusValue =
	| z.infer<typeof gatewayStatusJsonSchema>
	| undefined;
const gatewayStatusRecordSchema = z.record(z.string(), gatewayStatusJsonSchema);
type GatewayStatusRecord = z.infer<typeof gatewayStatusRecordSchema>;
const gatewayStatusScalarSchema = z.union([
	z.string(),
	z.number(),
	z.boolean(),
	z.null(),
]);
const gatewayStatusStringSchema = z.string();
const gatewayStatusNumberSchema = z.number();
const gatewayStatusErrorSchema = z.instanceof(Error);
export const rawGatewayStatusSchema = z.object({
	effective_config: gatewayStatusJsonSchema.optional(),
	health: gatewayStatusJsonSchema.optional(),
	metrics: gatewayStatusJsonSchema.optional(),
	reachable: z.boolean().optional().catch(undefined),
	url: gatewayStatusStringSchema.optional().catch(undefined),
});
export type RawStatus = z.infer<typeof rawGatewayStatusSchema>;

export type LoadState =
	| { kind: "idle" }
	| { kind: "loading" }
	| { kind: "ready"; raw: RawStatus }
	| { kind: "error"; message: string };

export function errText(
	err: Parameters<typeof gatewayStatusErrorSchema.safeParse>[0]
): string {
	const parsed = gatewayStatusErrorSchema.safeParse(err);
	return parsed.success ? parsed.data.message : String(err);
}
function isGatewayStatusRecord(
	value: GatewayStatusValue
): value is GatewayStatusRecord {
	return (
		value !== undefined &&
		!Array.isArray(value) &&
		!gatewayStatusScalarSchema.safeParse(value).success
	);
}
function asRecord(value: GatewayStatusValue): GatewayStatusRecord | null {
	return isGatewayStatusRecord(value) ? value : null;
}

// Walk an object path, returning the leaf value or undefined if any hop is missing
// or not an object. Mirrors the Rust chain of `.get(...).and_then(...)`.
export function getPath(
	root: GatewayStatusValue,
	...keys: string[]
): GatewayStatusValue {
	let current: GatewayStatusValue = root;
	for (const key of keys) {
		const record = asRecord(current);
		if (!record) {
			return;
		}
		current = record[key];
	}
	return current;
}

export function asBool(value: GatewayStatusValue): boolean {
	return value === true;
}

export function asString(value: GatewayStatusValue): string | null {
	const parsed = gatewayStatusStringSchema.safeParse(value);
	return parsed.success ? parsed.data : null;
}

export function asNumber(value: GatewayStatusValue): number | null {
	const parsed = gatewayStatusNumberSchema.safeParse(value);
	return parsed.success ? parsed.data : null;
}

export function asStringArray(value: GatewayStatusValue): string[] {
	if (!Array.isArray(value)) {
		return [];
	}
	return value.flatMap((item) => {
		const parsed = gatewayStatusStringSchema.safeParse(item);
		return parsed.success ? [parsed.data] : [];
	});
}

// routing.default_model, else routing.default_provider, else routing.default.
export function routingDefault(ec: GatewayStatusValue): string {
	return (
		asString(getPath(ec, "routing", "default_model")) ??
		asString(getPath(ec, "routing", "default_provider")) ??
		asString(getPath(ec, "routing", "default")) ??
		"—"
	);
}

// dlp.enabled, falling back to pii.enabled only when the dlp key is absent
// (matches the Rust `c.get("dlp").or_else(|| c.get("pii"))`).
export function dlpEnabled(ec: GatewayStatusValue): boolean {
	const dlp = getPath(ec, "dlp");
	const source = dlp === undefined ? getPath(ec, "pii") : dlp;
	return asBool(getPath(source, "enabled"));
}

// requests_total, else total_requests (flat keys), else the nested requests.total
// the gateway emits today.
export function requestsTotal(metrics: GatewayStatusValue): number | null {
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
export function modelMapEntries(ec: GatewayStatusValue): ModelMapEntry[] {
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
export function apiKeyNames(ec: GatewayStatusValue): string[] {
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
	const lifetimeRef = useRef(false);
	const targetRef = useRef(target);
	targetRef.current = target;
	const inFlightRef = useRef<AbortController | null>(null);

	const load = useCallback(
		async (background: boolean) => {
			if (!lifetimeRef.current || targetRef.current !== target) {
				return;
			}
			if (background && inFlightRef.current) {
				return;
			}
			inFlightRef.current?.abort();
			const controller = new AbortController();
			inFlightRef.current = controller;
			const reqId = ++reqIdRef.current;
			if (!background) {
				setState({ kind: "loading" });
			}
			try {
				const raw = rawGatewayStatusSchema.parse(
					await request(
						target,
						"/api/gateway/status",
						{
							signal: controller.signal,
						},
						appResponseValueSchema
					)
				);
				if (!controller.signal.aborted && reqId === reqIdRef.current) {
					setState({ kind: "ready", raw });
				}
			} catch (err) {
				if (!controller.signal.aborted && reqId === reqIdRef.current) {
					setState({ kind: "error", message: errText(err) });
				}
			} finally {
				if (inFlightRef.current === controller) {
					inFlightRef.current = null;
				}
			}
		},
		[target]
	);

	useEffect(() => {
		lifetimeRef.current = true;
		load(false);
		const handle = setInterval(() => load(true), REFRESH_INTERVAL_MS);
		return () => {
			lifetimeRef.current = false;
			reqIdRef.current++;
			clearInterval(handle);
			inFlightRef.current?.abort();
			inFlightRef.current = null;
		};
	}, [load]);

	const refresh = useCallback(() => {
		load(false);
	}, [load]);

	return { state, refresh };
}
