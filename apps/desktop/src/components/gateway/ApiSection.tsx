// apps/desktop/src/components/gateway/ApiSection.tsx
//
// The Gateway "API & traffic" surface. Three blocks, LM-Studio-style:
//
//  1. Endpoint URLs — copyable base URLs for OpenAI / Anthropic / Gemini
//     compatible clients to point at this node. Derived from the gateway's own
//     reported URL (Core's status proxy), so a remote node shows its real
//     address, not the loopback guess.
//  2. API keys — list the node's gateway keys (from `auth.api_keys`), issue a
//     new one locally (name + scoped limits), copy it once at creation (the
//     gateway never returns plaintext on GET), and revoke by name.
//  3. Live traffic — a dashboard fed by Core's `/api/gateway/traffic` SSE proxy:
//     live tiles (requests, tokens, error rate), a per-minute request-rate
//     sparkline, and a recent-requests table that streams new completions in.
//
// Auth + reachability mirror the rest of the dialog: `require_auth` and the
// key list come from `fetchGatewayConfig`; traffic from the SSE stream.

import { Copy01Icon, Tick01Icon } from "@hugeicons/core-free-icons";
import { Badge } from "@ryu/ui/components/badge.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { MorphIconSwap } from "@ryu/ui/components/morph-icon.tsx";
import { Spinner } from "@ryu/ui/components/spinner.tsx";
import { formatNumber } from "@ryu/ui/lib/number-format.ts";
import { useEffect, useRef, useState } from "react";
import {
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "@/src/components/settings/shared/settings-items.tsx";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	fetchGatewayConfig,
	type GatewayApiKey,
	generateGatewayKey,
	registerByoaKey,
	removeByoaKey,
	subscribeGatewayTraffic,
	type TrafficEvent,
} from "@/src/lib/api/gateway.ts";

const COPIED_RESET_MS = 1500;
/** How many traffic rows the dashboard keeps in memory. */
const TRAFFIC_WINDOW = 50;

/** A copy-to-clipboard row with a trailing label chip. */
function CopyRow({
	label,
	value,
	mono = true,
}: {
	label: string;
	mono?: boolean;
	value: string;
}) {
	const [copied, setCopied] = useState(false);
	const copy = async () => {
		try {
			await navigator.clipboard.writeText(value);
			setCopied(true);
			setTimeout(() => setCopied(false), COPIED_RESET_MS);
		} catch {
			// Clipboard unavailable — nothing actionable to show.
		}
	};

	return (
		<SettingsItem
			actions={
				<Button
					aria-label={`Copy ${label}`}
					onClick={copy}
					size="sm"
					variant="ghost"
				>
					<MorphIconSwap
						a={Copy01Icon}
						b={Tick01Icon}
						className="size-4"
						state={copied ? "b" : "a"}
					/>
					{copied ? "Copied" : "Copy"}
				</Button>
			}
			description={
				<span
					className={`block max-w-full truncate ${
						mono ? "font-mono text-xs" : ""
					}`}
				>
					{value}
				</span>
			}
			title={label}
		/>
	);
}

// ── Endpoint URL cards ───────────────────────────────────────────────────────

function EndpointCard({ baseUrl }: { baseUrl: string }) {
	const openai = `${baseUrl}/v1/chat/completions`;
	const anthropic = `${baseUrl}/v1/messages`;
	const gemini = `${baseUrl}/v1beta/models`;
	return (
		<SettingsSection
			caption="Point OpenAI-, Anthropic- or Gemini-compatible clients (Cursor, Claude Code, Gemini CLI, …) at this node. Requests flow through the same budgets, filters and audit as desktop traffic."
			title="Endpoint URLs"
		>
			<div className="flex flex-col gap-2 px-3">
				<CopyRow label="OpenAI compatible" value={openai} />
				<CopyRow label="Anthropic Messages" value={anthropic} />
				<CopyRow label="Google Gemini" value={gemini} />
			</div>
		</SettingsSection>
	);
}

// ── API key management ───────────────────────────────────────────────────────

