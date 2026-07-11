/* @jsxImportSource @opentui/react */
// Gateway tab - read-only gateway observability + policy snapshot.
//
// Parity target: apps/cli render_gateway_content (apps/cli/src/ui.rs ~1258-1411).
// The Rust TUI shows a single bordered panel with:
//   - status   ● online / ○ offline   (from reachable)
//   - url       (gateway base url)
//   - routing   (default routing target, or —)
//   - firewall  ● enabled / ○ disabled
//   - dlp       ● enabled / ○ disabled
//   - budget    ● enabled / ○ disabled
//   - requests  total request count (only when reachable + metrics present)
//   - footer    "read-only — edit gateway policy in the desktop app"
//
// Data sourcing - mirror the Rust exactly. Core's GET /api/gateway/status returns
// `{ reachable, url, health, metrics, effective_config }` where `effective_config`
// is the parsed gateway.toml read from disk (apps/core/src/server/mod.rs
// gateway_status ~11065) and is therefore present even when the gateway PROCESS is
// down. apps/cli reads every policy indicator from that `effective_config` with
// `unwrap_or(false)` defaults, so we read the same JSON paths with the same
// fall-to-false behaviour and match by construction. We deliberately do NOT use
// the typed core-client fetchGatewayStatus (it normalizes effective_config away)
// or a second fetchGatewayConfig call (it 502s when the gateway is down - the very
// state this panel exists to report), instead doing one raw request, like the Rust
// client's single fetch_gateway_status.
//
// The Rust client refreshes status in the background while the tab is active
// (main.rs ~2617) and has no tab-local interactive keys beyond the shell globals
// (q/tab); we add a background poll plus a manual `r` refresh.

import { useKeyboard } from "@opentui/react";
import { request } from "@ryuhq/core-client/client";
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTheme } from "@/components/ui/theme-provider.tsx";
import { useCore } from "../core/CoreContext.tsx";
import { ErrorView } from "../ui/ErrorView.tsx";
import { Loading } from "../ui/Loading.tsx";
import { useToast } from "../ui/toast.tsx";
import type { TabProps } from "./types.ts";

const REFRESH_INTERVAL_MS = 5000;
const KEY_WIDTH = 10;

// Raw wire shape of GET /api/gateway/status. `metrics` and `effective_config` are
// passed through verbatim by Core (raw gateway /metrics, parsed gateway.toml), so
// they stay `unknown`-typed and are read via the narrowing getters below.
interface RawStatus {
	effective_config?: unknown;
	metrics?: unknown;
	reachable?: boolean;
	url?: string;
}

type LoadState =
	| { kind: "idle" }
	| { kind: "loading" }
	| { kind: "ready"; raw: RawStatus }
	| { kind: "error"; message: string };

function errText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

// ── Narrowing getters (biome-clean, no `any`) ────────────────────────────────

function asRecord(value: unknown): Record<string, unknown> | null {
	if (value && typeof value === "object" && !Array.isArray(value)) {
		return value as Record<string, unknown>;
	}
	return null;
}

