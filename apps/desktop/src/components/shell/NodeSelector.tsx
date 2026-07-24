import {
	Add01Icon,
	Alert02Icon,
	ArrowDown01Icon,
	Cancel01Icon,
	CloudServerIcon,
	Copy01Icon,
	CpuIcon,
	Delete01Icon,
	DollarCircleIcon,
	Settings01Icon,
	Share08Icon,
	ViewIcon,
	ViewOffSlashIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "@ryu/blocks/desktop/settings-items";
import { Button } from "@ryu/ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ryu/ui/components/dialog";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@ryu/ui/components/dropdown-menu";
import { Input } from "@ryu/ui/components/input";
import { Progress } from "@ryu/ui/components/progress";
import { Switch } from "@ryu/ui/components/switch";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ryu/ui/components/tooltip";
import { buildRyuDeepLink } from "@ryuhq/protocol/deep-link";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { type ReactNode, useEffect, useState } from "react";
import QRCode from "react-qr-code";
import { sileo } from "sileo";
import { WEB_URL } from "@/lib/app-urls.ts";
import { openExternal } from "@/lib/tauri-bridge.ts";
import { cn } from "@/lib/utils.ts";
import { AgentAutoRoutingEditor } from "@/src/components/agents/AgentAutoRoutingEditor.tsx";
import { GatewayDialog } from "@/src/components/gateway/GatewayDialog.tsx";
import { useSystemStatusContext } from "@/src/contexts/SystemStatusContext.tsx";
import { useCreditsWallet } from "@/src/hooks/useCreditsWallet.ts";
import { useNodeSandboxes } from "@/src/hooks/useNodeSandboxes.ts";
import { useNodeSystemInfo } from "@/src/hooks/useNodeSystemInfo.ts";
import { useNodeVersion } from "@/src/hooks/useNodeVersion.ts";
import { type ApiTarget, currentClientId } from "@/src/lib/api/client.ts";
import {
	type ConnectedClient,
	fetchConnections,
} from "@/src/lib/api/connections.ts";
import { formatMicroUsd } from "@/src/lib/api/credits.ts";
import { fetchActiveEngine } from "@/src/lib/api/engines.ts";
import { fetchGatewayStatus } from "@/src/lib/api/gateway.ts";
import { installAndLaunchIsland } from "@/src/lib/api/island.ts";
import type {
	MeshPeerEntry,
	MeshPeersResult,
	MeshStatus,
} from "@/src/lib/api/mesh.ts";
import {
	BEARER_SOURCE_NONE,
	fetchMeshPeers,
	fetchWebhookIngressStatus,
	type WebhookIngressStatus,
} from "@/src/lib/api/mesh.ts";
import {
	type EngineConcurrency,
	fetchEngineConcurrency,
	fetchSidecarDetails,
	type SidecarDetail,
	startSidecar,
	stopSidecar,
} from "@/src/lib/api/plugins.ts";
import {
	createSandbox,
	destroySandbox,
	type SandboxRun,
	type SandboxSpec,
} from "@/src/lib/api/sandboxes.ts";
import type { SystemInfo } from "@/src/lib/api/system.ts";
import {
	type CatalogItem,
	fetchCatalog,
	fetchDependencies,
	installMissingDeps,
} from "@/src/lib/services-api.ts";
import { useGatewayDialog } from "@/src/store/useGatewayDialog.ts";
import {
	isLocalNode,
	LOCAL_FALLBACK,
	type Node,
	useNodeStore,
} from "@/src/store/useNodeStore.ts";
import { useSettingsDialog } from "@/src/store/useSettingsDialog.ts";
import { AutoScrollText } from "./AutoScrollText.tsx";

interface NodeSelectorProps {
	mode: "persistent-sidebar" | "compact-dropdown";
}

/**
 * Deep-link out to the web org page to provision / manage managed (Ryu Cloud)
 * servers. Server CRUD is web-only (WS4/WS7); the desktop only links out. The
 * `Node` record carries no orgId, so this targets the org list, not a per-server
 * page — the web app resolves the active org and its servers table from there.
 */
function openManageCloudServers() {
	openExternal(`${WEB_URL}/organizations`).catch(() => undefined);
}

type Tone = "green" | "amber" | "red" | "pending";

function resolveTone(
	loading: boolean,
	coreReachable: boolean,
	gatewayReachable: boolean,
	shadowReachable: boolean | null,
	meshReachable: boolean | null
): Tone {
	if (loading) {
		return "pending";
	}
	if (!coreReachable) {
		return "red";
	}
	// Mesh is null-neutral: only `enabled && !reachable` (=== false) contributes
	// amber. A disabled/absent mesh (null) is ignored so a vanilla install never
	// shows a permanent amber dot. Mirrors shadowReachable's null semantics.
	if (
		!gatewayReachable ||
		shadowReachable === false ||
		meshReachable === false
	) {
		return "amber";
	}
	return "green";
}

const TONE_DOT: Record<Tone, string> = {
	green: "bg-success",
	amber: "bg-warning",
	red: "bg-destructive",
	pending: "bg-muted-foreground/40",
};

const displayName = (name: string) =>
	name.charAt(0).toUpperCase() + name.slice(1);

function StatusDot({ online }: { online: boolean | null }) {
	if (online === null) {
		return (
			<span className="size-2 shrink-0 rounded-full bg-muted-foreground/40" />
		);
	}
	return (
		<span
			className={cn(
				"size-2 shrink-0 rounded-full",
				online ? "bg-success" : "bg-warning"
			)}
		/>
	);
}

const GPU_VENDOR_NVIDIA = /^NVIDIA\s+(GeForce\s+)?/i;
const GPU_VENDOR_AMD = /^AMD\s+(Radeon\s+)?/i;
/** Strip the `http(s)://` scheme from a node URL for display / naming. */
const URL_SCHEME = /^https?:\/\//;

/** Drop vendor noise so a GPU name fits the narrow node row. */
function shortGpu(name: string): string {
	return name.replace(GPU_VENDOR_NVIDIA, "").replace(GPU_VENDOR_AMD, "").trim();
}

/** Colour a usage bar by pressure: calm → amber → red. */
function barColor(pct: number): string {
	if (pct >= 90) {
		return "bg-destructive/70";
	}
	if (pct >= 75) {
		return "bg-warning/70";
	}
	return "bg-foreground/30";
}

/** `"41.3 GB"` + `"63.7 GB"` → `"41.3/63.7 GB"` (shared unit collapsed). */
function compactUsage(usedHuman: string, totalHuman: string): string {
	const u = usedHuman.split(" ");
	const t = totalHuman.split(" ");
	if (u.length === 2 && t.length === 2 && u[1] === t[1]) {
		return `${u[0]}/${t[0]} ${t[1]}`;
	}
	if (usedHuman && totalHuman) {
		return `${usedHuman} / ${totalHuman}`;
	}
	return totalHuman || usedHuman;
}

function UsageBar({
	label,
	used,
	total,
	usedHuman,
	totalHuman,
}: {
	label: string;
	used: number | null;
	total: number | null;
	usedHuman: string;
	totalHuman: string;
}) {
	const pct =
		total && total > 0 && used !== null
			? Math.min(100, Math.round((used / total) * 100))
			: null;
	return (
		<div className="space-y-0.5">
			<div className="flex items-center justify-between gap-2 text-[10px] text-muted-foreground/70">
				<span>{label}</span>
				<span className="tabular-nums">
					{compactUsage(usedHuman, totalHuman) || "—"}
				</span>
			</div>
			{pct !== null && (
				<div className="h-1 overflow-hidden rounded-full bg-muted-foreground/15">
					<div
						className={cn("h-full rounded-full", barColor(pct))}
						style={{ width: `${pct}%` }}
					/>
				</div>
			)}
		</div>
	);
}

/** Full per-node hardware block (specs line + RAM/disk usage bars) for the sidebar. */
function NodeStats({ info }: { info: SystemInfo }) {
	const specs: string[] = [];
	if (info.cpuCores) {
		specs.push(`${info.cpuCores} cores`);
	}
	if (info.gpuName) {
		specs.push(shortGpu(info.gpuName));
	} else if (info.vramHuman) {
		specs.push(`${info.vramHuman} VRAM`);
	}

	return (
		<div className="mt-1 space-y-1 pl-4">
			{specs.length > 0 &&
				(info.cpuName ? (
					<Tooltip>
						<TooltipTrigger
							render={
								<p className="truncate text-[10px] text-muted-foreground/70">
									{specs.join(" · ")}
								</p>
							}
						/>
						<TooltipContent>{info.cpuName}</TooltipContent>
					</Tooltip>
				) : (
					<p className="truncate text-[10px] text-muted-foreground/70">
						{specs.join(" · ")}
					</p>
				))}
			<UsageBar
				label="RAM"
				total={info.totalRamBytes}
				totalHuman={info.ramHuman}
				used={info.usedRamBytes}
				usedHuman={info.usedRamHuman}
			/>
			<UsageBar
				label="Disk"
				total={info.totalDiskBytes}
				totalHuman={info.diskHuman}
				used={info.usedDiskBytes}
				usedHuman={info.usedDiskHuman}
			/>
		</div>
	);
}

/** Em-dash fallback for an absent count. */
function specCount(v: number | null): string {
	return v === null ? "—" : String(v);
}

/** A `value`-on-the-right detail row, styled like the Settings groups. */
function HardwareRow({ label, value }: { label: string; value: ReactNode }) {
	return (
		<SettingsItem
			actions={
				<span className="text-right font-mono text-muted-foreground text-xs">
					{value}
				</span>
			}
			title={<span className="font-normal text-sm">{label}</span>}
		/>
	);
}

/** A usage row: human "used/total" plus a percentage bar. */
function pctOf(used: number | null, total: number | null): number | null {
	if (!(total && total > 0) || used === null) {
		return null;
	}
	return Math.min(100, Math.round((used / total) * 100));
}

/** The detail body, rendered only once a snapshot has loaded. */
function NodeHardwareBody({ info }: { info: SystemInfo }) {
	const ramPct = pctOf(info.usedRamBytes, info.totalRamBytes);
	const diskPct = pctOf(info.usedDiskBytes, info.totalDiskBytes);

	return (
		<div className="space-y-5">
			<SettingsSection title="Overview">
				<SettingsGroup>
					{info.hostname ? (
						<HardwareRow label="Hostname" value={info.hostname} />
					) : null}
					<HardwareRow label="OS" value={info.os || "—"} />
					{info.managed ? (
						<HardwareRow
							label="Managed"
							value={info.orgName ? `Ryu Cloud · ${info.orgName}` : "Ryu Cloud"}
						/>
					) : null}
				</SettingsGroup>
			</SettingsSection>

			<SettingsSection title="CPU">
				<SettingsGroup>
					<HardwareRow label="Model" value={info.cpuName ?? "—"} />
					<HardwareRow label="Logical cores" value={specCount(info.cpuCores)} />
					{info.physicalCores !== null && (
						<HardwareRow
							label="Physical cores"
							value={specCount(info.physicalCores)}
						/>
					)}
				</SettingsGroup>
			</SettingsSection>

			<SettingsSection title="Memory">
				<SettingsGroup>
					<HardwareRow
						label="RAM"
						value={compactUsage(info.usedRamHuman, info.ramHuman) || "—"}
					/>
					{ramPct !== null && (
						<HardwareRow
							label="Usage"
							value={
								<div className="flex items-center gap-2">
									<Progress className="h-1.5 w-20" value={ramPct} />
									<span>{ramPct}%</span>
								</div>
							}
						/>
					)}
					{info.unifiedMemory ? (
						<HardwareRow label="Type" value="Unified" />
					) : null}
				</SettingsGroup>
			</SettingsSection>

			<SettingsSection title="Disk">
				<SettingsGroup>
					<HardwareRow
						label="Storage"
						value={compactUsage(info.usedDiskHuman, info.diskHuman) || "—"}
					/>
					{diskPct !== null && (
						<HardwareRow
							label="Usage"
							value={
								<div className="flex items-center gap-2">
									<Progress className="h-1.5 w-20" value={diskPct} />
									<span>{diskPct}%</span>
								</div>
							}
						/>
					)}
				</SettingsGroup>
			</SettingsSection>

			{info.gpuName || info.vramHuman ? (
				<SettingsSection title="GPU">
					<SettingsGroup>
						{info.gpuName ? (
							<HardwareRow label="Model" value={info.gpuName} />
						) : null}
						{info.vramHuman ? (
							<HardwareRow label="VRAM" value={info.vramHuman} />
						) : null}
					</SettingsGroup>
				</SettingsSection>
			) : null}
		</div>
	);
}

/**
 * System build dependencies (git / rust / node / python) for one node, with a
 * one-click install of any that are missing. This lived on the removed Services
 * page; it now rides in the per-node Hardware dialog because it is a property of
 * the node's machine, right beside the CPU/RAM/GPU specs. Renders nothing when
 * the node reports no dependency info (older Core or unreachable).
 */
function NodeDependenciesSection({ target }: { target: ApiTarget }) {
	const [installing, setInstalling] = useState(false);
	const { data: deps, refetch } = useQuery({
		queryKey: ["node-deps", target.url],
		queryFn: () => fetchDependencies(target.url, target.token),
		retry: false,
	});

	if (!deps || deps.length === 0) {
		return null;
	}
	const missing = deps.filter((d) => !d.installed);

	const installMissing = async () => {
		setInstalling(true);
		try {
			await installMissingDeps(target.url, target.token);
			await refetch();
		} catch (e) {
			sileo.error({
				title: e instanceof Error ? e.message : "Dependency install failed",
			});
		} finally {
			setInstalling(false);
		}
	};

	return (
		<SettingsSection title="Dependencies">
			<SettingsGroup>
				{deps.map((dep) => (
					<HardwareRow
						key={dep.name}
						label={dep.name}
						value={
							<span className={dep.installed ? "text-success" : "text-warning"}>
								{dep.installed ? "Installed" : "Missing"}
							</span>
						}
					/>
				))}
			</SettingsGroup>
			{missing.length > 0 && (
				<Button
					className="mt-2"
					disabled={installing}
					onClick={() => {
						installMissing().catch(() => undefined);
					}}
					size="sm"
					variant="outline"
				>
					{installing ? "Installing…" : `Install ${missing.length} missing`}
				</Button>
			)}
		</SettingsSection>
	);
}

/**
 * Full hardware detail for one node, fetched live from that node's Core
 * (`GET /api/system/info` via {@link useNodeSystemInfo}). This replaces the old
 * global Settings → Hardware tab, which only ever showed the local machine —
 * not useful once chat is node-based. Here the specs describe whichever node
 * you opened it from.
 */
function NodeHardwareDialog({
	node,
	open,
	onClose,
}: {
	node: Node | null;
	open: boolean;
	onClose: () => void;
}) {
	const target: ApiTarget = {
		url: node?.url ?? "",
		token: node?.token ?? null,
	};
	const { data: info, isLoading } = useNodeSystemInfo(
		target,
		open && node !== null
	);

	let body: ReactNode;
	if (info) {
		body = <NodeHardwareBody info={info} />;
	} else if (isLoading) {
		body = (
			<div className="flex h-32 items-center justify-center text-muted-foreground text-sm">
				Loading hardware…
			</div>
		);
	} else {
		body = (
			<div className="flex h-32 items-center justify-center text-muted-foreground text-sm">
				Node unreachable — couldn't load hardware.
			</div>
		);
	}

	return (
		<Dialog onOpenChange={(v) => !v && onClose()} open={open}>
			<DialogContent className="flex max-h-[85vh] max-w-md flex-col">
				<DialogHeader>
					<DialogTitle>
						Hardware{node ? ` · ${displayName(node.name)}` : ""}
					</DialogTitle>
				</DialogHeader>
				<div className="-mr-2 min-h-0 flex-1 space-y-5 overflow-y-auto pr-2">
					{body}
					{node !== null && <NodeDependenciesSection target={target} />}
				</div>
			</DialogContent>
		</Dialog>
	);
}

export function AddNodeDialog({
	open,
	onClose,
}: {
	open: boolean;
	onClose: () => void;
}) {
	const addNode = useNodeStore((s) => s.addNode);
	const nodes = useNodeStore((s) => s.nodes);
	const [name, setName] = useState("");
	const [url, setUrl] = useState("");
	const [token, setToken] = useState("");
	const [error, setError] = useState<string | null>(null);
	// LAN discovery, folded in from the node dropdown: sweep the local /24 for
	// reachable Core nodes and add one in a click — right where you'd otherwise
	// type its address by hand.
	const [scanning, setScanning] = useState(false);
	const [discovered, setDiscovered] = useState<DiscoveredNode[] | null>(null);

	const handleAdd = async () => {
		setError(null);
		try {
			await addNode(name.trim(), url.trim(), token.trim() || undefined);
			setName("");
			setUrl("");
			setToken("");
			onClose();
		} catch (e) {
			setError(String(e));
		}
	};

	const handleScanLan = async () => {
		setScanning(true);
		setDiscovered(null);
		try {
			const found = await invoke<DiscoveredNode[]>("discover_lan_nodes");
			// Drop URLs already configured so the picker only shows new candidates.
			const knownUrls = new Set(nodes.map((n) => n.url.replace(/\/$/, "")));
			setDiscovered(
				found.filter((d) => !knownUrls.has(d.url.replace(/\/$/, "")))
			);
		} catch {
			setDiscovered([]);
		} finally {
			setScanning(false);
		}
	};

	const handleAddDiscovered = async (node: DiscoveredNode) => {
		// Derive a stable, valid node name from the host octet of the URL.
		const host = node.url.replace(URL_SCHEME, "").split(":")[0] ?? "node";
		const discoveredName = `node-${host.replace(/\./g, "-")}`;
		try {
			await addNode(discoveredName, node.url);
		} catch {
			// Already added or a name clash — drop it from the picker either way.
		}
		setDiscovered((prev) => prev?.filter((d) => d.url !== node.url) ?? null);
	};

	return (
		<Dialog onOpenChange={(v) => !v && onClose()} open={open}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Add Node</DialogTitle>
				</DialogHeader>
				<div className="space-y-3">
					<Input
						aria-label="Name"
						id="node-name"
						onChange={(e) => setName(e.target.value)}
						placeholder="Name"
						size="lg"
						value={name}
					/>
					<Input
						aria-label="URL"
						id="node-url"
						onChange={(e) => setUrl(e.target.value)}
						placeholder="URL"
						size="lg"
						value={url}
					/>
					<Input
						aria-label="Token"
						id="node-token"
						onChange={(e) => setToken(e.target.value)}
						placeholder="Token (optional — leave blank for local network)"
						size="lg"
						value={token}
					/>
					{error && <p className="text-destructive text-xs">{error}</p>}
					<div className="space-y-1.5 border-border/50 border-t pt-3">
						<button
							className="flex w-full items-center gap-1.5 text-muted-foreground/70 text-xs hover:text-foreground disabled:opacity-50"
							disabled={scanning}
							onClick={() => {
								handleScanLan();
							}}
							type="button"
						>
							<HugeiconsIcon icon={Add01Icon} size={12} />
							{scanning ? "Scanning local network…" : "Scan local network"}
						</button>
						{discovered !== null && discovered.length === 0 && !scanning && (
							<p className="text-[11px] text-muted-foreground/60">
								No new Core nodes found
							</p>
						)}
						{discovered?.map((d) => (
							<button
								className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-xs hover:bg-accent"
								key={d.url}
								onClick={() => {
									handleAddDiscovered(d);
								}}
								type="button"
							>
								<span
									aria-hidden
									className="size-2 shrink-0 rounded-full bg-success"
								/>
								<span className="flex-1 truncate text-left">
									{d.url.replace(URL_SCHEME, "")}
								</span>
								<span className="shrink-0 text-[10px] text-muted-foreground/60 tabular-nums">
									{d.latency_ms}ms
								</span>
							</button>
						))}
					</div>
				</div>
				<DialogFooter>
					<Button onClick={onClose} variant="ghost">
						Cancel
					</Button>
					<Button disabled={!(name.trim() && url.trim())} onClick={handleAdd}>
						Add Node
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

const LOOPBACK_HOST =
	/\/\/(127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\])(:|\/|$)/i;
const URL_PORT = /:(\d+)(?:\/|$)/;

/** Swap a loopback host for a reachable one (mesh MagicDNS) when we have it. */
function shareableUrl(nodeUrl: string, magicDnsName: string | null): string {
	if (LOOPBACK_HOST.test(nodeUrl) && magicDnsName) {
		const port = nodeUrl.match(URL_PORT)?.[1] ?? "7980";
		return `http://${magicDnsName}:${port}`;
	}
	return nodeUrl;
}

/**
 * Shows a `ryu://nodes/connect` deep link for one node — copy it (desktop/mobile
 * open it directly; the Chrome extension takes a paste) or scan the QR on a
 * phone. The address is editable because the saved URL is often loopback, which
 * no other device can reach; we pre-fill the mesh name when there is one and
 * otherwise prompt the user for this machine's LAN IP / Tailscale name.
 */
function ShareNodeDialog({
	node,
	magicDnsName,
	open,
	onClose,
}: {
	node: Node | null;
	magicDnsName: string | null;
	open: boolean;
	onClose: () => void;
}) {
	const [host, setHost] = useState("");
	const [revealToken, setRevealToken] = useState(false);

	// Re-seed the editable address whenever a different node is shared.
	useEffect(() => {
		if (node) {
			setHost(shareableUrl(node.url, magicDnsName));
			setRevealToken(false);
		}
	}, [node, magicDnsName]);

	if (!node) {
		return null;
	}

	const trimmedHost = host.trim();
	const isLoopback = LOOPBACK_HOST.test(trimmedHost);
	const link = trimmedHost
		? buildRyuDeepLink({
				kind: "node",
				name: node.name,
				url: trimmedHost,
				token: node.token,
			})
		: "";

	const copy = async () => {
		try {
			await navigator.clipboard.writeText(link);
			sileo.success({ title: "Connect link copied" });
		} catch {
			sileo.error({ title: "Could not copy to clipboard" });
		}
	};

	return (
		<Dialog onOpenChange={(v) => !v && onClose()} open={open}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>
						Connect a device to {displayName(node.name)}
					</DialogTitle>
				</DialogHeader>
				<div className="space-y-3">
					<div className="space-y-1">
						<p className="text-[11px] text-muted-foreground">
							Address other devices use to reach this node
						</p>
						<Input
							aria-label="Shareable address"
							onChange={(e) => setHost(e.target.value)}
							placeholder="http://192.168.1.50:7980"
							size="lg"
							value={host}
						/>
						{isLoopback && (
							<p className="text-[11px] text-warning">
								Other devices can't reach a localhost address. Enter this
								machine's LAN IP (e.g. 192.168.1.50) or Tailscale name.
							</p>
						)}
					</div>

					{node.token && (
						<div className="space-y-1">
							<div className="flex items-center justify-between">
								<p className="text-[11px] text-muted-foreground">
									Token (included in the link)
								</p>
								<button
									className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
									onClick={() => setRevealToken((v) => !v)}
									type="button"
								>
									<HugeiconsIcon
										icon={revealToken ? ViewOffSlashIcon : ViewIcon}
										size={12}
									/>
									{revealToken ? "Hide" : "Show"}
								</button>
							</div>
							<p className="truncate rounded-md bg-muted/40 px-2 py-1 font-mono text-[11px] text-muted-foreground">
								{revealToken ? node.token : "•".repeat(16)}
							</p>
						</div>
					)}

					{link && (
						<>
							<div className="flex items-center gap-2">
								<Input
									aria-label="Connect link"
									className="font-mono text-[11px]"
									readOnly
									size="lg"
									value={link}
								/>
								<Button onClick={copy} size="sm" variant="secondary">
									<HugeiconsIcon icon={Copy01Icon} size={14} />
									Copy
								</Button>
							</div>
							<div className="flex flex-col items-center gap-2 pt-1">
								<div className="rounded-lg bg-white p-3">
									<QRCode size={160} value={link} />
								</div>
								<p className="text-[11px] text-muted-foreground">
									Scan with the Ryu mobile app
								</p>
							</div>
						</>
					)}
				</div>
				<DialogFooter>
					<Button onClick={onClose} variant="ghost">
						Done
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

function NodeItem({
	node,
	isActive,
	onSelect,
	onRemove,
	onShare,
	onHardware,
}: {
	node: Node;
	isActive: boolean;
	onSelect: () => void;
	onRemove?: () => void;
	onShare?: () => void;
	onHardware?: () => void;
}) {
	const [online, setOnline] = useState<boolean | null>(null);

	useEffect(() => {
		const check = async () => {
			try {
				const result = await invoke<{ online: boolean }>("test_node", {
					name: node.name,
				});
				setOnline(result.online);
			} catch {
				setOnline(false);
			}
		};
		check();
		const id = setInterval(check, 15_000);
		return () => clearInterval(id);
	}, [node.name]);

	// Live hardware snapshot for this node — only fetched once the node is
	// reachable, so an offline node never blocks on an unreachable fetch.
	const { data: info } = useNodeSystemInfo(
		{ url: node.url, token: node.token },
		online === true
	);

	return (
		<div
			className={cn(
				"group cursor-pointer rounded-xl text-sm",
				isActive
					? "bg-accent text-accent-foreground"
					: "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
			)}
			onClick={onSelect}
		>
			<div className="flex items-center gap-2 px-2 py-1.5">
				<StatusDot online={online} />
				<span className="flex-1 truncate">{displayName(node.name)}</span>
				{(node.managed || info?.managed) && (
					<Tooltip>
						<TooltipTrigger
							render={
								<span className="shrink-0 rounded-full bg-accent px-1.5 py-0.5 font-medium text-[9px] text-accent-foreground uppercase tracking-wide">
									Cloud
								</span>
							}
						/>
						<TooltipContent>
							{info?.orgName
								? `Managed node · ${info.orgName}`
								: "Managed (Ryu Cloud) node"}
						</TooltipContent>
					</Tooltip>
				)}
				{/* Mark org nodes that carry a GPU, so a user picking where to run
				    GPU work can scan for it at the name level (NodeStats also prints
				    the GPU model lower in the row). GPU-ness is read from the node's
				    own `/api/system/info` gpuName — the Node model has no GPU field —
				    so an offline node (no snapshot) shows no badge. */}
				{info?.gpuName && (
					<Tooltip>
						<TooltipTrigger
							render={
								<span className="shrink-0 rounded-full bg-accent px-1.5 py-0.5 font-medium text-[9px] text-accent-foreground uppercase tracking-wide">
									GPU
								</span>
							}
						/>
						<TooltipContent>{info.gpuName}</TooltipContent>
					</Tooltip>
				)}
				{onHardware && (
					<button
						aria-label={`Hardware for ${node.name}`}
						className="shrink-0 opacity-0 hover:text-foreground group-hover:opacity-100"
						onClick={(e) => {
							e.stopPropagation();
							onHardware();
						}}
						type="button"
					>
						<HugeiconsIcon icon={CpuIcon} size={12} />
					</button>
				)}
				{onShare && (
					<button
						aria-label={`Share ${node.name}`}
						className="shrink-0 opacity-0 hover:text-foreground group-hover:opacity-100"
						onClick={(e) => {
							e.stopPropagation();
							onShare();
						}}
						type="button"
					>
						<HugeiconsIcon icon={Share08Icon} size={12} />
					</button>
				)}
				{node.name !== "local" && onRemove && (
					<button
						aria-label={`Remove ${node.name}`}
						className="shrink-0 opacity-0 hover:text-destructive group-hover:opacity-100"
						onClick={(e) => {
							e.stopPropagation();
							onRemove();
						}}
						type="button"
					>
						<HugeiconsIcon icon={Delete01Icon} size={12} />
					</button>
				)}
			</div>
			{info && (
				<div className="px-2 pb-2">
					<NodeStats info={info} />
				</div>
			)}
		</div>
	);
}

/** Compact "1.2 GB" / "340 MB" formatter for per-engine resident memory. */
function formatBytes(bytes: number): string {
	if (bytes <= 0) {
		return "0 B";
	}
	const units = ["B", "KB", "MB", "GB", "TB"];
	const i = Math.min(
		Math.floor(Math.log(bytes) / Math.log(1024)),
		units.length - 1
	);
	const val = bytes / 1024 ** i;
	const rounded = val >= 100 || i === 0 ? Math.round(val) : val.toFixed(1);
	return `${rounded} ${units[i]}`;
}

/** A short "1.2 GB · 12%" usage caption, or null when no sample is available. */
function usageCaption(detail: SidecarDetail | undefined): string | null {
	if (!detail || detail.memoryBytes == null) {
		return null;
	}
	const mem = formatBytes(detail.memoryBytes);
	if (detail.cpuPercent == null) {
		return mem;
	}
	return `${mem} · ${Math.round(detail.cpuPercent)}%`;
}

function ServiceRow({
	label,
	running,
	target,
	sidecarKey,
	onChanged,
	detail,
	readOnly = false,
	version,
	updateAvailable = false,
	onUpdate,
	onLaunch,
}: {
	label: string;
	running: boolean | null;
	target: { url: string; token: string | null };
	sidecarKey: string;
	onChanged: () => Promise<void>;
	/** Optional resource sample; when running, renders a "1.2 GB · 12%" caption. */
	detail?: SidecarDetail;
	/** Hide the start/stop toggle, showing status + usage only. Used for chat
	 *  engines, which are swap-managed (mutually exclusive) rather than
	 *  independently start/stoppable — toggling one here would desync the active
	 *  engine + gateway. */
	readOnly?: boolean;
	/** Installed version to surface as a `v1.2.3` badge. Hidden when absent. */
	version?: string | null;
	/** Whether a newer version is available — gates the inline "Update" action. */
	updateAvailable?: boolean;
	/** Run the update for this component. When set + `updateAvailable`, renders an
	 *  "Update" button that awaits this before reconciling. */
	onUpdate?: () => Promise<void>;
	/** Install-then-launch action for a component the shell can start but Core can't
	 *  (Island: a device-local Electron companion, not a Core sidecar). When set +
	 *  `running === false`, renders an "Install / Launch" button that awaits this
	 *  then re-probes. Independent of the start/stop toggle, so it coexists with
	 *  `readOnly`. */
	onLaunch?: () => Promise<void>;
}) {
	const [pending, setPending] = useState<"start" | "stop" | null>(null);
	const [updating, setUpdating] = useState(false);
	const [launching, setLaunching] = useState(false);

	const handleUpdate = async (e: React.MouseEvent) => {
		e.stopPropagation();
		if (!onUpdate) {
			return;
		}
		setUpdating(true);
		try {
			await onUpdate();
			await onChanged();
		} catch {
			// Status reconciles on the next poll tick; nothing to surface inline here.
		} finally {
			setUpdating(false);
		}
	};

	const handleLaunch = async (e: React.MouseEvent) => {
		e.stopPropagation();
		if (!onLaunch) {
			return;
		}
		setLaunching(true);
		try {
			await onLaunch();
			// Electron cold start + binding :7989 takes a few seconds, so give it a
			// beat before re-probing; the 5s status poll flips the dot regardless.
			await new Promise<void>((resolve) => setTimeout(resolve, 1000));
			await onChanged();
		} catch {
			// Status reconciles on the next poll tick; nothing to surface inline here.
		} finally {
			setLaunching(false);
		}
	};

	const handleToggle = async (e: React.MouseEvent) => {
		e.stopPropagation();
		const action = running ? "stop" : "start";
		setPending(action);
		try {
			if (running) {
				await stopSidecar(target, sidecarKey);
			} else {
				await startSidecar(target, sidecarKey);
			}
			// Give the process a moment to settle before re-polling status.
			await new Promise<void>((resolve) => setTimeout(resolve, 1000));
			await onChanged();
		} catch {
			// Status reconciles on the next poll tick; nothing to surface inline here.
		} finally {
			setPending(null);
		}
	};

	const dotColor =
		running === null
			? "bg-muted-foreground/30"
			: running
				? "bg-success"
				: "bg-destructive";

	const label2 =
		pending === "stop"
			? "Stopping…"
			: pending === "start"
				? "Starting…"
				: running
					? "Stop"
					: "Start";

	const usage = running ? usageCaption(detail) : null;
	const showUpdate = updateAvailable && onUpdate != null;

	return (
		<div className="flex items-center gap-2 px-2 py-1 text-xs">
			<span
				aria-hidden
				className={cn("size-1.5 shrink-0 rounded-full", dotColor)}
			/>
			<AutoScrollText className="flex-1 text-muted-foreground" title={label}>
				{label}
			</AutoScrollText>
			{version && (
				<span className="shrink-0 text-[10px] text-muted-foreground/50 tabular-nums">
					v{version}
				</span>
			)}
			{usage && (
				<span className="shrink-0 text-[10px] text-muted-foreground/60 tabular-nums">
					{usage}
				</span>
			)}
			{showUpdate && (
				<button
					className="shrink-0 rounded-md px-1.5 py-0.5 text-[10px] text-warning hover:bg-warning/10 disabled:opacity-50 dark:text-warning"
					disabled={updating}
					onClick={handleUpdate}
					type="button"
				>
					{updating ? "Updating…" : "Update"}
				</button>
			)}
			{onLaunch && running === false && (
				<button
					className="shrink-0 rounded-md px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
					disabled={launching}
					onClick={handleLaunch}
					type="button"
				>
					{launching ? "Launching…" : "Install / Launch"}
				</button>
			)}
			{running !== null && !readOnly && (
				<button
					className={cn(
						"shrink-0 rounded-md px-1.5 py-0.5 text-[10px] hover:bg-accent disabled:opacity-50",
						running
							? "text-muted-foreground hover:text-destructive"
							: "text-muted-foreground hover:text-foreground"
					)}
					disabled={pending !== null}
					onClick={handleToggle}
					type="button"
				>
					{label2}
				</button>
			)}
		</div>
	);
}

/** Modality groups for the engines list, in display order. Categories map to
 *  the catalog's SidecarCategory: provider=chat, voice=speech, media=image,
 *  embedding=embeddings. Agents/tools are not engines and are excluded. */
const ENGINE_GROUPS: Array<{
	categories: CatalogItem["category"][];
	label: string;
	/** Chat engines are swap-managed (mutually exclusive), so this panel shows
	 *  their status + usage but no start/stop toggle — switching the resident
	 *  chat engine is a Store action (`setActiveEngine`), not a sidecar stop. The
	 *  run-alongside engines (speech/image/embeddings) toggle freely. */
	readOnly: boolean;
}> = [
	{ label: "Chat", categories: ["provider"], readOnly: true },
	{ label: "Speech", categories: ["voice"], readOnly: false },
	{ label: "Image", categories: ["media"], readOnly: false },
	{ label: "Embeddings", categories: ["embedding"], readOnly: false },
];

/**
 * The "Engines" block in the node dropdown: every installed engine runtime
 * (chat / speech / image / embeddings) with its running state, live memory/CPU
 * usage, and a start/stop toggle. Joins the catalog (what's installed + its
 * modality) with `/api/sidecar/status` (running + resource sample), polling on
 * the same 5s cadence as the rest of the status spine. Renders nothing until at
 * least one engine is installed.
 */
/**
 * Compact live "N/M slots · K queued" badge for the local-engine admission
 * queue. Renders nothing when the engine is idle (no slots busy, nothing
 * queued) so the panel stays quiet until the engine is actually under load
 * (Ryu's fan-out: delegate / threads / teams). Prefers the gateway's
 * admission view; falls back to the engine's own `/slots` count.
 */
function EngineQueueBadge({
	concurrency,
}: {
	concurrency: EngineConcurrency | null;
}) {
	if (!concurrency) {
		return null;
	}
	const busy = concurrency.engineBusy ?? concurrency.inFlight;
	const total = concurrency.engineTotal ?? concurrency.maxInFlight;
	const { queued } = concurrency;
	if (busy <= 0 && queued <= 0) {
		return null;
	}
	const slots = total > 0 ? `${busy}/${total} slots` : `${busy} busy`;
	return (
		<span className="font-medium text-[10px] text-muted-foreground/60 tabular-nums">
			{slots}
			{queued > 0 ? ` · ${queued} queued` : ""}
		</span>
	);
}

function EnginesSection({ target }: { target: ApiTarget }) {
	const query = useQuery({
		queryKey: ["node-engines", target.url],
		queryFn: async () => {
			const [catalog, details, active, concurrency] = await Promise.all([
				fetchCatalog(target.url, target.token),
				fetchSidecarDetails(target).catch(
					() => ({}) as Record<string, SidecarDetail>
				),
				// The resident chat engine (mutually-exclusive slot). Best-effort:
				// on failure we fall back to the running provider below.
				fetchActiveEngine(target).catch(() => null),
				// Live admission-queue + slot depth (Layer 2). Best-effort.
				fetchEngineConcurrency(target).catch(() => null),
			]);
			return {
				catalog,
				details,
				active: active?.active ?? null,
				concurrency,
			};
		},
		refetchInterval: 5000,
	});

	const catalog = query.data?.catalog ?? [];
	const details = query.data?.details ?? {};
	const activeChat = query.data?.active ?? null;
	const concurrency = query.data?.concurrency ?? null;
	// Only installed engines are actionable here — not-installed runtimes live in
	// the Store, not this status panel.
	const installed = catalog.filter((item) => item.installState === "installed");
	const groups = ENGINE_GROUPS.map((group) => {
		const isChat = group.categories.includes("provider");
		let engines = installed.filter((item) =>
			group.categories.includes(item.category)
		);
		// Chat is a single mutually-exclusive slot, so show ONLY the engine the
		// user actually picked — never the installed-but-idle alternatives
		// (Ollama / vLLM / SGLang / MLX). Prefer the reported active engine; fall
		// back to whichever provider is currently running if that's unavailable.
		if (isChat) {
			engines = engines.filter((item) =>
				activeChat
					? item.name === activeChat
					: (details[item.name]?.running ?? false)
			);
		}
		return { label: group.label, readOnly: group.readOnly, isChat, engines };
	}).filter((g) => g.engines.length > 0);

	if (groups.length === 0) {
		return null;
	}

	const refresh = async () => {
		await query.refetch();
	};

	return (
		<div className="px-1 py-0.5">
			<div className="flex items-center justify-between px-2 pt-0.5 pb-1">
				<p className="font-medium text-[10px] text-muted-foreground/50 uppercase tracking-wider">
					Engines
				</p>
				<EngineQueueBadge concurrency={concurrency} />
			</div>
			{groups.map((group) => (
				<div key={group.label}>
					{/* The chat engine sits directly under the "Engines" header and is
					    the single active slot, so its "Chat" sub-label is redundant —
					    only the run-alongside groups (Speech/Image/Embeddings) get one. */}
					{!group.isChat && (
						<p className="px-2 pt-1 pb-0.5 text-[9px] text-muted-foreground/40 uppercase tracking-wider">
							{group.label}
						</p>
					)}
					{group.engines.map((engine) => (
						// Show the installed engine build (e.g. llama.cpp "b9670") as a
						// version badge. No per-engine "update" action: engine downloads
						// are pinned to a compile-time target, so the catalog's upstream
						// `latestVersion` is informational only — re-install can't move an
						// installed engine off its pin, and engines upgrade with the app.
						<ServiceRow
							detail={details[engine.name]}
							key={engine.name}
							label={engine.displayName}
							onChanged={refresh}
							readOnly={group.readOnly}
							running={details[engine.name]?.running ?? false}
							sidecarKey={engine.name}
							target={target}
							version={engine.installedVersion}
						/>
					))}
				</div>
			))}
		</div>
	);
}

/** `4 vCPU · 16 GiB · H100` from a sandbox spec; omits fields the node didn't
 *  report, falling back to the guest OS (or a bare "sandbox") if it reported
 *  nothing quantitative. */
function summarizeSandboxSpec(spec: SandboxSpec): string {
	const parts: string[] = [];
	if (spec.vcpu !== null) {
		parts.push(`${spec.vcpu} vCPU`);
	}
	if (spec.memGib !== null) {
		parts.push(`${spec.memGib} GiB`);
	}
	if (spec.gpu) {
		parts.push(spec.gpu);
	}
	return parts.join(" · ") || spec.os || "sandbox";
}

/** `mm:ss` elapsed from a whole-seconds duration (any hours fold into minutes). */
function formatElapsed(seconds: number): string {
	const s = Math.max(0, Math.floor(seconds));
	const mins = Math.floor(s / 60);
	const secs = s % 60;
	return `${mins}:${secs.toString().padStart(2, "0")}`;
}

/**
 * "Running Sandboxes" block in the node dropdown: the compute runs currently
 * executing on the active node (wasmtime / Docker / a managed-node GPU box),
 * each with its resource summary (`4 vCPU · 16 GiB · H100`) and a live mm:ss
 * age. Polls the node directly on a short cadence so the set + ages feel live.
 *
 * Sandbox membership is org-scoped upstream (a managed node is org-bound), so no
 * client-side filter is applied. The query THROWS on an unreachable node / older
 * Core without the surface, leaving `data` undefined → the whole section hides;
 * an empty array (surface present, nothing running) instead shows an explicit
 * "No sandboxes running", so an absent endpoint never masquerades as "idle".
 */
/** One running-sandbox row with an inline "Stop" button that destroys the
 *  persistent Daytona workspace. Mirrors ServiceRow's local-`pending` idiom:
 *  the button relabels to "Stopping…" while the DELETE is in flight, and the
 *  list is invalidated on success so the row drops immediately. */
function SandboxRow({
	target,
	run,
	onDestroyed,
}: {
	target: ApiTarget;
	run: SandboxRun;
	onDestroyed: () => void;
}) {
	const [stopping, setStopping] = useState(false);

	const handleStop = async () => {
		setStopping(true);
		try {
			await destroySandbox(target, run.runId);
			sileo.success({ title: "Sandbox stopped" });
			onDestroyed();
		} catch (e) {
			sileo.error({
				title: e instanceof Error ? e.message : "Failed to stop sandbox",
			});
		} finally {
			setStopping(false);
		}
	};

	return (
		<div className="flex items-center gap-2 px-2 py-1 text-xs">
			<span aria-hidden className="size-1.5 shrink-0 rounded-full bg-success" />
			<AutoScrollText
				className="flex-1 text-muted-foreground"
				title={run.runId}
			>
				{summarizeSandboxSpec(run.spec)}
			</AutoScrollText>
			{run.spec.gpu && (
				<span className="shrink-0 rounded-full bg-accent px-1.5 py-0.5 font-medium text-[9px] text-accent-foreground uppercase tracking-wide">
					GPU
				</span>
			)}
			<span className="shrink-0 text-[10px] text-muted-foreground/50 tabular-nums">
				{formatElapsed(run.elapsedSeconds)}
			</span>
			<button
				className="shrink-0 rounded-md px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-accent hover:text-destructive disabled:opacity-50"
				disabled={stopping}
				onClick={handleStop}
				type="button"
			>
				{stopping ? "Stopping…" : "Stop"}
			</button>
		</div>
	);
}

function SandboxesSection({
	target,
	enabled,
}: {
	target: ApiTarget;
	enabled: boolean;
}) {
	const queryClient = useQueryClient();
	const { data: sandboxes } = useNodeSandboxes(target, enabled);
	const [creating, setCreating] = useState(false);

	const invalidate = () => {
		Promise.resolve(
			queryClient.invalidateQueries({
				queryKey: ["node-sandboxes", target.url],
			})
		).catch(() => undefined);
	};

	if (!sandboxes) {
		return null;
	}

	const handleCreate = async () => {
		setCreating(true);
		try {
			await createSandbox(target);
			sileo.success({ title: "Sandbox created" });
			invalidate();
		} catch (e) {
			sileo.error({
				title: e instanceof Error ? e.message : "Failed to create sandbox",
			});
		} finally {
			setCreating(false);
		}
	};

	return (
		<>
			<DropdownMenuSeparator />
			<div className="px-1 py-0.5">
				<div className="flex items-center justify-between px-2 pt-0.5 pb-1">
					<p className="font-medium text-[10px] text-muted-foreground/50 uppercase tracking-wider">
						Running Sandboxes · {sandboxes.length}
					</p>
					<button
						className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
						disabled={creating}
						onClick={handleCreate}
						type="button"
					>
						<HugeiconsIcon className="size-3" icon={Add01Icon} />
						{creating ? "Creating…" : "New sandbox"}
					</button>
				</div>
				{sandboxes.length === 0 ? (
					<p className="px-2 pb-0.5 text-[10px] text-muted-foreground/50">
						No sandboxes running
					</p>
				) : (
					sandboxes.map((run) => (
						<SandboxRow
							key={run.runId}
							onDestroyed={invalidate}
							run={run}
							target={target}
						/>
					))
				)}
			</div>
		</>
	);
}

/** A reachable Core found by the LAN sweep (mirrors the Rust DiscoveredNode). */
interface DiscoveredNode {
	latency_ms: number;
	url: string;
}

/**
 * One reachable mesh peer, rendered as an "Add" row. When a candidate bearer is
 * available (`bearerAvailable`), the whole row is a button that registers the
 * peer WITH that token, so its protected routes don't 401. When no bearer exists
 * (`bearer_source: "none"`), the row is inert and shows an honest "needs token"
 * label — we never silently add a tokenless node that would 401.
 */
function MeshPeerRow({
	peer,
	onAddPeer,
}: {
	peer: MeshPeerEntry;
	onAddPeer: (peer: MeshPeerEntry) => void;
}) {
	const dot = (
		<span
			aria-hidden
			className={cn(
				"size-1.5 shrink-0 rounded-full",
				peer.online ? "bg-success" : "bg-muted-foreground/30"
			)}
		/>
	);
	const label = peer.name || peer.hostOrDns;

	if (!peer.bearerAvailable) {
		// Honest state: no usable node-admittance token, so adding this peer would
		// 401. Show it as non-addable with a clear reason instead.
		return (
			<div className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-xs opacity-70">
				{dot}
				<span className="flex-1 truncate text-left text-muted-foreground">
					{label}
				</span>
				<span className="shrink-0 text-[10px] text-warning">needs token</span>
			</div>
		);
	}

	return (
		<button
			className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-xs hover:bg-accent"
			onClick={() => onAddPeer(peer)}
			type="button"
		>
			{dot}
			<span className="flex-1 truncate text-left text-muted-foreground">
				{label}
			</span>
			<HugeiconsIcon
				className="shrink-0 text-muted-foreground/60"
				icon={Add01Icon}
				size={11}
			/>
		</button>
	);
}

/**
 * Mesh section in the node dropdown. Renders nothing when mesh is not relevant
 * (`status === null` — disabled/absent), so a vanilla install shows no mesh row.
 * When enabled it shows the reachability dot, this node's MagicDNS name, an
 * optional ingress caption, and a mesh-peer Add picker.
 *
 * The peer list comes from `GET /api/mesh/peers` ({@link MeshPeersResult}), which
 * carries a candidate node-admittance bearer per peer. Adding a peer attaches
 * that token so the added node no longer 401s. When no bearer is available
 * (`bearerSource: "none"`) every peer renders as an honest "needs token" state
 * and the endpoint's provisioning `note` is surfaced.
 */
function MeshSection({
	status,
	reachable,
	ingress,
	peers,
	onAddPeer,
}: {
	status: MeshStatus | null;
	reachable: boolean | null;
	ingress: WebhookIngressStatus | null;
	peers: MeshPeersResult | null;
	onAddPeer: (peer: MeshPeerEntry) => void;
}) {
	if (status === null) {
		return null;
	}
	const dotColor = reachable ? "bg-success" : "bg-warning";
	const peerList = peers?.peers ?? [];
	const noBearer =
		peers !== null &&
		peerList.length > 0 &&
		peers.bearerSource === BEARER_SOURCE_NONE;
	return (
		<>
			<DropdownMenuSeparator />
			<div className="px-1 py-0.5">
				<p className="px-2 pt-0.5 pb-1 font-medium text-[10px] text-muted-foreground/50 uppercase tracking-wider">
					Mesh
				</p>
				<div className="flex items-center gap-2 px-2 py-1 text-xs">
					<span
						aria-hidden
						className={cn("size-1.5 shrink-0 rounded-full", dotColor)}
					/>
					<span className="flex-1 truncate text-muted-foreground">
						{status.magicDnsName ?? (reachable ? "Connected" : "Connecting…")}
					</span>
					{status.backend && (
						<span className="shrink-0 text-[10px] text-muted-foreground/60">
							{status.backend}
						</span>
					)}
				</div>
				{ingress?.up && ingress.kind && (
					<p className="px-2 pb-0.5 text-[10px] text-muted-foreground/60">
						Ingress: {ingress.kind}
					</p>
				)}
				{peerList.length > 0 && (
					<div className="space-y-0.5 pt-0.5">
						{peerList.map((peer) => (
							<MeshPeerRow
								key={peer.name || peer.hostOrDns}
								onAddPeer={onAddPeer}
								peer={peer}
							/>
						))}
					</div>
				)}
				{noBearer && (
					<p className="px-2 pt-0.5 pb-0.5 text-[10px] text-muted-foreground/60">
						{peers?.note ??
							"Peer needs an enrollment token — provision the same RYU_TOKEN on both nodes, or add the peer's own token by hand."}
					</p>
				)}
			</div>
		</>
	);
}

/** "active 5s ago" / "now" from a unix-seconds last-seen stamp. */
function relativeAge(lastSeen: number): string {
	const secs = Math.max(0, Math.floor(Date.now() / 1000) - lastSeen);
	if (secs < 10) {
		return "now";
	}
	if (secs < 60) {
		return `${secs}s ago`;
	}
	return `${Math.floor(secs / 60)}m ago`;
}

/** Best display label for a connected client: name → email → device → anon. */
function clientDisplayName(c: ConnectedClient): string {
	return c.userName ?? c.userId ?? c.clientLabel ?? "Anonymous";
}

/**
 * "Connected" section in the node dropdown: the clients currently talking to
 * THIS node (desktop / CLI / mobile / extension), newest activity first. This is
 * presence/attribution behind the shared node token, NOT verified identity or
 * isolation (see apps/core/src/connections) — so it answers "who is here", never
 * "who can see what". Renders nothing when no client has declared a `client_id`
 * (e.g. only older clients connected), so it never shows an empty box.
 */
function ConnectedSection({
	clients,
	selfClientId,
}: {
	clients: ConnectedClient[];
	selfClientId: string;
}) {
	if (clients.length === 0) {
		return null;
	}
	return (
		<>
			<DropdownMenuSeparator />
			<div className="px-1 py-0.5">
				<p className="px-2 pt-0.5 pb-1 font-medium text-[10px] text-muted-foreground/50 uppercase tracking-wider">
					Connected · {clients.length}
				</p>
				{clients.map((c) => {
					const device = c.clientLabel ?? c.surface;
					return (
						<div
							className="flex items-center gap-2 px-2 py-1 text-xs"
							key={c.clientId}
						>
							<span
								aria-hidden
								className="size-1.5 shrink-0 rounded-full bg-success"
							/>
							<AutoScrollText
								className="flex-1 text-muted-foreground"
								title={`${clientDisplayName(c)}${c.clientId === selfClientId ? " (you)" : ""}`}
							>
								{clientDisplayName(c)}
								{c.clientId === selfClientId && (
									<span className="text-muted-foreground/50"> (you)</span>
								)}
							</AutoScrollText>
							{device && (
								<span className="shrink-0 text-[10px] text-muted-foreground/60">
									{device}
								</span>
							)}
							<span className="shrink-0 text-[10px] text-muted-foreground/50 tabular-nums">
								{relativeAge(c.lastSeen)}
							</span>
						</div>
					);
				})}
			</div>
		</>
	);
}

/**
 * Compact org-wallet nudge shown under the node list when the active node is a
 * managed (Ryu Cloud) one (epic #496, Unit C2). Managed inference is metered to
 * the org wallet (B4), so the user needs the balance visible where they pick the
 * node. Clicking opens the full Credits surface (`/credits`). Renders nothing
 * when the user is signed out / has no managed wallet, so a local-only install
 * shows no wallet row.
 */
function ManagedNodeWallet() {
	const openSettings = useSettingsDialog((s) => s.openSettings);
	const { authed, wallet, entitlement, walletEmpty, loading } =
		useCreditsWallet();

	// Only meaningful for a signed-in user whose plan includes managed inference.
	if (!(authed && entitlement?.managedInference)) {
		return null;
	}

	const currency = wallet?.currency ?? "usd";
	const balanceLabel =
		wallet && !loading ? formatMicroUsd(wallet.balanceMicroUsd, currency) : "—";

	return (
		<button
			className={cn(
				"mt-1 flex w-full items-center gap-2 rounded-xl px-2 py-1.5 text-left text-xs",
				walletEmpty
					? "bg-warning/10 text-warning hover:bg-warning/15 dark:text-warning"
					: "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
			)}
			onClick={() => openSettings("credits")}
			type="button"
		>
			<HugeiconsIcon
				className="shrink-0"
				icon={walletEmpty ? Alert02Icon : DollarCircleIcon}
				size={13}
			/>
			<span className="flex-1 truncate">
				{walletEmpty ? "Credits empty — top up" : "Cloud credits"}
			</span>
			<span className="shrink-0 font-medium tabular-nums">{balanceLabel}</span>
		</button>
	);
}

/** Strip the `cloud-` prefix the store adds so the label reads as the raw name. */
function cloudLabel(name: string): string {
	return displayName(name.replace(/^cloud-/, ""));
}

/**
 * "Add this" nudge for cloud instances tied to the active workspace that the
 * user can reach but hasn't added yet (A4 follow-up). The store detects them
 * from the control plane ({@link useNodeStore.suggestedCloudNodes}); here the
 * user adds one (persists it as a Cloud node) or dismisses it. Renders nothing
 * when there is nothing to suggest, so a local-only / fully-added setup is quiet.
 */
function CloudSuggestions({ compact = false }: { compact?: boolean }) {
	const suggestions = useNodeStore((s) => s.suggestedCloudNodes);
	const addSuggestedNode = useNodeStore((s) => s.addSuggestedNode);
	const dismissSuggestion = useNodeStore((s) => s.dismissSuggestion);
	const [addingUrl, setAddingUrl] = useState<string | null>(null);

	if (suggestions.length === 0) {
		return null;
	}

	const handleAdd = async (node: Node) => {
		setAddingUrl(node.url);
		try {
			await addSuggestedNode(node);
			sileo.success({ title: `Added ${cloudLabel(node.name)}` });
		} catch {
			sileo.error({ title: "Couldn't add cloud node" });
		} finally {
			setAddingUrl(null);
		}
	};

	return (
		<div className={cn("space-y-0.5", compact ? "px-1 py-0.5" : "mt-1")}>
			<p className="px-2 pt-0.5 pb-1 font-medium text-[10px] text-muted-foreground/50 uppercase tracking-wider">
				Available in your workspace
			</p>
			{suggestions.map((node) => {
				const busy = addingUrl === node.url;
				return (
					<div
						className="flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs hover:bg-accent/40"
						key={node.url}
					>
						<HugeiconsIcon
							className="shrink-0 text-muted-foreground"
							icon={CloudServerIcon}
							size={13}
						/>
						<span className="min-w-0 flex-1 truncate" title={node.url}>
							{cloudLabel(node.name)}
						</span>
						<button
							className="shrink-0 rounded-md px-1.5 py-0.5 font-medium text-[11px] text-primary hover:bg-primary/10 disabled:opacity-50"
							disabled={busy}
							onClick={() => handleAdd(node)}
							type="button"
						>
							{busy ? "Adding…" : "Add"}
						</button>
						<button
							aria-label={`Dismiss ${cloudLabel(node.name)}`}
							className="shrink-0 rounded-md p-0.5 text-muted-foreground/60 hover:bg-muted hover:text-foreground disabled:opacity-50"
							disabled={busy}
							onClick={() => dismissSuggestion(node.url)}
							title="Dismiss"
							type="button"
						>
							<HugeiconsIcon icon={Cancel01Icon} size={11} />
						</button>
					</div>
				);
			})}
		</div>
	);
}

/** The policy, in one line — used for both the OFF-state hint and the a11y label. */
const AUTO_SELECT_POLICY = "Prefer a reachable remote node, else run locally";

/**
 * Subline under the auto-select switch: what the setting is actually DOING right
 * now, never a promise the store does not keep. `picked` is the node the probe
 * landed on (already resolved from `autoSelectedNode`), or null before it has run.
 */
function autoSelectSubline(autoSelect: boolean, picked: Node | null): string {
	if (!autoSelect) {
		return "Always use your default node";
	}
	if (!picked) {
		return AUTO_SELECT_POLICY;
	}
	// Branch on the URL, not the name: a remote node someone named "local" must not
	// be reported as local compute.
	if (isLocalNode(picked)) {
		return "No remote reachable — running locally";
	}
	return `Using ${displayName(picked.name)}`;
}

/**
 * The auto-select switch (M10: "a client prefers a reachable REMOTE node, else
 * local compute"). The store models this as a PERSISTED flag; the probe only ever
 * considers REMOTE nodes (an explicitly-chosen default remote is ranked first) and
 * fails over to local compute when none answers, and `getActiveNode` prefers that
 * pick while the flag is on.
 *
 * A persistent toggle, deliberately NOT a port of the one-shot "Auto-select best
 * node" BUTTON on mobile (`apps/native/components/node-selector.tsx`): the desktop
 * store re-probes on an interval and on node changes, so the choice is a standing
 * preference, not a single decision. OFF (the default) keeps selection byte-
 * identical to the manual path — a picked tab override still always wins.
 */
function AutoSelectRow({ compact = false }: { compact?: boolean }) {
	const autoSelect = useNodeStore((s) => s.autoSelect);
	const setAutoSelect = useNodeStore((s) => s.setAutoSelect);
	const autoSelectedNode = useNodeStore((s) => s.autoSelectedNode);
	const nodes = useNodeStore((s) => s.nodes);

	// Resolve the pick defensively: the probe can name the local fallback even when
	// the user renamed their local node, so an unresolved name degrades to local.
	let picked: Node | null = null;
	if (autoSelectedNode) {
		picked = nodes.find((n) => n.name === autoSelectedNode) ?? LOCAL_FALLBACK;
	}

	return (
		<div className={cn(compact ? "px-1 py-0.5" : "mt-1")}>
			<div className="flex items-center gap-2 rounded-lg px-2 py-1.5">
				<div className="min-w-0 flex-1">
					<p className="truncate font-medium text-xs">Auto-select node</p>
					<p className="truncate text-[10px] text-muted-foreground">
						{autoSelectSubline(autoSelect, picked)}
					</p>
				</div>
				<Switch
					aria-label={AUTO_SELECT_POLICY}
					checked={autoSelect}
					className="shrink-0"
					onCheckedChange={setAutoSelect}
				/>
			</div>
		</div>
	);
}

export function NodeSelector({ mode }: NodeSelectorProps) {
	const { nodes, defaultNode, setDefault, removeNode, addNode } =
		useNodeStore();
	const [addOpen, setAddOpen] = useState(false);
	// The Gateway dialog is backed by a global store so other surfaces (command
	// palette, deep links, the Settings page) can open it at a chosen section.
	const gatewayOpen = useGatewayDialog((s) => s.open);
	const gatewaySection = useGatewayDialog((s) => s.section);
	const setGatewayOpen = useGatewayDialog((s) => s.setOpen);
	const openGateway = useGatewayDialog((s) => s.openGateway);
	const [shareNode, setShareNode] = useState<Node | null>(null);
	const [hardwareNode, setHardwareNode] = useState<Node | null>(null);
	const activeNode = nodes.find((n) => n.name === defaultNode) ?? nodes[0];

	const {
		coreReachable,
		gatewayReachable,
		shadowReachable,
		islandReachable,
		meshReachable,
		meshStatus,
		loading,
		refresh,
	} = useSystemStatusContext();

	const tone = resolveTone(
		loading,
		coreReachable,
		gatewayReachable,
		shadowReachable,
		meshReachable
	);
	const target: ApiTarget = {
		url: activeNode?.url ?? "http://127.0.0.1:7980",
		token: activeNode?.token ?? null,
	};

	// Island is a device-local Electron companion the shell installs + launches
	// (Core can't — it's not a Core sidecar). The Island row surfaces this only when
	// the local island isn't reachable; the status dot goes green on the next probe.
	const handleIslandLaunch = async () => {
		await installAndLaunchIsland();
	};

	// Live specs for the active node, surfaced in the compact dropdown header.
	const { data: activeInfo } = useNodeSystemInfo(
		target,
		coreReachable === true
	);

	// Gateway provider count for the badge (only when the gateway is reachable).
	const { data: gatewayStatus } = useQuery({
		queryKey: ["node-gateway-status", target.url],
		queryFn: ({ signal }) => fetchGatewayStatus(target, signal),
		enabled: coreReachable === true,
		refetchInterval: 30_000,
		retry: false,
	});
	const providerCount = gatewayStatus?.health?.providers.length ?? 0;

	// Installed version + update verdict for Core/Gateway (single release train):
	// drives the version badge on both rows and the shared app-wide "Update"
	// action. Core owns the verdict; install is the native tauri updater.
	const {
		version: appVersion,
		updateAvailable: appUpdateAvailable,
		update: handleAppUpdate,
	} = useNodeVersion(target, coreReachable === true);

	// Connected-client presence (the "who's on this node" view). Soft dependency:
	// an older Core without the surface 404s → caught → null → section hidden.
	const { data: connections } = useQuery({
		queryKey: ["node-connections", target.url],
		queryFn: async ({ signal }) => {
			try {
				return await fetchConnections(target, signal);
			} catch {
				return null;
			}
		},
		enabled: coreReachable === true,
		refetchInterval: 15_000,
		retry: false,
	});

	// Webhook-ingress status (soft dependency: always 200, `up:false` → no
	// ingress line; an older Core without the plane 404s → caught → null).
	const { data: ingress } = useQuery({
		queryKey: ["node-webhook-ingress", target.url],
		queryFn: async ({ signal }) => {
			try {
				return await fetchWebhookIngressStatus(target, signal);
			} catch {
				return null;
			}
		},
		enabled: coreReachable === true,
		refetchInterval: 30_000,
		retry: false,
	});

	// Reachable mesh peers + a candidate node-admittance bearer per peer
	// (`GET /api/mesh/peers`). Gated on a reachable Core with mesh actually on
	// (`meshStatus !== null`) so a vanilla, mesh-off install never fires it. Soft
	// dependency: an older Core without the surface 404s → caught → null → the
	// mesh section shows no addable peers rather than adding a tokenless 401.
	const { data: meshPeers } = useQuery({
		queryKey: ["node-mesh-peers", target.url],
		queryFn: async ({ signal }) => {
			try {
				return await fetchMeshPeers(target, signal);
			} catch {
				return null;
			}
		},
		enabled: coreReachable === true && meshStatus !== null,
		refetchInterval: 15_000,
		retry: false,
	});

	const handleAddPeer = async (peer: MeshPeerEntry) => {
		const name = `mesh-${(peer.name || peer.hostOrDns).replace(/[^a-zA-Z0-9-]/g, "-")}`;
		try {
			// Attach the candidate bearer so the added peer's protected routes don't
			// 401. The endpoint only surfaces an addable peer when a bearer exists
			// (the "none" case renders as a non-addable "needs token" row), so
			// `peer.bearer` is present here — `?? undefined` stays defensive.
			await addNode(name, peer.url, peer.bearer ?? undefined);
		} catch {
			// Already added — nothing to surface.
		}
	};

	if (mode === "persistent-sidebar") {
		return (
			<div className="space-y-0.5">
				<p className="mb-1 px-2 font-medium text-[10px] text-muted-foreground/60 uppercase tracking-wider">
					Nodes
				</p>
				<div className="space-y-0.5">
					{nodes.map((node) => (
						<NodeItem
							isActive={node.name === defaultNode}
							key={node.name}
							node={node}
							onHardware={() => setHardwareNode(node)}
							onRemove={() => removeNode(node.name)}
							onSelect={() => setDefault(node.name)}
							onShare={() => setShareNode(node)}
						/>
					))}
				</div>
				{/* Org-wallet nudge for managed (Ryu Cloud) inference, shown only when a
				    managed node is configured so a local-only install never sees it. */}
				{nodes.some((n) => n.managed) && <ManagedNodeWallet />}
				{/* Auto-detected cloud instances tied to this workspace, not yet added. */}
				<CloudSuggestions />
				{/* Prefer whichever node is actually reachable (opt-in, OFF by default). */}
				<AutoSelectRow />
				<button
					className="flex w-full items-center gap-1.5 px-2 py-1.5 text-muted-foreground/60 text-xs hover:text-muted-foreground"
					onClick={() => setAddOpen(true)}
					type="button"
				>
					<HugeiconsIcon icon={Add01Icon} size={11} />
					Add node
				</button>
				<button
					className="flex w-full items-center gap-1.5 px-2 py-1.5 text-muted-foreground/60 text-xs hover:text-muted-foreground"
					onClick={openManageCloudServers}
					type="button"
				>
					<HugeiconsIcon icon={Share08Icon} size={11} />
					Manage cloud servers
				</button>
				<AddNodeDialog onClose={() => setAddOpen(false)} open={addOpen} />
				<ShareNodeDialog
					magicDnsName={meshStatus?.magicDnsName ?? null}
					node={shareNode}
					onClose={() => setShareNode(null)}
					open={shareNode !== null}
				/>
				<NodeHardwareDialog
					node={hardwareNode}
					onClose={() => setHardwareNode(null)}
					open={hardwareNode !== null}
				/>
			</div>
		);
	}

	// compact-dropdown mode — trigger dot reflects system health
	return (
		<>
			<DropdownMenu>
				<DropdownMenuTrigger
					render={
						<Button
							className="max-w-[160px] gap-1.5 px-2"
							size="sm"
							variant="ghost"
						/>
					}
				>
					<span
						className={cn("size-2 shrink-0 rounded-full", TONE_DOT[tone])}
					/>
					<span className="min-w-0 truncate">
						{displayName(activeNode?.name ?? "local")}
					</span>
					<HugeiconsIcon
						className="shrink-0 text-muted-foreground"
						icon={ArrowDown01Icon}
						size={12}
					/>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="start" className="w-72 bg-popover/70">
					{nodes.map((node) => (
						<DropdownMenuItem
							key={node.name}
							onClick={() => setDefault(node.name)}
						>
							<span
								className={cn(
									"size-2 shrink-0 rounded-full",
									node.name === defaultNode
										? TONE_DOT[tone]
										: "bg-muted-foreground/30"
								)}
							/>
							<span className="flex-1">{displayName(node.name)}</span>
							{node.name === defaultNode && (
								<span className="text-muted-foreground text-xs">active</span>
							)}
							<button
								aria-label={`Share ${node.name}`}
								className="shrink-0 text-muted-foreground hover:text-foreground"
								onClick={(e) => {
									// Don't switch the active node or close the menu — just share.
									e.preventDefault();
									e.stopPropagation();
									setShareNode(node);
								}}
								type="button"
							>
								<HugeiconsIcon icon={Share08Icon} size={12} />
							</button>
						</DropdownMenuItem>
					))}
					{activeInfo && (
						<div className="px-3 pt-1 pb-1.5">
							<NodeStats info={activeInfo} />
						</div>
					)}
					{/* Full hardware detail sits right beneath the live usage bars it
					    expands on. */}
					{activeNode && (
						<DropdownMenuItem onClick={() => setHardwareNode(activeNode)}>
							<HugeiconsIcon icon={CpuIcon} size={12} />
							<span className="flex-1">Hardware</span>
						</DropdownMenuItem>
					)}
					{/* Org-wallet nudge for managed (Ryu Cloud) inference, shown only when
					    a managed node is configured. */}
					{nodes.some((n) => n.managed) && (
						<div className="px-1 pt-0.5 pb-1">
							<ManagedNodeWallet />
						</div>
					)}
					{/* Auto-detected cloud instances tied to this workspace, not yet added. */}
					<CloudSuggestions compact />
					{/* Prefer whichever node is actually reachable (opt-in, OFF by default). */}
					<AutoSelectRow compact />
					<DropdownMenuSeparator />
					<div className="px-1 py-0.5">
						<p className="px-2 pt-0.5 pb-1 font-medium text-[10px] text-muted-foreground/50 uppercase tracking-wider">
							Services
						</p>
						<ServiceRow
							label="Core"
							onChanged={refresh}
							onUpdate={handleAppUpdate}
							running={coreReachable}
							sidecarKey="core"
							target={target}
							updateAvailable={appUpdateAvailable}
							version={appVersion}
						/>
						<ServiceRow
							label={
								gatewayReachable && providerCount > 0
									? `Gateway · ${providerCount} provider${providerCount === 1 ? "" : "s"}`
									: "Gateway"
							}
							onChanged={refresh}
							onUpdate={handleAppUpdate}
							running={gatewayReachable}
							sidecarKey="gateway"
							target={target}
							updateAvailable={appUpdateAvailable}
							version={appVersion}
						/>
						<ServiceRow
							label="Shadow"
							onChanged={refresh}
							running={shadowReachable}
							sidecarKey="shadow"
							target={target}
						/>
						{/* Island is a device-local Electron companion (loopback :7989), not
						    a Core sidecar — Core can't start/stop it, so the row is
						    read-only status only. Hidden on remote nodes (islandReachable
						    is null = not relevant for another machine). */}
						{islandReachable !== null && (
							<ServiceRow
								label="Island"
								onChanged={refresh}
								onLaunch={handleIslandLaunch}
								readOnly
								running={islandReachable}
								sidecarKey="island"
								target={target}
							/>
						)}
					</div>
					<EnginesSection target={target} />
					<SandboxesSection enabled={coreReachable === true} target={target} />
					<MeshSection
						ingress={ingress ?? null}
						onAddPeer={handleAddPeer}
						peers={meshPeers ?? null}
						reachable={meshReachable}
						status={meshStatus}
					/>
					<ConnectedSection
						clients={connections?.clients ?? []}
						selfClientId={currentClientId()}
					/>
					<DropdownMenuSeparator />
					<DropdownMenuItem onClick={() => setAddOpen(true)}>
						<HugeiconsIcon icon={Add01Icon} size={12} />
						<span className="flex-1">Add node</span>
					</DropdownMenuItem>
					<DropdownMenuItem onClick={() => openGateway()}>
						<HugeiconsIcon icon={Settings01Icon} size={12} />
						<span className="flex-1">Gateway settings</span>
					</DropdownMenuItem>
					<DropdownMenuItem onClick={openManageCloudServers}>
						<HugeiconsIcon icon={Share08Icon} size={12} />
						<span className="flex-1">Manage cloud servers</span>
					</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>
			<AddNodeDialog onClose={() => setAddOpen(false)} open={addOpen} />
			<GatewayDialog
				defaultSection={gatewaySection}
				onOpenChange={setGatewayOpen}
				open={gatewayOpen}
			/>
			<AgentAutoRoutingEditor />
			<ShareNodeDialog
				magicDnsName={meshStatus?.magicDnsName ?? null}
				node={shareNode}
				onClose={() => setShareNode(null)}
				open={shareNode !== null}
			/>
			<NodeHardwareDialog
				node={hardwareNode}
				onClose={() => setHardwareNode(null)}
				open={hardwareNode !== null}
			/>
		</>
	);
}