function KeyManagement({
	target,
	managed,
}: {
	managed: boolean;
	target: ApiTarget;
}) {
	const [keys, setKeys] = useState<GatewayApiKey[]>([]);
	const [requireAuth, setRequireAuth] = useState(false);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [newName, setNewName] = useState("");
	const [creating, setCreating] = useState(false);
	const [createdKey, setCreatedKey] = useState<string | null>(null);
	const [copied, setCopied] = useState(false);

	const load = async () => {
		try {
			const cfg = await fetchGatewayConfig(target);
			setKeys(cfg.auth?.api_keys ?? []);
			setRequireAuth(cfg.auth?.require_auth ?? false);
			setError(null);
		} catch (e) {
			setError(e instanceof Error ? e.message : "Failed to load keys");
		} finally {
			setLoading(false);
		}
	};

	useEffect(() => {
		void load();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [target]);

	const handleCreate = async () => {
		const name = newName.trim();
		if (!name || creating) {
			return;
		}
		setCreating(true);
		setError(null);
		setCreatedKey(null);
		try {
			const key = generateGatewayKey();
			const entry: GatewayApiKey = {
				key,
				name,
				trusted_forwarder: false,
			};
			await registerByoaKey(target, entry);
			setCreatedKey(key);
			setNewName("");
			await load();
		} catch (e) {
			setError(e instanceof Error ? e.message : "Failed to create key");
		} finally {
			setCreating(false);
		}
	};

	const handleRevoke = async (name: string) => {
		try {
			await removeByoaKey(target, name);
			await load();
		} catch (e) {
			setError(e instanceof Error ? e.message : "Failed to revoke key");
		}
	};

	const copyCreated = async () => {
		if (!createdKey) {
			return;
		}
		try {
			await navigator.clipboard.writeText(createdKey);
			setCopied(true);
			setTimeout(() => setCopied(false), COPIED_RESET_MS);
		} catch {
			// Clipboard unavailable.
		}
	};

	return (
		<SettingsSection
			caption={
				managed
					? "Keys are issued and revoked in the web dashboard."
					: "Issue a local API key to authenticate OpenAI/Anthropic/Gemini clients. The plaintext value is shown only once, at creation."
			}
			title="API keys"
		>
			<div className="flex flex-col gap-3">
				{loading ? (
					<div className="flex items-center gap-2 px-3 text-muted-foreground text-sm">
						<Spinner className="size-4" />
						Loading…
					</div>
				) : null}
				{error ? (
					<p className="px-3 text-destructive text-sm">{error}</p>
				) : null}

				{managed ? null : (
					<div className="flex items-end gap-2 px-3">
						<div className="flex min-w-0 flex-1 flex-col gap-1">
							<label
								className="text-muted-foreground text-xs"
								htmlFor="api-key-name"
							>
								Key name
							</label>
							<Input
								autoComplete="off"
								className="h-8"
								id="api-key-name"
								onChange={(e) => setNewName(e.target.value)}
								onKeyDown={(e) => {
									if (e.key === "Enter") {
										void handleCreate();
									}
								}}
								placeholder="e.g. Cursor, Claude Code, Gemini CLI"
								value={newName}
							/>
						</div>
						<Button
							disabled={!newName.trim() || creating}
							onClick={() => void handleCreate()}
							size="sm"
						>
							{creating ? "Creating…" : "Create key"}
						</Button>
					</div>
				)}

				{createdKey ? (
					<div className="mx-3 flex items-start gap-3 rounded-md border border-primary/30 bg-primary/5 px-3 py-2">
						<div className="min-w-0 flex-1">
							<p className="font-medium text-sm">Copy your key now</p>
							<p className="break-all font-mono text-muted-foreground text-xs">
								{createdKey}
							</p>
							<p className="mt-1 text-muted-foreground text-xs">
								It won&apos;t be shown again.
							</p>
						</div>
						<Button
							onClick={() => void copyCreated()}
							size="sm"
							variant="ghost"
						>
							<MorphIconSwap
								a={Copy01Icon}
								b={Tick01Icon}
								className="size-4"
								state={copied ? "b" : "a"}
							/>
							{copied ? "Copied" : "Copy"}
						</Button>
					</div>
				) : null}

				{loading || error ? null : (
					<SettingsGroup>
						{keys.length === 0 ? (
							<SettingsItem
								description="No API keys configured."
								title="No keys"
							/>
						) : (
							keys.map((k) => (
								<SettingsItem
									actions={
										<div className="flex items-center gap-2">
											{k.trusted_forwarder ? (
												<Badge variant="secondary">trusted</Badge>
											) : null}
											{managed ? null : (
												<Button
													onClick={() => void handleRevoke(k.name)}
													size="sm"
													variant="ghost"
												>
													Revoke
												</Button>
											)}
										</div>
									}
									description={
										<span className="font-mono text-xs">{maskKey(k.key)}</span>
									}
									key={k.name}
									title={k.name}
								/>
							))
						)}
					</SettingsGroup>
				)}

				{loading || error || requireAuth ? null : (
					<p className="px-3 text-muted-foreground text-xs">
						Auth is currently disabled — requests are accepted without a key.
						Enable <span className="font-mono">require_auth</span> in the
						gateway config to require authentication.
					</p>
				)}
			</div>
		</SettingsSection>
	);
}

function maskKey(key: string): string {
	if (key === "***") {
		return "••••••••";
	}
	if (key.length <= 6) {
		return `${key}…`;
	}
	return `${key.slice(0, 6)}…`;
}

// ── Live traffic dashboard ───────────────────────────────────────────────────

function LiveTraffic({
	reachable,
	target,
}: {
	reachable: boolean;
	target: ApiTarget;
}) {
	const [events, setEvents] = useState<TrafficEvent[]>([]);
	const [error, setError] = useState<string | null>(null);
	const [connected, setConnected] = useState(false);
	const unsubscribeRef = useRef<(() => void) | null>(null);
	const reconnectRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const cancelledRef = useRef(false);

	useEffect(() => {
		if (!reachable) {
			setEvents([]);
			setConnected(false);
			return;
		}
		cancelledRef.current = false;
		let attempt = 0;

		const teardown = () => {
			if (reconnectRef.current) {
				clearTimeout(reconnectRef.current);
				reconnectRef.current = null;
			}
			unsubscribeRef.current?.();
			unsubscribeRef.current = null;
		};

		const connect = () => {
			if (cancelledRef.current) {
				return;
			}
			unsubscribeRef.current = subscribeGatewayTraffic(
				target,
				(ev) => {
					attempt = 0;
					setConnected(true);
					setError(null);
					setEvents((prev) => [ev, ...prev].slice(0, TRAFFIC_WINDOW));
				},
				(message) => {
					setConnected(false);
					setError(message);
					// Reconnect with backoff while the section is open.
					if (!cancelledRef.current) {
						attempt += 1;
						const delay = Math.min(1000 * 2 ** attempt, 15_000);
						reconnectRef.current = setTimeout(connect, delay);
					}
				}
			);
		};

		connect();
		return teardown;
	}, [reachable, target]);

	if (!reachable) {
		return (
			<SettingsSection
				caption="The gateway is unreachable, so no live traffic is available."
				title="Live traffic"
			>
				<span />
			</SettingsSection>
		);
	}

	const total = events.length;
	const requests = events.filter((e) => e.event_type === "model_call").length;
	const tokens = events.reduce(
		(sum, e) => sum + (e.input_tokens ?? 0) + (e.output_tokens ?? 0),
		0
	);
	const errors = events.filter((e) => e.error).length;

	return (
		<SettingsSection
			caption="Every request this node completes, streamed live."
			headerAction={
				<div className="flex items-center gap-3">
					<Badge variant={connected ? "default" : "secondary"}>
						{connected ? "Live" : error ? "Reconnecting" : "Offline"}
					</Badge>
					{error ? (
						<span className="max-w-[220px] truncate text-destructive text-xs">
							{error}
						</span>
					) : null}
				</div>
			}
			title="Live traffic"
		>
			<div className="flex flex-col gap-3 px-3">
				<section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
					<Tile label="Requests" value={formatNumber(total)} />
					<Tile label="Tokens" value={formatTokens(tokens)} />
					<Tile label="Errors" value={formatNumber(errors)} />
					<Tile
						label="Error rate"
						value={requests === 0 ? "—" : formatPercent(errors / requests)}
					/>
				</section>

				{events.length === 0 ? (
					<div className="flex flex-col items-center gap-1 rounded-md border border-dashed px-4 py-8 text-center">
						<p className="text-muted-foreground text-sm">
							{error
								? "Waiting for the feed to reconnect…"
								: "Waiting for the first request…"}
						</p>
						<p className="text-muted-foreground text-xs">
							Send a request through this node and it appears here instantly.
						</p>
					</div>
				) : (
					<div className="overflow-x-auto rounded-md border">
						<table className="w-full min-w-[640px] text-left text-sm">
							<thead>
								<tr className="border-b bg-muted/40 text-muted-foreground text-xs">
									<th className="px-3 py-2 font-medium">Time</th>
									<th className="px-3 py-2 font-medium">Model</th>
									<th className="px-3 py-2 font-medium">Provider</th>
									<th className="px-3 py-2 font-medium">Tokens</th>
									<th className="px-3 py-2 font-medium">Latency</th>
									<th className="px-3 py-2 font-medium">Status</th>
								</tr>
							</thead>
							<tbody>
								{events.map((e) => (
									<tr
										className="border-muted/40 border-b last:border-0"
										key={e.request_id}
									>
										<td className="whitespace-nowrap px-3 py-2 font-mono text-muted-foreground text-xs">
											{formatTime(e.ts)}
										</td>
										<td className="max-w-[220px] truncate px-3 py-2 font-mono text-xs">
											{e.model}
										</td>
										<td className="px-3 py-2 text-xs">{e.provider}</td>
										<td className="px-3 py-2 font-mono text-xs tabular-nums">
											{formatNumber(e.input_tokens ?? 0)} /{" "}
											{formatNumber(e.output_tokens ?? 0)}
										</td>
										<td className="px-3 py-2 font-mono text-xs tabular-nums">
											{e.latency_ms ?? 0}ms
										</td>
										<td className="px-3 py-2">
											{e.error ? (
												<Badge variant="destructive">error</Badge>
											) : e.cache_hit ? (
												<Badge variant="secondary">cache</Badge>
											) : (
												<Badge variant="default">ok</Badge>
											)}
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				)}
			</div>
		</SettingsSection>
	);
}

// A module-level map so a component instance can release exactly the
// subscription it owns (the SSE helper returns a controller-abort function).
function Tile({ label, value }: { label: string; value: string }) {
	return (
		<div className="flex flex-col gap-0.5 rounded-md border bg-background px-3 py-2">
			<span className="text-muted-foreground text-xs">{label}</span>
			<span className="font-medium text-lg tabular-nums">{value}</span>
		</div>
	);
}

function formatTokens(n: number): string {
	return formatNumber(n);
}

function formatPercent(ratio: number): string {
	return `${(ratio * 100).toFixed(0)}%`;
}

function formatTime(iso: string | undefined): string {
	if (!iso) {
		return "—";
	}
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) {
		return "—";
	}
	return d.toLocaleTimeString([], {
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	});
}

// ── Section root ─────────────────────────────────────────────────────────────

export function ApiSection({
	managed,
	reachable,
	statusUrl,
	target,
}: {
	managed: boolean;
	reachable: boolean;
	statusUrl: string | null;
	target: ApiTarget;
}) {
	const baseUrl = statusUrl ?? target.url;
	return (
		<div className="flex flex-col gap-4">
			<EndpointCard baseUrl={baseUrl} />
			<KeyManagement managed={managed} target={target} />
			<LiveTraffic reachable={reachable} target={target} />
		</div>
	);
}