// Walk an object path, returning the leaf value or undefined if any hop is missing
// or not an object. Mirrors the Rust chain of `.get(...).and_then(...)`.
function getPath(root: unknown, ...keys: string[]): unknown {
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

function asBool(value: unknown): boolean {
	return value === true;
}

function asString(value: unknown): string | null {
	return typeof value === "string" ? value : null;
}

function asNumber(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

// ── Indicator derivations (same paths/order as apps/cli) ─────────────────────

// routing.default_model, else routing.default, else "—".
function routingDefault(ec: unknown): string {
	return (
		asString(getPath(ec, "routing", "default_model")) ??
		asString(getPath(ec, "routing", "default")) ??
		"—"
	);
}

// dlp.enabled, falling back to pii.enabled only when the dlp key is absent
// (matches the Rust `c.get("dlp").or_else(|| c.get("pii"))`).
function dlpEnabled(ec: unknown): boolean {
	const dlp = getPath(ec, "dlp");
	const source = dlp === undefined ? getPath(ec, "pii") : dlp;
	return asBool(getPath(source, "enabled"));
}

// requests_total, else total_requests (apps/cli flat keys), else the nested
// requests.total the gateway emits today - so the count renders whichever shape
// the gateway is on.
function requestsTotal(metrics: unknown): number | null {
	return (
		asNumber(getPath(metrics, "requests_total")) ??
		asNumber(getPath(metrics, "total_requests")) ??
		asNumber(getPath(metrics, "requests", "total"))
	);
}

export function GatewayTab({ active }: TabProps) {
	const { target } = useCore();
	const theme = useTheme();
	const { notify } = useToast();
	const [state, setState] = useState<LoadState>({ kind: "idle" });
	// Guard background polls so a slow request can't overwrite a fresher one and so
	// a refresh never flips an already-rendered panel back to the loading state.
	const reqIdRef = useRef(0);

	const load = useCallback(
		async (background: boolean) => {
			const reqId = ++reqIdRef.current;
			if (!background) {
				setState({ kind: "loading" });
			}
			try {
				// Single raw fetch, like the Rust client. Rejects only when Core itself
				// is unreachable; a down gateway resolves with reachable: false and the
				// on-disk effective_config still populated.
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

	// Initial load + background refresh while active. `load` is stable (it closes
	// over the memoized target, which only changes when the node switches), so it
	// can sit in deps without the fresh-object infinite loop.
	useEffect(() => {
		if (!active) {
			return;
		}
		load(false);
		const handle = setInterval(() => load(true), REFRESH_INTERVAL_MS);
		return () => clearInterval(handle);
	}, [active, load]);

	// Manual refresh (r). Additive over the shell globals - every other key is
	// ignored so q/tab/digits still reach the shell.
	useKeyboard((key) => {
		if (!active) {
			return;
		}
		if (key.name === "r") {
			notify("Refreshing gateway…", "loading");
			load(false);
		}
	});

	return (
		<box flexDirection="column" flexGrow={1} paddingLeft={1} paddingTop={1}>
			<text fg={theme.colors.foreground}>
				<b>Gateway</b>
			</text>
			<box
				borderColor={theme.colors.border}
				borderStyle="rounded"
				flexDirection="column"
				flexGrow={1}
				marginTop={1}
				paddingLeft={1}
				paddingRight={1}
				paddingTop={1}
			>
				<GatewayBody state={state} />
			</box>
		</box>
	);
}

function GatewayBody({ state }: { state: LoadState }) {
	const theme = useTheme();
	if (state.kind === "idle" || state.kind === "loading") {
		return <Loading label="Loading gateway status…" />;
	}
	if (state.kind === "error") {
		// Core itself is unreachable - mirror apps/cli's offline placeholder copy.
		return (
			<ErrorView
				hint="Core may still be starting · press r to retry"
				message="gateway unreachable — Core may still be starting"
			/>
		);
	}
	const { raw } = state;
	const reachable = raw.reachable === true;
	const ec = raw.effective_config;
	const total = reachable ? requestsTotal(raw.metrics) : null;
	const firewallOn = asBool(getPath(ec, "firewall", "enabled"));
	const dlpOn = dlpEnabled(ec);
	const budgetOn = asBool(getPath(ec, "budget", "enabled"));
	return (
		<box flexDirection="column">
			<Indicator
				label="status"
				on={reachable}
				text={reachable ? "online" : "offline"}
			/>
			<Row label="url">
				<text fg={theme.colors.accent}>{asString(raw.url) ?? "—"}</text>
			</Row>
			<Row label="routing">
				<text fg={theme.colors.foreground}>{routingDefault(ec)}</text>
			</Row>
			<Indicator
				label="firewall"
				on={firewallOn}
				text={firewallOn ? "enabled" : "disabled"}
			/>
			<Indicator label="dlp" on={dlpOn} text={dlpOn ? "enabled" : "disabled"} />
			<Indicator
				label="budget"
				on={budgetOn}
				text={budgetOn ? "enabled" : "disabled"}
			/>
			{total === null ? null : (
				<Row label="requests">
					<text fg={theme.colors.foreground}>{String(total)}</text>
				</Row>
			)}
			<box marginTop={1}>
				<text fg={theme.colors.mutedForeground}>
					read-only — edit gateway policy in the desktop app
				</text>
			</box>
		</box>
	);
}

// A single "key   value" row with the muted, fixed-width label apps/cli uses.
function Row({ label, children }: { label: string; children: ReactNode }) {
	const theme = useTheme();
	return (
		<box flexDirection="row" gap={1}>
			<text fg={theme.colors.mutedForeground}>
				{label.padEnd(KEY_WIDTH, " ")}
			</text>
			{children}
		</box>
	);
}

// A row whose value is a status dot + label (● enabled/online, ○ disabled/offline).
function Indicator({
	label,
	on,
	text,
}: {
	label: string;
	on: boolean;
	text: string;
}) {
	const theme = useTheme();
	// online/enabled = solid green dot. The status row's "off" is a red dot
	// (offline); the policy indicators' "off" is a muted dot - matching apps/cli's
	// DANGER-vs-MUTED split.
	const offColor =
		label === "status" ? theme.colors.error : theme.colors.mutedForeground;
	return (
		<Row label={label}>
			<text fg={on ? theme.colors.success : offColor}>{on ? "●" : "○"}</text>
			<text fg={theme.colors.foreground}>{text}</text>
		</Row>
	);
}
