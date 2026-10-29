import {
	Add01Icon,
	Alert02Icon,
	ArrowDown01Icon,
	ArrowUp01Icon,
	BrainIcon,
	BrowserIcon,
	Cancel01Icon,
	CheckmarkBadge02Icon,
	CloudServerIcon,
	Copy01Icon,
	CpuIcon,
	CursorMagicSelection04Icon,
	Database01Icon,
	Delete01Icon,
	DollarCircleIcon,
	Download04Icon,
	ExpandIcon,
	File01Icon,
	FileSearchIcon,
	GlobeIcon,
	Image01Icon,
	LaptopIcon,
	LayerIcon,
	Layers01Icon,
	Link01Icon,
	Mic01Icon,
	PackageIcon,
	RankingIcon,
	RefreshIcon,
	Router01Icon,
	Search01Icon,
	ServerStack01Icon,
	Settings01Icon,
	Share08Icon,
	SparklesIcon,
	Tick02Icon,
	ViewIcon,
	ViewOffSlashIcon,
	VolumeHighIcon,
	WifiConnected01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import {
	SettingsCard,
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "@ryu/blocks/desktop/settings-items.tsx";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@ryu/ui/components/alert-dialog.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ryu/ui/components/dialog.tsx";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@ryu/ui/components/dropdown-menu.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { Progress } from "@ryu/ui/components/progress.tsx";
import { ExpandableQRCode } from "@ryu/ui/components/qr-code.tsx";
import { Switch } from "@ryu/ui/components/switch.tsx";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ryu/ui/components/tooltip.tsx";
import { buildRyuDeepLink, parseRyuDeepLink } from "@ryuhq/protocol/deep-link";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { CSSProperties as LayoutCSSProperties } from "react";
import {
	type ComponentProps,
	type ReactNode,
	useEffect,
	useState,
} from "react";
import { sileo } from "sileo";
import { WEB_URL } from "@/lib/app-urls.ts";
import { openExternal } from "@/lib/tauri-bridge.ts";
import { cn } from "@/lib/utils.ts";
import { AgentAutoRoutingEditor } from "@/src/components/agents/AgentAutoRoutingEditor.tsx";
import { CreateAgentDialog } from "@/src/components/agents/CreateAgentDialog.tsx";
import {
	GatewayDialog,
	preloadGatewayDialog,
} from "@/src/components/gateway/LazyGatewayDialog.tsx";
import { useSystemStatusContext } from "@/src/contexts/SystemStatusContext.tsx";
import {
	type CapabilityLayerEntry,
	useCapabilityLayers,
} from "@/src/hooks/useCapabilityLayers.ts";
import { useCreditsWallet } from "@/src/hooks/useCreditsWallet.ts";
import { useInterfaceLevel } from "@/src/hooks/useInterfaceLevel.ts";
import { useNodeSandboxes } from "@/src/hooks/useNodeSandboxes.ts";
import { useNodeSelectorDetail } from "@/src/hooks/useNodeSelectorDetail.ts";
import { useNodeSystemInfo } from "@/src/hooks/useNodeSystemInfo.ts";
import { useNodeVersion } from "@/src/hooks/useNodeVersion.ts";
import { useOrgBillingStatus } from "@/src/hooks/useOrgBillingStatus.ts";
import {
	type CapabilityProvider,
	canServe,
	describeBindingFailure,
} from "@/src/lib/api/capability-layers.ts";
import { type ApiTarget, currentClientId } from "@/src/lib/api/client.ts";
import {
	type ConnectedClient,
	fetchConnections,
} from "@/src/lib/api/connections.ts";
import { formatMicroUsd } from "@/src/lib/api/credits.ts";
import { fetchActiveEngine, setActiveEngine } from "@/src/lib/api/engines.ts";
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
	fetchMeshStatus,
	fetchWebhookIngressStatus,
	ingressLabel,
	isPublicTunnelBackend,
	MESH_BACKEND_CLOUDFLARED,
	MESH_BACKEND_HEADSCALE,
	MESH_BACKEND_OPENTUNNEL,
	MESH_BACKEND_PLUGIN,
	MESH_BACKEND_PREF,
	MESH_BACKEND_TAILCAT,
	MESH_BACKEND_TAILSCALE,
	MESH_LOGIN_SERVER_PREF,
	type MeshBackend,
	parseMeshBackend,
	setMeshBackend,
	setMeshEnabled,
	TUNNEL_CAPABILITY,
	type WebhookIngressStatus,
} from "@/src/lib/api/mesh.ts";
import {
	type EngineConcurrency,
	enableApp,
	fetchEngineConcurrency,
	fetchSidecarDetails,
	type SidecarDetail,
	startSidecar,
	stopSidecar,
} from "@/src/lib/api/plugins.ts";
import {
	DEFAULT_SPEECH_PROCESSING_PREFS,
	DEFAULT_VOICE_PREFS,
	DESKTOP_TTS_ENGINE_KEY,
	DESKTOP_TTS_VOICE_KEY,
	getDesktopTtsEngineOptions,
	getDesktopTtsPrefs,
	getPreference,
	getSpeechProcessingPrefs,
	getVoiceInputPrefs,
	SPEECH_PROCESSING_ENGINES,
	type SpeechProcessingContext,
	type SpeechProcessingStructure,
	type SpeechProcessingStyling,
	setDesktopTtsEngineOptions,
	setDesktopTtsPref,
	setSpeechProcessingPrefs,
	setVoiceInputPrefs,
	subscribeDesktopTtsPrefs,
	VOICE_ENGINES,
} from "@/src/lib/api/preferences.ts";
import {
	fetchSandboxBackends,
	setSandboxBackend,
} from "@/src/lib/api/sandbox.ts";
import {
	createSandbox,
	destroySandbox,
	type SandboxRun,
	type SandboxSpec,
} from "@/src/lib/api/sandboxes.ts";
import type { SystemInfo } from "@/src/lib/api/system.ts";
import {
	installSpeechProcessingModel,
	listSpeechProcessingEngines,
	listTtsEngines,
	type TtsEngine,
} from "@/src/lib/api/voice.ts";
import {
	connectionDisplayName,
	connectionSurfaceMeta,
} from "@/src/lib/connection-surface.ts";
import { triggerGlobalRefresh } from "@/src/lib/core-refresh.ts";
import { creditBalanceStatus } from "@/src/lib/credit-warning.ts";
import { ISLAND_ENABLED } from "@/src/lib/island-availability.ts";
import {
	type CatalogItem,
	fetchCatalog,
	fetchDependencies,
	installMissingDeps,
	installSidecar,
	uninstallSidecar,
} from "@/src/lib/services-api.ts";
import { invokeWhenReady } from "@/src/lib/tauri-ready.ts";
import { useGatewayDialog } from "@/src/store/useGatewayDialog.ts";
import {
	isLocalNode,
	LOCAL_FALLBACK,
	type Node,
	useNodeStore,
} from "@/src/store/useNodeStore.ts";
import { useSettingsDialog } from "@/src/store/useSettingsDialog.ts";
import { AutoScrollText } from "./AutoScrollText.tsx";
import { watchMeshInstall } from "./mesh-install.ts";
import {
	type LayerAction,
	type LayerOption,
	NodeLayerMenu,
	startStopAction,
} from "./NodeLayerMenu.tsx";
import {
	NodePanelNav,
	PanelBackButton,
	PanelGroup,
	PanelPageLink,
	PanelRow,
	PanelSection,
} from "./NodePanelNav.tsx";
import layoutStyles from "./NodeSelector.module.css";
import { WebSearchAccessMenu } from "./WebSearchAccessMenu.tsx";

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

const TONE_DOT = {
	green: "bg-success",
	amber: "bg-warning",
	red: "bg-destructive",
	pending: "bg-muted-foreground/40",
} satisfies Record<Tone, string>;

const displayName = (name: string) =>
	name.charAt(0).toUpperCase() + name.slice(1);

const computerName = (node: Node) =>
	isLocalNode(node) ? "Your computer" : displayName(node.name);

function StatusDot({ online }: { online: boolean | null }) {
	// The dot's hue is the only visual cue, so name the state for assistive tech
	// and expose it on hover.
	let status = "Offline";
	if (online === null) {
		status = "Checking status";
	} else if (online) {
		status = "Online";
	}
	return (
		<span
			aria-label={status}
			className={cn(
				"size-2 shrink-0 rounded-full",
				online === null && "bg-muted-foreground/40",
				online === true && "bg-success",
				online === false && "bg-warning"
			)}
			role="img"
			title={status}
		/>
	);
}

function NodeStatusIcon({
	borderClassName,
	icon,
	subdued = false,
	tone,
}: {
	borderClassName: string;
	icon: IconSvgElement;
	subdued?: boolean;
	tone?: Tone;
}) {
	return (
		<span
			aria-hidden
			className="relative inline-flex size-3.5 shrink-0"
			data-slot="node-status-icon"
		>
			<HugeiconsIcon
				className={cn(
					"size-3.5",
					subdued ? "text-muted-foreground/30" : "text-muted-foreground/70"
				)}
				icon={icon}
				size={14}
			/>
			{tone && (
				<span
					className={cn(
						"absolute -right-0.5 -bottom-0.5 size-2 rounded-full border-2",
						borderClassName,
						TONE_DOT[tone]
					)}
					data-slot="node-status-dot"
				/>
			)}
		</span>
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
	const cssVariables1: LayoutCssVariables = {
		"--desktop-inline1-width": `${pct}%`,
	};
	return (
		<div className="space-y-0.5">
			<div className="type-compact flex items-center justify-between gap-2 text-muted-foreground/70">
				<span>{label}</span>
				<span className="tabular-nums">
					{compactUsage(usedHuman, totalHuman) || "—"}
				</span>
			</div>
			{pct !== null && (
				<div className="h-1 overflow-hidden rounded-full bg-muted-foreground/15">
					<div
						className={cn(
							cn("h-full rounded-full", barColor(pct)),
							layoutStyles.inline1
						)}
						style={cssVariables1}
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
								<p className="type-compact relative truncate text-muted-foreground/70">
									{specs.join(" · ")}
								</p>
							}
						/>
						<TooltipContent>{info.cpuName}</TooltipContent>
					</Tooltip>
				) : (
					<p className="type-compact truncate text-muted-foreground/70">
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
									<span className="tabular-nums">{ramPct}%</span>
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
									<span className="tabular-nums">{diskPct}%</span>
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
							<span
								className={
									dep.installed ? "text-status-success" : "text-status-warning"
								}
							>
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
					variant="ghost"
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
		userJwt: node?.userJwt ?? null,
	};
	return (
		<Dialog onOpenChange={(v) => !v && onClose()} open={open}>
			<DialogContent className="flex max-h-[85vh] max-w-md flex-col">
				<DialogHeader>
					<DialogTitle>
						Hardware{node ? ` · ${computerName(node)}` : ""}
					</DialogTitle>
				</DialogHeader>
				<div className="scroll-fade -mr-2 min-h-0 flex-1 space-y-5 overflow-y-auto pr-2">
					<NodeHardwareContent
						enabled={open && node !== null}
						target={target}
					/>
				</div>
			</DialogContent>
		</Dialog>
	);
}

/** Hardware specs + dependency checks for one node: the body of the Hardware
 *  dialog and of the expanded node dialog's Hardware page. */
function NodeHardwareContent({
	target,
	enabled,
	pending = false,
}: {
	target: ApiTarget;
	enabled: boolean;
	/** The node's reachability is still being probed: read as loading, not as
	 *  unreachable, until `enabled` settles. */
	pending?: boolean;
}) {
	const { data: info, isLoading } = useNodeSystemInfo(target, enabled);

	let body: ReactNode;
	if (info) {
		body = <NodeHardwareBody info={info} />;
	} else if (isLoading || pending) {
		body = (
			<div className="flex h-32 items-center justify-center text-muted-foreground text-sm">
				Loading hardware…
			</div>
		);
	} else {
		body = (
			<div className="flex h-32 items-center justify-center text-muted-foreground text-sm">
				Computer unreachable — couldn't load hardware.
			</div>
		);
	}

	return (
		<>
			{body}
			{enabled && <NodeDependenciesSection target={target} />}
		</>
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
	const [link, setLink] = useState("");
	const [error, setError] = useState<string | null>(null);
	// LAN discovery, folded in from the node dropdown: sweep the local /24 for
	// reachable Core nodes and add one in a click — right where you'd otherwise
	// type its address by hand.
	const [scanning, setScanning] = useState(false);
	const [discovered, setDiscovered] = useState<DiscoveredNode[] | null>(null);

	// One line instead of three boxes: a `ryu://nodes/connect?…` connection string
	// carries address, label and (when the sender had one) bearer, so copying a
	// node between surfaces is a paste rather than a transcription. The grammar is
	// owned by `@ryuhq/protocol/deep-link` — parsed here, never re-implemented.
	// It only PRE-FILLS: the user still presses Add, so a string from a hostile
	// clipboard can never connect on its own.
	const handleLinkChange = (value: string) => {
		setLink(value);
		if (!value.trim()) {
			return;
		}
		const parsed = parseRyuDeepLink(value);
		if (parsed?.kind !== "node") {
			setError("That doesn't look like a Ryu connection string");
			return;
		}
		setName(parsed.name);
		setUrl(parsed.url);
		setToken(parsed.token ?? "");
		setError(null);
	};

	const handleAdd = async () => {
		setError(null);
		try {
			await addNode(name.trim(), url.trim(), token.trim() || undefined);
			setName("");
			setUrl("");
			setToken("");
			setLink("");
			onClose();
		} catch (e) {
			setError(String(e));
		}
	};

	const handleScanLan = async () => {
		setScanning(true);
		setDiscovered(null);
		try {
			const found =
				await invokeWhenReady<DiscoveredNode[]>("discover_lan_nodes");
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
		// Name from host AND profile. Host alone was enough while discovery swept a
		// single port; now that every profile's port is swept, one machine can
		// return several nodes and a host-only name would collide — the canary node
		// would silently fail to add because release already took the name.
		const hostPort = node.url.replace(URL_SCHEME, "");
		const host = hostPort.split(":")[0] ?? "node";
		const suffix =
			node.profile && node.profile !== "release" ? `-${node.profile}` : "";
		const discoveredName = `node-${host.replace(/\./g, "-")}${suffix}`;
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
					<DialogTitle>Add computer</DialogTitle>
				</DialogHeader>
				<div className="space-y-3">
					<div className="space-y-1">
						<Input
							aria-label="Connection string"
							id="node-link"
							onChange={(e) => handleLinkChange(e.target.value)}
							placeholder="ryu://nodes/connect?url=…"
							size="lg"
							value={link}
							variant="code-caption"
						/>
						<p className="type-caption text-muted-foreground">
							Paste a connection string to fill the fields below — copy one from
							Console on the web or another computer's Share menu.
						</p>
					</div>
					<div className="type-caption flex items-center gap-2 text-muted-foreground/60">
						<span className="h-px flex-1 bg-border/60" />
						or enter it manually
						<span className="h-px flex-1 bg-border/60" />
					</div>
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
					{error && <p className="text-status-destructive text-xs">{error}</p>}
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
							<p className="type-caption text-muted-foreground/60">
								No new computers found
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
								<span
									className="flex-1 truncate text-left"
									title={d.url.replace(URL_SCHEME, "")}
								>
									{d.url.replace(URL_SCHEME, "")}
								</span>
								<span className="type-compact shrink-0 text-muted-foreground/60 tabular-nums">
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
						Add computer
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
					<DialogTitle>Connect a computer to {computerName(node)}</DialogTitle>
				</DialogHeader>
				<div className="space-y-3">
					<div className="space-y-1">
						<p className="type-caption text-muted-foreground">
							Address other computers use to reach this computer
						</p>
						<Input
							aria-label="Shareable address"
							onChange={(e) => setHost(e.target.value)}
							placeholder="http://192.168.1.50:7980"
							size="lg"
							value={host}
						/>
						{isLoopback && (
							<p className="type-caption text-status-warning">
								Other devices can't reach a localhost address. Enter this
								machine's LAN IP (e.g. 192.168.1.50) or Tailscale name.
							</p>
						)}
					</div>

					{node.token && (
						<div className="space-y-1">
							<div className="flex items-center justify-between">
								<p className="type-caption text-muted-foreground">
									Token (included in the link)
								</p>
								<button
									className="type-caption flex items-center gap-1 text-muted-foreground hover:text-foreground"
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
							<p className="type-caption truncate rounded-md bg-muted/40 px-2 py-1 font-mono text-muted-foreground">
								{revealToken ? node.token : "•".repeat(16)}
							</p>
						</div>
					)}

					{link && (
						<>
							<div className="flex items-center gap-2">
								<Input
									aria-label="Connect link"
									readOnly
									size="lg"
									typography="caption"
									value={link}
									variant="code"
								/>
								<Button onClick={copy} size="sm" variant="secondary">
									<HugeiconsIcon icon={Copy01Icon} size={14} />
									Copy
								</Button>
							</div>
							<div className="flex flex-col items-center gap-2 pt-1">
								<ExpandableQRCode size={160} value={link} />
								<p className="type-caption text-muted-foreground">
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
	const [confirmRemove, setConfirmRemove] = useState(false);

	useEffect(() => {
		const check = async () => {
			try {
				const result = await invokeWhenReady<{ online: boolean }>("test_node", {
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
		{ url: node.url, token: node.token, userJwt: node.userJwt ?? null },
		online === true
	);

	return (
		<>
			{/* The row is a plain container: the name is the select button, and its
			    ::after stretches over the whole row so a click anywhere selects. The
			    badges and action buttons are positioned siblings painted above that
			    overlay, so no interactive control is nested inside another. */}
			<div
				className={cn(
					"group relative rounded-xl text-sm",
					isActive
						? "bg-accent text-accent-foreground"
						: "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
				)}
			>
				<div className="flex items-center gap-2 px-2 py-1.5">
					<StatusDot online={online} />
					<button
						aria-pressed={isActive}
						className="min-w-0 flex-1 cursor-pointer truncate text-left outline-none after:absolute after:inset-0 after:rounded-xl focus-visible:after:ring-2 focus-visible:after:ring-ring"
						onClick={onSelect}
						title={computerName(node)}
						type="button"
					>
						{computerName(node)}
					</button>
					{(node.managed || info?.managed) && (
						<Tooltip>
							<TooltipTrigger
								render={
									<span className="type-micro relative shrink-0 rounded-full bg-accent px-1.5 py-0.5 font-medium text-accent-foreground">
										Cloud Computers
									</span>
								}
							/>
							<TooltipContent>
								{info?.orgName
									? `Cloud Computers · ${info.orgName}`
									: "Cloud Computers"}
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
									<span className="type-micro relative shrink-0 rounded-full bg-accent px-1.5 py-0.5 font-medium text-accent-foreground">
										GPU
									</span>
								}
							/>
							<TooltipContent>{info.gpuName}</TooltipContent>
						</Tooltip>
					)}
					{onHardware && (
						<button
							aria-label={`Hardware for ${computerName(node)}`}
							className="relative shrink-0 opacity-0 after:absolute after:-inset-1.5 hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
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
							aria-label={`Share ${computerName(node)}`}
							className="relative shrink-0 opacity-0 after:absolute after:-inset-1.5 hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
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
							aria-label={`Remove ${computerName(node)}`}
							className="relative shrink-0 opacity-0 after:absolute after:-inset-1.5 hover:text-status-destructive focus-visible:opacity-100 group-hover:opacity-100"
							onClick={(e) => {
								e.stopPropagation();
								setConfirmRemove(true);
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
			{/* Rendered outside the row so portal clicks never bubble into its
		    select handler. */}
			{onRemove && (
				<AlertDialog onOpenChange={setConfirmRemove} open={confirmRemove}>
					<AlertDialogContent>
						<AlertDialogHeader>
							<AlertDialogTitle>Remove {computerName(node)}?</AlertDialogTitle>
							<AlertDialogDescription>
								This computer is removed from your list. You can add it again
								later with its address or pairing link.
							</AlertDialogDescription>
						</AlertDialogHeader>
						<AlertDialogFooter>
							<AlertDialogCancel>Cancel</AlertDialogCancel>
							<AlertDialogAction
								onClick={() => {
									setConfirmRemove(false);
									onRemove();
								}}
								variant="destructive"
							>
								Remove computer
							</AlertDialogAction>
						</AlertDialogFooter>
					</AlertDialogContent>
				</AlertDialog>
			)}
		</>
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

/**
 * One service layer (Core / Gateway / Shadow / Island) as a submenu: the trigger
 * carries the health dot, name, live usage and version; Start / Stop / Update /
 * Launch sit at the top of the submenu instead of crowding the row with inline
 * buttons. A service is a singleton — nothing to swap to — so it passes no
 * installed/available lists.
 */
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
	currentLabel,
	icon,
	idleCaption,
	idleTone = "down",
}: {
	label: string;
	running: boolean | null;
	target: { url: string; token: string | null };
	sidecarKey: string;
	onChanged: () => Promise<void>;
	/** Optional resource sample; when running, renders a "1.2 GB · 12%" caption. */
	detail?: SidecarDetail;
	/** Submenu-header name of the thing behind this row, when it differs from the
	 *  row's own label ("Embeddings" is served by "llama.cpp"). Defaults to
	 *  `label`, which is right for a service that names itself (Core, Gateway). */
	currentLabel?: string;
	icon?: IconSvgElement;
	/** Caption for the stopped state. Defaults to "Stopped" — override for a
	 *  sidecar whose stopped state is normal rather than a fault. */
	idleCaption?: string;
	/** How "stopped" READS, which is not the same question as whether it is
	 *  stopped. `"down"` (default) paints the red dot: this thing is supposed to
	 *  be up, so down is a fault. `"neutral"` paints the grey dot for a lazily
	 *  started sidecar that is *designed* to sit stopped until first use — the
	 *  reranker only wakes on the first Space search, so a red dot there would
	 *  report a healthy fresh install as broken, permanently. The start/stop
	 *  action still reads the REAL state either way. */
	idleTone?: "down" | "neutral";
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
	const handleUpdate = async () => {
		if (!onUpdate) {
			return;
		}
		await onUpdate();
		await onChanged();
	};

	const handleLaunch = async () => {
		if (!onLaunch) {
			return;
		}
		await onLaunch();
		// Electron cold start + binding :7989 takes a few seconds, so give it a
		// beat before re-probing; the 5s status poll flips the dot regardless.
		await new Promise<void>((resolve) => setTimeout(resolve, 1000));
		await onChanged();
	};

	const handleToggle = async (next: boolean) => {
		try {
			if (next) {
				await startSidecar(target, sidecarKey);
			} else {
				await stopSidecar(target, sidecarKey);
			}
		} catch (e) {
			// NodeLayerMenu swallows the rejection (it only owns the spinner), so a
			// refusal has to be surfaced here or the row just silently does nothing
			// — the live case being a reranker whose 438 MB model was never
			// downloaded.
			sileo.error({
				title:
					e instanceof Error
						? e.message
						: `Couldn't ${next ? "start" : "stop"} ${label}`,
			});
		}
		// Give the process a moment to settle before re-polling status.
		await new Promise<void>((resolve) => setTimeout(resolve, 1000));
		await onChanged();
	};

	const usage = running ? usageCaption(detail) : null;
	const actions: LayerAction[] = [];
	if (running !== null && !readOnly) {
		actions.push(startStopAction(running, handleToggle));
	}
	if (updateAvailable && onUpdate) {
		actions.push({
			id: "update",
			label: "Update",
			busyLabel: "Updating…",
			icon: ArrowUp01Icon,
			tone: "warning",
			run: handleUpdate,
		});
	}
	if (onLaunch && running === false) {
		actions.push({
			id: "launch",
			label: "Install / Launch",
			busyLabel: "Launching…",
			icon: Download04Icon,
			run: handleLaunch,
		});
	}

	const idle = idleTone === "neutral";
	let caption: string;
	if (running === null) {
		caption = "Status unknown";
	} else if (running) {
		caption = usage ? `Running · ${usage}` : "Running";
	} else {
		caption = idleCaption ?? "Stopped";
	}

	return (
		<NodeLayerMenu
			actions={actions}
			caption={caption}
			currentLabel={currentLabel ?? label}
			icon={icon}
			label={label}
			// The dot reports the READING, not the raw state — see `idleTone`.
			running={idle && running === false ? null : running}
			trailing={
				usage ?? (running === false ? (idle ? "idle" : "stopped") : null)
			}
			version={version}
		/>
	);
}

/** The run-alongside modality groups the CATALOG drives, in display order. These
 *  map to the catalog's SidecarCategory: voice=speech, media=image.
 *  The `provider` (chat) category is NOT here — it is the single mutually-
 *  exclusive slot and gets its own swap layer. Agents/tools aren't engines.
 *
 *  `embedding` is deliberately absent even though the category exists. No
 *  embedding engine is a Store entry (see the NOTE in Core's
 *  `catalog/registry.rs`, test-locked at `embedding.len() == 0`): the local
 *  embeddings server is backing infrastructure that auto-starts, so it is
 *  rendered below as a status-driven row instead. Listing it here produced a
 *  group that was filtered out for having zero items on every node ever — i.e.
 *  the reason the dropdown had no Embeddings row at all. */
const RUN_ALONGSIDE_GROUPS: Array<{
	category: CatalogItem["category"];
	icon: IconSvgElement;
	label: string;
}> = [{ label: "Image", category: "media", icon: Image01Icon }];

/**
 * The two llama.cpp-derived engines that serve retrieval, keyed by their sidecar
 * name. Neither is a catalog entry (see {@link RUN_ALONGSIDE_GROUPS}), so they
 * are driven straight off `/api/sidecar/status`, which reports both: the
 * embeddings server from `startup_order`, the reranker from the registered-but-
 * not-auto-started tail.
 *
 * The reranker's `idleTone` is the load-bearing bit: Core starts it lazily on
 * the first Space search, so "stopped" is its healthy resting state, not a
 * fault.
 */
const RETRIEVAL_ENGINES: Array<{
	icon: IconSvgElement;
	idleCaption?: string;
	idleTone?: "down" | "neutral";
	key: string;
	label: string;
}> = [
	{
		key: "llamacpp-embed",
		label: "Embeddings",
		icon: Database01Icon,
		// In `startup_order` — down really does mean broken here.
		idleCaption: "Stopped · semantic search falls back to keywords",
	},
	{
		key: "llamacpp-rerank",
		label: "Reranker",
		icon: RankingIcon,
		idleTone: "neutral",
		idleCaption: "Idle · wakes on the first Space search",
	},
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
		<span className="type-compact font-medium text-muted-foreground/60 tabular-nums">
			{slots}
			{queued > 0 ? ` · ${queued} queued` : ""}
		</span>
	);
}

/**
 * The node's engine spine: the catalog (what's installed), a live sidecar sample
 * (running + memory/CPU), the resident chat and the admission-queue depth.
 *
 * Both engine-bearing sections share this ONE query — same key, same fetcher, so
 * React Query serves them from a single 5s poll instead of two.
 */
function useNodeEngines(target: ApiTarget) {
	const query = useQuery({
		queryKey: ["node-engines", target.url],
		queryFn: async () => {
			const [catalog, details, active, concurrency] = await Promise.all([
				fetchCatalog(target.url, target.token, undefined, target.userJwt),
				fetchSidecarDetails(target).catch(
					() =>
						/* SAFETY: This failure fallback constructs an empty object locally; there are no sidecar entries to violate SidecarDetail. */ ({}) as Record<
							string,
							SidecarDetail
						>
				),
				// The resident chat (mutually-exclusive slot). Best-effort:
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

	return {
		catalog: query.data?.catalog ?? [],
		details: query.data?.details ?? {},
		activeChat: query.data?.active ?? null,
		concurrency: query.data?.concurrency ?? null,
		refresh: async () => {
			await query.refetch();
		},
	};
}

/** Install a catalog engine on `target`, reporting either outcome. */
async function installEngine(target: ApiTarget, item: CatalogItem) {
	try {
		await installSidecar(
			target.url,
			target.token,
			item.name,
			false,
			undefined,
			target.userJwt
		);
		sileo.success({ title: `Installing ${item.displayName}` });
	} catch (e) {
		sileo.error({
			title:
				e instanceof Error ? e.message : `Couldn't install ${item.displayName}`,
		});
	}
}

function EnginesSection({ target }: { target: ApiTarget }) {
	const { catalog, details, activeChat, concurrency, refresh } =
		useNodeEngines(target);

	/** Install a not-yet-present engine, then reconcile the list. */
	const install = async (item: CatalogItem) => {
		await installEngine(target, item);
		await refresh();
	};

	const uninstall = async (item: CatalogItem) => {
		try {
			await uninstallSidecar(
				target.url,
				target.token,
				item.name,
				target.userJwt
			);
			sileo.success({ title: `Removed ${item.displayName}` });
		} catch (e) {
			sileo.error({
				title:
					e instanceof Error
						? e.message
						: `Couldn't remove ${item.displayName}`,
			});
		}
		await refresh();
	};

	/** Swap the resident chat. NOT a sidecar start/stop — the mutually-
	 *  exclusive slot moves via `/api/engine/active`, which also stops the engine
	 *  it displaced and refreshes the gateway's model list. */
	const activate = async (item: CatalogItem) => {
		try {
			const swap = await setActiveEngine(target, item.name);
			if (!swap.unchanged) {
				sileo.success({ title: `Chat → ${item.displayName}` });
			}
		} catch (e) {
			sileo.error({
				title:
					e instanceof Error
						? e.message
						: `Couldn't switch to ${item.displayName}`,
			});
		}
		await refresh();
	};

	/** Start/stop one run-alongside engine (speech / image / embeddings). */
	const toggleEngine = async (item: CatalogItem, next: boolean) => {
		try {
			if (next) {
				await startSidecar(target, item.name);
			} else {
				await stopSidecar(target, item.name);
			}
			// Give the process a moment to settle before re-polling status.
			await new Promise<void>((resolve) => setTimeout(resolve, 1000));
		} catch (e) {
			sileo.error({
				title:
					e instanceof Error
						? e.message
						: `Couldn't ${next ? "start" : "stop"} ${item.displayName}`,
			});
		}
		await refresh();
	};

	/** Not-installed rows, shared by every engine layer. Unsupported entries stay
	 *  visible but inert, with the reason where the version badge would go. */
	const availableOptions = (items: CatalogItem[]): LayerOption[] =>
		items
			.filter((item) => item.installState !== "installed")
			.map((item) => ({
				name: item.name,
				label: item.displayName,
				detail:
					item.installState === "installing"
						? "installing…"
						: item.latestVersion,
				disabled: !item.supported,
				disabledReason: "unsupported here",
				select: () => install(item),
			}));

	const providers = catalog.filter((item) => item.category === "provider");
	const chatInstalled = providers.filter(
		(item) => item.installState === "installed"
	);
	// Prefer the engine Core reports as resident; fall back to whichever provider
	// is actually running, so a Core without the surface still reads correctly.
	const activeChatName =
		activeChat ??
		chatInstalled.find((item) => details[item.name]?.running)?.name ??
		null;
	const activeChatItem =
		chatInstalled.find((item) => item.name === activeChatName) ?? null;
	const chatRunning = activeChatItem
		? (details[activeChatItem.name]?.running ?? false)
		: null;
	const chatUsage = activeChatItem
		? usageCaption(details[activeChatItem.name])
		: null;

	const groups = RUN_ALONGSIDE_GROUPS.map((group) => ({
		...group,
		items: catalog.filter((item) => item.category === group.category),
	})).filter((group) => group.items.length > 0);

	// Presence in the status map, not a hardcoded assumption: an older Core that
	// doesn't report a key simply doesn't get the row, and an unreachable node
	// (empty map) fabricates none.
	const retrieval = RETRIEVAL_ENGINES.filter((engine) => engine.key in details);

	if (providers.length === 0 && groups.length === 0 && retrieval.length === 0) {
		return null;
	}

	return (
		<PanelSection
			title="Engines"
			trailing={<EngineQueueBadge concurrency={concurrency} />}
		>
			{providers.length > 0 && (
				// The single mutually-exclusive chat slot. No start/stop and no
				// per-engine update: engine downloads are pinned to a compile-time
				// target (the catalog's upstream `latestVersion` is informational) and
				// they upgrade with the app.
				<NodeLayerMenu
					available={availableOptions(providers)}
					caption={
						activeChatItem
							? `Resident chat${chatRunning ? ` · ${chatUsage ?? "running"}` : " · idle"}`
							: "No chat selected"
					}
					currentLabel={activeChatItem?.displayName ?? "None"}
					icon={LayerIcon}
					installed={chatInstalled.map(
						(item): LayerOption => ({
							name: item.name,
							label: item.displayName,
							active: item.name === activeChatName,
							detail: item.installedVersion,
							select: () => activate(item),
							// Never offer to remove the engine currently bound to local
							// agents — swap off it first, then it becomes removable.
							uninstall:
								item.name === activeChatName
									? undefined
									: () => uninstall(item),
						})
					)}
					label="Chat"
					running={chatRunning}
					version={activeChatItem?.installedVersion}
				/>
			)}
			{groups.map((group) => {
				const installed = group.items.filter(
					(item) => item.installState === "installed"
				);
				const runningItems = installed.filter(
					(item) => details[item.name]?.running
				);
				let currentLabel: string;
				if (runningItems.length > 0) {
					currentLabel = runningItems.map((i) => i.displayName).join(", ");
				} else if (installed.length > 0) {
					currentLabel = "None running";
				} else {
					currentLabel = "Not installed";
				}
				return (
					<NodeLayerMenu
						available={availableOptions(group.items)}
						caption={
							installed.length > 0
								? `${runningItems.length} of ${installed.length} running · these run alongside Chat`
								: "Nothing installed yet"
						}
						currentLabel={currentLabel}
						icon={group.icon}
						installed={installed.map(
							(item): LayerOption => ({
								name: item.name,
								label: item.displayName,
								active: details[item.name]?.running ?? false,
								detail:
									usageCaption(details[item.name]) ?? item.installedVersion,
								select: () =>
									toggleEngine(item, !(details[item.name]?.running ?? false)),
								uninstall: () => uninstall(item),
							})
						)}
						key={group.label}
						label={group.label}
						running={installed.length === 0 ? null : runningItems.length > 0}
						selectionMode="toggle"
					/>
				);
			})}
			{/* The retrieval engines. Both are llama.cpp processes on their own
			    ports, started/stopped as sidecars — not swappable, so they get a
			    status row each rather than a catalog-backed group. */}
			{retrieval.map((engine) => (
				<ServiceRow
					currentLabel="llama.cpp"
					detail={details[engine.key]}
					icon={engine.icon}
					idleCaption={engine.idleCaption}
					idleTone={engine.idleTone}
					key={engine.key}
					label={engine.label}
					onChanged={refresh}
					running={details[engine.key]?.running ?? null}
					sidecarKey={engine.key}
					target={target}
				/>
			))}
		</PanelSection>
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
				<span className="type-micro shrink-0 rounded-full bg-accent px-1.5 py-0.5 font-medium text-accent-foreground">
					GPU
				</span>
			)}
			<span className="type-compact shrink-0 text-muted-foreground/50 tabular-nums">
				{formatElapsed(run.elapsedSeconds)}
			</span>
			<button
				className="type-compact shrink-0 rounded-md px-1.5 py-0.5 text-muted-foreground hover:bg-accent hover:text-status-destructive disabled:opacity-50"
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
		<div className="px-1 py-0.5">
			<div className="flex items-center justify-between px-2 pt-0.5 pb-1">
				<p className="type-compact font-medium text-muted-foreground/50">
					Running sandboxes · {sandboxes.length}
				</p>
				<button
					className="type-compact flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
					disabled={creating}
					onClick={handleCreate}
					type="button"
				>
					<HugeiconsIcon className="size-3" icon={Add01Icon} />
					{creating ? "Creating…" : "New sandbox"}
				</button>
			</div>
			{sandboxes.length === 0 ? (
				<p className="type-compact px-2 pb-0.5 text-muted-foreground/50">
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
	);
}

/**
 * The remaining swappable layers of a node that aren't catalog sidecars: the
 * Audio engine + voice, the Voice Recognition engine, and the sandbox
 * backend the agent's `sandbox_exec` tool runs in.
 *
 * These share ONE poll (Audio engines + Voice Recognition preference + sandbox backends + a
 * sidecar sample) so adding three layers to the dropdown costs one request, not
 * four. Each layer renders as the same submenu as the engines above it.
 *
 * The sandbox backend answers "which sandbox am I actually using" — it defaults
 * to wasmtime and is distinct from the Running Sandboxes list below, which is
 * the live runs, not the runtime choice.
 */
function VoiceAndSandboxSection({
	target,
	enabled,
}: {
	target: ApiTarget;
	enabled: boolean;
}) {
	// The Audio default is device-local (localStorage), so it is not reactive on its
	// own — mirror it into state and re-read whenever any surface writes it.
	const [ttsPrefs, setTtsPrefs] = useState(getDesktopTtsPrefs);
	useEffect(
		() => subscribeDesktopTtsPrefs(() => setTtsPrefs(getDesktopTtsPrefs())),
		[]
	);

	// The catalog + live sidecar sample, shared with the Engines section above (same
	// query key ⇒ one poll). Audio, Voice Recognition, and Speech Processing each
	// have their own layer: ASR produces text, Speech Processing optionally cleans
	// it, and Audio speaks it back.
	const { catalog, details, refresh: refreshEngines } = useNodeEngines(target);

	const query = useQuery({
		queryKey: ["node-voice-sandbox", target.url],
		queryFn: async () => {
			const [
				ttsEngines,
				sttPrefs,
				speechProcessingEngines,
				speechProcessingPrefs,
				sandboxBackends,
			] = await Promise.all([
				listTtsEngines(target).catch(() => []),
				getVoiceInputPrefs(target).catch(() => DEFAULT_VOICE_PREFS),
				listSpeechProcessingEngines(target).catch(() => []),
				getSpeechProcessingPrefs(target).catch(
					() => DEFAULT_SPEECH_PROCESSING_PREFS
				),
				// Absent on an older Core → no sandbox layer rather than a fake one.
				fetchSandboxBackends(target).catch(() => null),
			]);
			return {
				ttsEngines,
				sttPrefs,
				speechProcessingEngines,
				speechProcessingPrefs,
				sandboxBackends,
			};
		},
		enabled,
		refetchInterval: 15_000,
		retry: false,
	});

	const refresh = async () => {
		await Promise.all([query.refetch(), refreshEngines()]);
	};

	const ttsEngines = query.data?.ttsEngines ?? [];
	const sttPrefs = query.data?.sttPrefs ?? DEFAULT_VOICE_PREFS;
	const speechProcessingEngines = query.data?.speechProcessingEngines ?? [];
	const speechProcessingPrefs =
		query.data?.speechProcessingPrefs ?? DEFAULT_SPEECH_PROCESSING_PREFS;
	const sandboxBackends = query.data?.sandboxBackends ?? null;

	/** Start/stop/install one voice sidecar by catalog name, then reconcile. */
	const catalogItem = (name: string) =>
		catalog.find((item) => item.name === name) ?? null;

	const toggleSidecar = async (name: string, label: string, next: boolean) => {
		try {
			if (next) {
				await startSidecar(target, name);
			} else {
				await stopSidecar(target, name);
			}
			await new Promise<void>((resolve) => setTimeout(resolve, 1000));
		} catch (e) {
			sileo.error({
				title:
					e instanceof Error
						? e.message
						: `Couldn't ${next ? "start" : "stop"} ${label}`,
			});
		}
		await refresh();
	};

	/** The install/start action a voice layer needs before it can actually run —
	 *  null once its sidecar is installed AND up. Mirrors the Voice settings tab's
	 *  "Install / Start Ryu Audio engine" prompt, so the dropdown isn't a dead end
	 *  for an engine the node hasn't downloaded yet. */
	const sidecarReadyAction = (
		name: string,
		label: string
	): LayerAction | null => {
		const item = catalogItem(name);
		if (!item) {
			return null;
		}
		if (item.installState !== "installed") {
			return {
				id: `install-${name}`,
				label: `Install ${label}`,
				busyLabel: "Installing…",
				icon: Download04Icon,
				run: async () => {
					await installEngine(target, item);
					await refresh();
				},
			};
		}
		if (!details[name]?.running) {
			return {
				id: `start-${name}`,
				label: `Start ${label}`,
				busyLabel: "Starting…",
				run: () => toggleSidecar(name, label, true),
			};
		}
		return null;
	};

	// ---- Text-to-speech -----------------------------------------------------
	const selectedTts = ttsEngines.find((e) => e.id === ttsPrefs.engine) ?? null;
	const activeVoice = ttsPrefs.voice || selectedTts?.default_voice || "";

	const pickTtsEngine = (engine: TtsEngine) => {
		const engineOptions = getDesktopTtsEngineOptions(engine.id);
		const savedVoice = engineOptions.voice;
		const voice =
			savedVoice && engine.voices.includes(savedVoice)
				? savedVoice
				: engine.voices.includes(activeVoice)
					? activeVoice
					: (engine.default_voice ?? "");
		setDesktopTtsPref(DESKTOP_TTS_ENGINE_KEY, engine.id);
		setDesktopTtsPref(DESKTOP_TTS_VOICE_KEY, voice);
		setDesktopTtsEngineOptions(engine.id, { voice });
	};

	// The multi-engine Audio sidecar that serves every non-built-in voice.
	const ttsReadyAction = sidecarReadyAction("ryutts", "Ryu Audio engine");

	// ---- Speech-to-text -----------------------------------------------------
	const selectedStt =
		VOICE_ENGINES.find((e) => e.engine === sttPrefs.engine) ?? VOICE_ENGINES[0];
	const selectedSttSidecar = selectedStt.sidecar;
	const sttRunning = selectedSttSidecar
		? (details[selectedSttSidecar]?.running ?? false)
		: true;

	const pickStt = async (entry: (typeof VOICE_ENGINES)[number]) => {
		try {
			// Switching engine also moves to that engine's bundled model.
			await setVoiceInputPrefs(target, {
				...sttPrefs,
				engine: entry.engine,
				model: entry.model,
			});
		} catch (e) {
			sileo.error({
				title: e instanceof Error ? e.message : "Couldn't switch voice engine",
			});
		}
		await refresh();
	};

	const toggleStt = (next: boolean) =>
		selectedSttSidecar
			? toggleSidecar(selectedSttSidecar, selectedStt.label, next)
			: Promise.resolve();

	// Transcription needs its sidecar present before Start means anything, so an
	// uninstalled engine offers Install first.
	const sttActions: LayerAction[] = [];
	const sttReady = selectedSttSidecar
		? sidecarReadyAction(selectedSttSidecar, selectedStt.label)
		: null;
	if (sttReady) {
		sttActions.push(sttReady);
	} else {
		sttActions.push(startStopAction(sttRunning, toggleStt));
	}
	const sttInstalled = selectedSttSidecar
		? catalogItem(selectedSttSidecar)?.installState === "installed"
		: true;

	// ---- Speech Processing --------------------------------------------------
	// S1-mini is a separate, lazy local model. Voice Recognition creates the raw
	// transcript; this layer only formats it when Dictation cleanup is enabled.
	const selectedSpeech =
		speechProcessingEngines.find(
			(engine) => engine.id === speechProcessingPrefs.engine
		) ??
		speechProcessingEngines[0] ??
		null;
	const selectedSpeechMeta =
		SPEECH_PROCESSING_ENGINES.find(
			(engine) => engine.engine === speechProcessingPrefs.engine
		) ?? SPEECH_PROCESSING_ENGINES[0];
	const speechInstalled = selectedSpeech?.installed ?? false;
	const speechRunning = selectedSpeech?.loaded ?? false;

	const updateSpeechProcessing = async (
		patch: Partial<typeof speechProcessingPrefs>
	) => {
		try {
			await setSpeechProcessingPrefs(target, {
				...speechProcessingPrefs,
				...patch,
			});
		} catch (e) {
			sileo.error({
				title:
					e instanceof Error ? e.message : "Couldn't update Speech Processing",
			});
		}
		await refresh();
	};

	const pickSpeechProcessing = async (
		entry: (typeof SPEECH_PROCESSING_ENGINES)[number]
	) => {
		await updateSpeechProcessing({ engine: entry.engine });
	};

	const installSpeechProcessing = async () => {
		try {
			await installSpeechProcessingModel(target, speechProcessingPrefs.engine);
			sileo.success({ title: `Installing ${selectedSpeechMeta.label}` });
		} catch (e) {
			sileo.error({
				title:
					e instanceof Error
						? e.message
						: `Couldn't install ${selectedSpeechMeta.label}`,
			});
		}
		await refresh();
	};

	const speechInstallAction: LayerAction | null = speechInstalled
		? null
		: {
				id: "install-speech-processing",
				label: `Install ${selectedSpeechMeta.label}`,
				busyLabel: "Installing…",
				icon: Download04Icon,
				run: installSpeechProcessing,
			};
	const speechActions: LayerAction[] = speechInstallAction
		? [speechInstallAction]
		: [
				startStopAction(speechRunning ? true : null, (next) =>
					toggleSidecar(
						selectedSpeechMeta.sidecar,
						selectedSpeechMeta.label,
						next
					)
				),
			];
	const speechStyles: SpeechProcessingStyling[] = [
		"casual",
		"semi-casual",
		"semi-formal",
		"formal",
	];
	const speechStructures: SpeechProcessingStructure[] = ["prose", "lists"];
	const speechContexts: SpeechProcessingContext[] = ["general", "email"];

	// ---- Sandbox backend ----------------------------------------------------
	const activeBackend =
		sandboxBackends?.available.find((b) => b.name === sandboxBackends.active) ??
		null;

	const pickBackend = async (name: string, label: string) => {
		try {
			await setSandboxBackend(target, name);
			sileo.success({ title: `Sandbox → ${label}` });
		} catch (e) {
			sileo.error({
				title: e instanceof Error ? e.message : `Couldn't switch to ${label}`,
			});
		}
		await refresh();
	};

	// Voice Recognition is a fixed, always-valid list, so it shows on any reachable
	// node — its visibility is deliberately NOT tied to the Audio/sandbox probes.
	if (!enabled) {
		return null;
	}

	return (
		<PanelSection>
			{ttsEngines.length > 0 && (
				<NodeLayerMenu
					// The extra (non-built-in) voices only exist once the `ryutts`
					// sidecar is installed and up, so surface that bring-up here rather
					// than sending the user to the Voice settings tab for it.
					actions={ttsReadyAction ? [ttsReadyAction] : []}
					caption={
						selectedTts
							? `Speaks as ${activeVoice || "default voice"}`
							: "Engine not available on this computer"
					}
					currentLabel={selectedTts?.display_name ?? ttsPrefs.engine}
					icon={VolumeHighIcon}
					installed={ttsEngines.map(
						(engine): LayerOption => ({
							name: engine.id,
							label: engine.display_name,
							active: engine.id === ttsPrefs.engine,
							detail: engine.installed
								? `${engine.voices.length} voices`
								: "not installed",
							select: () => pickTtsEngine(engine),
						})
					)}
					label="Audio"
					running={selectedTts?.loaded ?? null}
					trailing={selectedTts?.display_name ?? ttsPrefs.engine}
				>
					{/* The voice is a second dimension of the SAME layer, so it nests
						    inside the engine's submenu instead of claiming a sibling row. */}
					{selectedTts && selectedTts.voices.length > 0 && (
						<NodeLayerMenu
							currentLabel={activeVoice || "Default"}
							installed={selectedTts.voices.map(
								(voice): LayerOption => ({
									name: voice,
									label: voice,
									active: voice === activeVoice,
									select: () => {
										setDesktopTtsPref(DESKTOP_TTS_VOICE_KEY, voice);
										setDesktopTtsEngineOptions(ttsPrefs.engine, { voice });
										return Promise.resolve();
									},
								})
							)}
							label="Voice"
						/>
					)}
				</NodeLayerMenu>
			)}
			{speechProcessingEngines.length > 0 && (
				<NodeLayerMenu
					actions={speechActions}
					available={
						speechInstalled
							? []
							: SPEECH_PROCESSING_ENGINES.map(
									(entry): LayerOption => ({
										name: entry.engine,
										label: entry.label,
										detail: `${entry.model} · 484 MB`,
										select: installSpeechProcessing,
									})
								)
					}
					caption={
						speechInstalled
							? "Optional cleanup after Voice Recognition · off in Dictation settings"
							: "S1-mini model is not installed on this computer"
					}
					currentLabel={
						selectedSpeech?.display_name ?? selectedSpeechMeta.label
					}
					icon={SparklesIcon}
					installed={
						speechInstalled
							? SPEECH_PROCESSING_ENGINES.map(
									(entry): LayerOption => ({
										name: entry.engine,
										label: entry.label,
										active: entry.engine === speechProcessingPrefs.engine,
										detail: selectedSpeech?.model ?? entry.model,
										select: () => pickSpeechProcessing(entry),
									})
								)
							: []
					}
					label="Speech Processing"
					running={speechRunning ? true : null}
					trailing={speechInstalled ? "ready" : "install"}
				>
					{speechInstalled && (
						<>
							<NodeLayerMenu
								currentLabel={speechProcessingPrefs.styling}
								installed={speechStyles.map(
									(value): LayerOption => ({
										name: value,
										label: value,
										active: value === speechProcessingPrefs.styling,
										select: () => updateSpeechProcessing({ styling: value }),
									})
								)}
								label="Style"
							/>
							<NodeLayerMenu
								currentLabel={speechProcessingPrefs.structure}
								installed={speechStructures.map(
									(value): LayerOption => ({
										name: value,
										label: value,
										active: value === speechProcessingPrefs.structure,
										select: () => updateSpeechProcessing({ structure: value }),
									})
								)}
								label="Structure"
							/>
							<NodeLayerMenu
								currentLabel={speechProcessingPrefs.context}
								installed={speechContexts.map(
									(value): LayerOption => ({
										name: value,
										label: value,
										active: value === speechProcessingPrefs.context,
										select: () => updateSpeechProcessing({ context: value }),
									})
								)}
								label="Context"
							/>
						</>
					)}
				</NodeLayerMenu>
			)}
			<NodeLayerMenu
				actions={sttActions}
				caption={
					sttInstalled
						? `Transcribes with ${sttPrefs.model}`
						: "Engine not installed on this computer"
				}
				currentLabel={selectedStt.label}
				icon={Mic01Icon}
				installed={VOICE_ENGINES.map((entry): LayerOption => {
					const item = entry.sidecar ? catalogItem(entry.sidecar) : null;
					let detail = entry.model;
					if (entry.sidecar && details[entry.sidecar]?.running) {
						detail = "running";
					} else if (item && item.installState !== "installed") {
						detail = "not installed";
					}
					return {
						name: entry.engine,
						label: entry.label,
						active: entry.engine === sttPrefs.engine,
						detail,
						select: () => pickStt(entry),
						// Only the engine that is NOT selected is removable — dropping
						// the one transcription is bound to would break voice input.
						uninstall:
							entry.engine === sttPrefs.engine || !item
								? undefined
								: async () => {
										await uninstallSidecar(
											target.url,
											target.token,
											item.name,
											target.userJwt
										);
										await refresh();
									},
					};
				})}
				label="Voice Recognition"
				running={sttRunning}
			/>
			{sandboxBackends && (
				// Which isolated runtime `sandbox_exec` uses by default. wasmtime is
				// the built-in; a per-call `backend` argument still overrides this.
				<NodeLayerMenu
					caption={
						activeBackend?.detected
							? "Default runtime for sandboxed execution"
							: "Runtime not detected on this computer"
					}
					currentLabel={activeBackend?.displayName ?? "None"}
					icon={PackageIcon}
					installed={sandboxBackends.available.map(
						(backend): LayerOption => ({
							name: backend.name,
							label: backend.displayName,
							active: backend.name === sandboxBackends.active,
							detail: backend.detected ? "ready" : "not detected",
							disabled: !backend.supported,
							disabledReason: "unsupported here",
							select: () => pickBackend(backend.name, backend.displayName),
						})
					)}
					label="Sandbox"
					running={activeBackend?.detected ?? null}
				/>
			)}
		</PanelSection>
	);
}

/** The capability layers whose ICON and DISPLAY ORDER this client knows.
 *
 *  A "layer" here is a CAPABILITY (`web.search`, `browser.control`, …) that
 *  several enabled apps can provide at once; picking a row pins the capability to
 *  that app, exactly like swapping Chat pins the resident runtime.
 *
 *  It carries NO label. The layer's name comes from the capability's own
 *  providers now (`ProvidesEntry.title` → Core's `CapabilityInfo.title` →
 *  {@link CapabilityLayerEntry.title}), because a closed label table on the client
 *  can only ever name the layers that shipped with it — everything else fell
 *  through to the raw dotted id, and the dropdown read `document.parse` next to
 *  five English words.
 *
 *  Icon and order stay here because neither is plumbable through a manifest: a
 *  hugeicons `IconSvgElement` is a module import, not a string, and "which layer
 *  comes first" is a property of this menu, not of any one app. A capability with
 *  no row still renders — generic icon, after the known ones — so a third-party
 *  toolkit is never hidden by this list.
 *
 *  `fallbackLabel` is degradation only: it names the layer when Core reports no
 *  title, which today means an older Core that predates the field. Adding a row
 *  here is NOT how a new layer gets named — declare `title` on its providers. */
const CAPABILITY_LAYERS: Array<{
	capability: string;
	fallbackLabel: string;
	icon: IconSvgElement;
}> = [
	{ capability: "web.search", fallbackLabel: "Search", icon: Search01Icon },
	{ capability: "web.extract", fallbackLabel: "Extract", icon: FileSearchIcon },
	{ capability: "web.crawl", fallbackLabel: "Crawl", icon: GlobeIcon },
	{
		capability: "browser.control",
		fallbackLabel: "Browser",
		icon: BrowserIcon,
	},
	{
		capability: "computer.control",
		fallbackLabel: "Device",
		icon: CursorMagicSelection04Icon,
	},
	{ capability: "memory", fallbackLabel: "Memory", icon: BrainIcon },
	// Route-backed, not verb-backed (see `providerDetail`) — it is a layer like any
	// other and gets an icon and a place in the order for the same reasons.
	{
		capability: "document.parse",
		fallbackLabel: "Document Parsing",
		icon: File01Icon,
	},
	{
		capability: "verify.claim",
		fallbackLabel: "Verification",
		icon: CheckmarkBadge02Icon,
	},
];

/** Splits a capability's last segment on the separators an id may use. */
const CAPABILITY_WORD_SPLIT = /[_-]+/;

/** How long a layer label may be before it is clipped. App-supplied text sits in a
 *  `shrink-0` slot in the dropdown row, so an unbounded one stretches the whole
 *  menu; long enough for every real name, short enough that no manifest can. */
const MAX_LAYER_LABEL = 28;

/** Title-cased last segment of a dotted capability id (`acme.pdf_parse` →
 *  `Pdf Parse`).
 *
 *  The bottom rung of the label ladder, and the reason no row can ever show a
 *  machine name: an undeclared capability reads as words rather than as
 *  `acme.pdf_parse`. Deliberately NOT applied server-side — humanising the whole
 *  id there would have printed `News Crud` for an app's private wiring, and the
 *  right answer for those is a title their author chose or none at all. */
function humanizeCapability(capability: string): string {
	const last = capability.split(".").pop() ?? capability;
	const words = last.split(CAPABILITY_WORD_SPLIT).filter(Boolean);
	if (words.length === 0) {
		return capability;
	}
	return words
		.map((word) => word.charAt(0).toUpperCase() + word.slice(1))
		.join(" ");
}

/** The label ladder for one layer: what its providers call it, else what this
 *  client knows it as, else its own id read as words. Clipped because the first
 *  rung is text an app wrote. */
function capabilityLabel(
	entry: CapabilityLayerEntry,
	fallbackLabel?: string
): string {
	const label =
		entry.title ?? fallbackLabel ?? humanizeCapability(entry.capability);
	return label.length > MAX_LAYER_LABEL
		? `${label.slice(0, MAX_LAYER_LABEL - 1)}…`
		: label;
}

interface CapabilityLayerRow {
	entry: CapabilityLayerEntry;
	icon: IconSvgElement;
	label: string;
}

/** Known layers first in table order, then anything else Core reported. */
function orderCapabilityLayers(
	layers: CapabilityLayerEntry[]
): CapabilityLayerRow[] {
	const remaining = new Map(layers.map((layer) => [layer.capability, layer]));
	const rows: CapabilityLayerRow[] = [];
	for (const known of CAPABILITY_LAYERS) {
		const entry = remaining.get(known.capability);
		if (entry) {
			remaining.delete(known.capability);
			rows.push({
				entry,
				icon: known.icon,
				label: capabilityLabel(entry, known.fallbackLabel),
			});
		}
	}
	for (const entry of remaining.values()) {
		rows.push({
			entry,
			icon: Layers01Icon,
			label: capabilityLabel(entry),
		});
	}
	return rows;
}

/**
 * `This device` / `Remote desktop` — which machine a provider acts on.
 *
 * Returned only when the capability's providers actually DISAGREE. Labelling
 * every row when they all drive the same machine is noise that trains the user to
 * ignore the label, which is exactly when it stops working for the one layer
 * (`computer.control`) where the difference is real.
 */
function providerTargetLabel(
	provider: CapabilityProvider,
	siblings: CapabilityProvider[]
): string | null {
	if (!provider.target) {
		return null;
	}
	const distinct = new Set(siblings.map((p) => p.target ?? "unknown"));
	if (distinct.size < 2) {
		return null;
	}
	return provider.target === "local-machine" ? "this device" : "remote desktop";
}

/**
 * `3 verbs` / `default · 3 verbs` — what this provider actually exposes.
 *
 * The verb count is stated only by providers that HAVE verbs. A route-backed
 * provider is served by Core calling its sidecar directly, so it has none by
 * design — `document.parse`'s five parsers all declare zero — and counting them
 * printed "no verbs" on five working backends. An empty detail renders as no detail
 * line at all (`NodeLayerMenu` skips falsy), which is the honest answer when the row
 * has nothing to add beyond its name.
 *
 * No branch for a provider that serves nothing at all: that row is `disabled`, and
 * `NodeLayerMenu` renders `disabledReason` in place of the detail, so anything
 * returned here for it could never appear on screen.
 */
function providerDetail(
	provider: CapabilityProvider,
	siblings: CapabilityProvider[]
): string {
	const parts: string[] = [];
	if (provider.servesVerbs) {
		const count = provider.verbs.length;
		parts.push(`${count} verb${count === 1 ? "" : "s"}`);
	}
	if (provider.isDefault) {
		parts.unshift("default");
	}
	// Leads the detail line: which device this types on outranks how many verbs
	// it exposes when the two candidates are not the same machine.
	const where = providerTargetLabel(provider, siblings);
	if (where) {
		parts.unshift(where);
	}
	return parts.join(" · ");
}

/** "Pinned · 2 providers enabled" — where the current pick came from. */
function layerCaption(entry: CapabilityLayerEntry): string {
	if (!entry.boundProvider) {
		return "No provider bound";
	}
	const count = entry.providers.length;
	const origin = entry.overridden ? "Pinned" : "Auto-picked";
	const base = `${origin} · ${count} provider${count === 1 ? "" : "s"} enabled`;
	// When the candidates drive DIFFERENT machines, the caption is the only thing
	// visible without opening the submenu — and "2 providers enabled" alone reads
	// as "two ways to do the same thing", which is the misreading this exists to
	// prevent. Name what the bound one actually acts on.
	const where = providerTargetLabel(entry.boundProvider, entry.providers);
	return where ? `${base} · ${where}` : base;
}

/** Human label for a tunnel backend. */
const TUNNEL_LABEL = {
	[MESH_BACKEND_CLOUDFLARED]: "Cloudflare Quick Tunnel",
	[MESH_BACKEND_HEADSCALE]: "Headscale",
	[MESH_BACKEND_OPENTUNNEL]: "OpenTunnel",
	[MESH_BACKEND_PLUGIN]: "Plugin tunnel",
	[MESH_BACKEND_TAILSCALE]: "Tailscale",
	[MESH_BACKEND_TAILCAT]: "Tailcat",
} satisfies Record<MeshBackend, string>;

/**
 * The **Tunnel** toolkit: which network backend this node uses, and the
 * enable/disable for the network itself.
 *
 * It sits in the Toolkits block because that is what the user is picking — the
 * thing behind "can my nodes reach each other". The built-in backends read the
 * node's own `mesh-backend` pref; plugin tunnel adapters (apps providing the
 * `network.tunnel` capability) are listed beside them, and picking one pins the
 * capability binding and selects the `plugin` backend. Tailcat is the fresh
 * install default because it needs no account or control server. Tailcat is point-to-point:
 * it exposes this Core through a short-lived address and does not provide peer
 * discovery or a persistent tailnet.
 *
 * Turning it on starts the selected backend. Core downloads the official
 * `tailscale`/`tailscaled` pair for Tailscale/Headscale or the Tailcat CLI for
 * Tailcat when this node has none. `installing` on the enable response is the
 * selected-client signal;
 * {@link watchMeshInstall} waits it out.
 *
 * A backend swap is a SETTING, not a migration: a node already enrolled with
 * Tailscale/Headscale stays enrolled until it re-runs `tailscale up` with an auth
 * key for the new one. Tailcat is restarted with a fresh address, and the toast
 * says as much rather than implying a persistent tailnet move.
 */
function useTunnel(target: ApiTarget) {
	return useQuery({
		queryKey: ["node-tunnel", target.url],
		queryFn: async () => {
			// `/api/mesh/status` answers 200 with `enabled:false` on a mesh-off node
			// and 404s on a Core with no mesh plane — only the 404 hides this row.
			const status = await fetchMeshStatus(target);
			const [backendPref, loginServer] = await Promise.all([
				getPreference(target, MESH_BACKEND_PREF).catch(() => null),
				getPreference(target, MESH_LOGIN_SERVER_PREF).catch(() => null),
			]);
			return {
				status,
				backend: parseMeshBackend(backendPref, loginServer),
				loginServer: loginServer?.trim() ?? "",
			};
		},
		refetchInterval: 15_000,
		retry: false,
	});
}

type TunnelQuery = ReturnType<typeof useTunnel>;

function TunnelLayer({
	target,
	query,
	plugins,
	selectPlugin,
	enablePlugin,
}: {
	enablePlugin: (provider: CapabilityProvider) => Promise<void>;
	plugins: CapabilityLayerEntry | null;
	query: TunnelQuery;
	selectPlugin: (providerId: string) => Promise<void>;
	target: ApiTarget;
}) {
	const openGateway = useGatewayDialog((s) => s.openGateway);

	const status = query.data?.status ?? null;
	const backend = query.data?.backend ?? MESH_BACKEND_TAILCAT;
	const pluginName =
		plugins?.boundProvider?.name ??
		status?.tunnelProvider?.name ??
		TUNNEL_LABEL[MESH_BACKEND_PLUGIN];
	const backendLabel = (value: MeshBackend) =>
		value === MESH_BACKEND_PLUGIN ? pluginName : TUNNEL_LABEL[value];
	const loginServer = query.data?.loginServer ?? "";
	const enabled = status?.enabled ?? false;
	const needsControlServer =
		backend === MESH_BACKEND_HEADSCALE && loginServer === "";

	const toggleMesh = async (next: boolean) => {
		try {
			const result = await setMeshEnabled(target, next);
			await query.refetch();
			if (next && result.installing) {
				await watchMeshInstall(target, backend);
				await query.refetch();
				return;
			}
			if (next && result.startError) {
				sileo.warning({
					title: result.canInstall
						? "Tunnel enabled, but it did not start"
						: backend === MESH_BACKEND_TAILCAT
							? "Tailcat could not be installed automatically"
							: isPublicTunnelBackend(backend)
								? `${backendLabel(backend)} could not start`
								: "Mesh client could not be installed automatically",
					description: result.startError,
				});
				return;
			}
			sileo.success({
				title: next ? "Tunnel on" : "Tunnel off",
				description: next
					? backend === MESH_BACKEND_TAILCAT
						? "This computer now has a short-lived Tailcat address to share."
						: backend === MESH_BACKEND_CLOUDFLARED
							? "A temporary public URL is ready. Protected Core routes still require RYU_TOKEN."
							: isPublicTunnelBackend(backend)
								? "A public URL is being prepared. Protected Core routes still require RYU_TOKEN."
								: "This computer joins the selected private network."
					: "This computer has left the private network.",
			});
		} catch (e) {
			sileo.error({
				title:
					e instanceof Error ? e.message : "Couldn't change the tunnel state",
			});
		}
	};

	const pickBackend = async (next: MeshBackend, restart = false) => {
		if (next === backend && !restart) {
			return;
		}
		let result: Awaited<ReturnType<typeof setMeshBackend>>;
		try {
			result = await setMeshBackend(target, next, enabled);
		} catch (error) {
			sileo.error({
				title:
					error instanceof Error
						? error.message
						: "Couldn't switch the network backend",
			});
			return;
		}
		await query.refetch();
		if (enabled && result.installing) {
			await watchMeshInstall(target, next);
			await query.refetch();
			return;
		}
		if (enabled && result.startError) {
			if (next === MESH_BACKEND_HEADSCALE && loginServer === "") {
				sileo.warning({
					title: "Tunnel set to Headscale",
					description: "Add your control server URL to finish setting it up.",
					button: {
						title: "Add URL",
						onClick: () => openGateway("network"),
					},
				});
			} else {
				sileo.warning({
					title: `${backendLabel(next)} selected, but it did not start`,
					description: result.startError,
				});
			}
			return;
		}
		if (next === MESH_BACKEND_HEADSCALE && loginServer === "") {
			// Core REFUSES to enrol against Headscale with no control server rather
			// than silently falling back to Tailscale's SaaS, so say so here instead
			// of letting the node fail at start with the same sentence.
			sileo.warning({
				title: "Tunnel set to Headscale",
				description: "Add your control server URL to finish setting it up.",
				button: {
					title: "Add URL",
					onClick: () => openGateway("network"),
				},
			});
			return;
		}
		sileo.success({
			title: `Network → ${backendLabel(next)}`,
			description: enabled
				? next === MESH_BACKEND_TAILCAT
					? "The listener was restarted with a new short-lived address."
					: next === MESH_BACKEND_CLOUDFLARED
						? "A temporary public URL is active. Anyone with the URL can reach Core's public routes."
						: isPublicTunnelBackend(next)
							? "A public URL is being prepared. Anyone with the URL can reach Core's public routes."
							: "The selected network backend was restarted. An already-enrolled Tailscale or Headscale computer keeps its current tailnet until it re-enrols with a new auth key."
				: undefined,
		});
	};

	// A plugin tunnel row pins the `network.tunnel` binding, then selects the
	// `plugin` backend. Re-posting the backend while it is already on makes Core
	// stop the previously started provider and start the newly bound one.
	const pickPlugin = async (provider: CapabilityProvider) => {
		const alreadyActive =
			backend === MESH_BACKEND_PLUGIN && plugins?.bound === provider.id;
		if (alreadyActive) {
			return;
		}
		try {
			if (plugins?.bound !== provider.id) {
				await selectPlugin(provider.id);
			}
		} catch (error) {
			sileo.error({ title: describeBindingFailure(error, provider.name) });
			return;
		}
		await pickBackend(MESH_BACKEND_PLUGIN, backend === MESH_BACKEND_PLUGIN);
	};

	// Enabling a disabled tunnel app from this menu is a selection, not just a
	// lifecycle change: pin it and switch the VPN layer to it in the same click.
	const enableAndPickPlugin = async (provider: CapabilityProvider) => {
		try {
			await enablePlugin(provider);
			await selectPlugin(provider.id);
		} catch (error) {
			sileo.error({ title: describeBindingFailure(error, provider.name) });
			return;
		}
		await pickBackend(MESH_BACKEND_PLUGIN, backend === MESH_BACKEND_PLUGIN);
	};

	// No mesh plane on this Core (an older binary) — no row, rather than a fake one.
	if (status === null) {
		return null;
	}

	const actions: LayerAction[] = [
		{
			id: enabled ? "disable" : "enable",
			label: enabled
				? "Turn off"
				: isPublicTunnelBackend(backend)
					? "Start public tunnel"
					: "Turn on",
			busyLabel: enabled
				? "Turning off…"
				: isPublicTunnelBackend(backend)
					? "Starting public tunnel…"
					: "Connecting…",
			// No download icon on "Turn on": most nodes already have the client, and
			// promising a download on a machine that just starts a daemon is the kind
			// of small lie that makes a UI untrustworthy.
			run: () => toggleMesh(!enabled),
			tone: enabled ? "destructive" : "default",
		},
	];
	if (needsControlServer) {
		actions.push({
			id: "control-server",
			label: "Set control server URL…",
			icon: Settings01Icon,
			run: () => openGateway("network"),
		});
	}
	const publicUrl = status.publicUrl;
	if (isPublicTunnelBackend(backend) && publicUrl) {
		actions.push({
			id: "copy-public-url",
			label: "Copy public URL",
			run: async () => {
				try {
					await navigator.clipboard.writeText(publicUrl);
					sileo.success({ title: "Public URL copied" });
				} catch {
					sileo.error({ title: "Couldn't copy the public URL" });
				}
			},
		});
	}

	const caption = (() => {
		if (needsControlServer) {
			return "Needs a control server URL";
		}
		if (!enabled) {
			if (backend === MESH_BACKEND_CLOUDFLARED) {
				return "Off · public temporary URL";
			}
			if (backend === MESH_BACKEND_OPENTUNNEL) {
				return "Off · public stable URL";
			}
			if (backend === MESH_BACKEND_PLUGIN) {
				return `Off · ${pluginName}`;
			}
			if (backend === MESH_BACKEND_HEADSCALE) {
				return `Off · ${loginServer}`;
			}
			return backend === MESH_BACKEND_TAILCAT
				? "Off · Tailcat"
				: "Off · Tailscale SaaS";
		}
		if (status.backendError && !status.reachable) {
			return status.backendError;
		}
		if (status.reachable) {
			if (backend === MESH_BACKEND_CLOUDFLARED) {
				return status.cloudflaredUrl
					? "Cloudflare URL ready"
					: "Cloudflare connected";
			}
			if (
				backend === MESH_BACKEND_OPENTUNNEL ||
				backend === MESH_BACKEND_PLUGIN
			) {
				return status.publicUrl ? "Public URL ready" : "Connected";
			}
			if (backend === MESH_BACKEND_TAILCAT) {
				return status.tailcatAddress
					? "Tailcat address ready"
					: "Tailcat connected";
			}
			return status.magicDnsName
				? `Connected as ${status.magicDnsName}`
				: "Connected";
		}
		if (status.backendState === "Provisioning") {
			// First OpenTunnel start waits on certificate issuance (minutes).
			return "Creating tunnel certificate…";
		}
		return "Connecting…";
	})();

	const pluginRows = (plugins?.providers ?? []).map(
		(provider): LayerOption => ({
			name: `plugin:${provider.id}`,
			label: provider.name,
			active: backend === MESH_BACKEND_PLUGIN && plugins?.bound === provider.id,
			detail: "plugin · public URL",
			select: () => pickPlugin(provider),
		})
	);
	const availablePlugins = (plugins?.available ?? []).map(
		(provider): LayerOption => ({
			name: `plugin:${provider.id}`,
			label: provider.name,
			active: false,
			detail: "plugin · not enabled",
			select: () => enableAndPickPlugin(provider),
		})
	);

	return (
		<NodeLayerMenu
			actions={actions}
			available={availablePlugins}
			caption={caption}
			currentLabel={backendLabel(backend)}
			icon={WifiConnected01Icon}
			installed={[
				{
					name: MESH_BACKEND_CLOUDFLARED,
					label: TUNNEL_LABEL[MESH_BACKEND_CLOUDFLARED],
					active: backend === MESH_BACKEND_CLOUDFLARED,
					detail: "public · temporary · anyone with URL",
					select: () => pickBackend(MESH_BACKEND_CLOUDFLARED),
				},
				{
					name: MESH_BACKEND_OPENTUNNEL,
					label: TUNNEL_LABEL[MESH_BACKEND_OPENTUNNEL],
					active: backend === MESH_BACKEND_OPENTUNNEL,
					detail: "public · stable URL · macOS & Linux",
					select: () => pickBackend(MESH_BACKEND_OPENTUNNEL),
				},
				{
					name: MESH_BACKEND_HEADSCALE,
					label: TUNNEL_LABEL[MESH_BACKEND_HEADSCALE],
					active: backend === MESH_BACKEND_HEADSCALE,
					// Honest about the one thing that stops it working. The row stays
					// SELECTABLE — picking it is how a user gets the prompt for the URL.
					detail: loginServer === "" ? "needs control server" : "self-hosted",
					select: () => pickBackend(MESH_BACKEND_HEADSCALE),
				},
				{
					name: MESH_BACKEND_TAILSCALE,
					label: TUNNEL_LABEL[MESH_BACKEND_TAILSCALE],
					active: backend === MESH_BACKEND_TAILSCALE,
					detail: "hosted",
					select: () => pickBackend(MESH_BACKEND_TAILSCALE),
				},
				{
					name: MESH_BACKEND_TAILCAT,
					label: TUNNEL_LABEL[MESH_BACKEND_TAILCAT],
					active: backend === MESH_BACKEND_TAILCAT,
					detail: "point-to-point",
					select: () => pickBackend(MESH_BACKEND_TAILCAT),
				},
				...pluginRows,
			]}
			label="VPN"
			// The mesh is a real process, so the dot means connected — not "a backend
			// is selected". A selected-but-off tunnel is honestly down.
			running={enabled ? status.reachable : false}
			selectionMode="swap"
		/>
	);
}

/**
 * The "Toolkits" block in the node dropdown: every SELECTABLE capability on the
 * node. Named "Toolkits" in the UI because that is what a user is picking - the
 * set of tools behind web search or browsing - while "layer"/"capability" stays
 * the internal vocabulary in Core and the manifests.
 *
 * node with the app currently serving it, and a swap to any other enabled
 * provider. This is the client face of Core's binding ladder
 * (override > sole provider > declared default > lowest id).
 *
 * Deliberately unlike the Engines block:
 *   - no `available` list — the read model already reports only ENABLED apps,
 *     and installing a provider is the Store's job, not the dropdown's;
 *   - no `running` dot — a binding is a preference with no process behind it,
 *     and a grey dot on something that cannot run reads as broken;
 *   - non-selectable capabilities are absent entirely (the hook drops them):
 *     Core will not auto-pick between them, so a picker would be a lie.
 */
function LayersSection({
	target,
	enabled,
}: {
	enabled: boolean;
	target: ApiTarget;
}) {
	const {
		layers,
		refresh,
		select,
		tunnel: tunnelPlugins,
	} = useCapabilityLayers(target, enabled);
	const rows = orderCapabilityLayers(layers);
	// Hoisted out of `TunnelLayer` so the block knows whether it has ANY row
	// before drawing its header — a Core with no mesh plane and no capability
	// providers must render nothing, not a "Toolkits" heading over emptiness.
	const tunnel = useTunnel(target);

	// Enabling a candidate for a toolkit that currently has none. Distinct from
	// `pick`: there is nothing to swap TO yet, so the action is a lifecycle change
	// on the plugin, after which Core's ladder binds it automatically (sole
	// provider, or the declared default).
	const enableProvider = async (
		provider: CapabilityProvider,
		label: string
	) => {
		try {
			await enableApp(target, provider.id);
			await refresh();
			sileo.success({ title: `${label} → ${provider.name}` });
		} catch (e) {
			sileo.error({
				title:
					e instanceof Error ? e.message : `Couldn't enable ${provider.name}`,
			});
		}
	};

	const pick = async (
		entry: CapabilityLayerEntry,
		provider: CapabilityProvider,
		label: string
	) => {
		// Re-clicking the row that is ALREADY serving the capability is a no-op, the
		// same way re-picking Chat is. Writing here would turn
		// Core's auto-pick into an explicit pin with no visible change and no way
		// back — the dropdown has no "Auto" row to undo it with.
		if (provider.id === entry.bound) {
			return;
		}
		try {
			await select(entry.capability, provider.id);
			sileo.success({ title: `${label} → ${provider.name}` });
		} catch (e) {
			// Core's 409 names the plugin that would break and the binding_error
			// code; surface both rather than a bare "request failed".
			sileo.error({ title: describeBindingFailure(e, provider.name) });
		}
	};

	// The Tunnel keeps the block alive on its own: it is a NODE capability, not a
	// plugin contribution, so it is there on an install with no capability
	// providers at all. Only a Core without the mesh plane (404 → no tunnel data)
	// AND no capabilities collapses the block entirely.
	const hasTunnel = tunnel.data?.status != null;
	if (!enabled || (rows.length === 0 && !hasTunnel)) {
		return null;
	}

	return (
		<PanelSection>
			<TunnelLayer
				enablePlugin={async (provider) => {
					await enableApp(target, provider.id);
				}}
				plugins={tunnelPlugins}
				query={tunnel}
				selectPlugin={(providerId) => select(TUNNEL_CAPABILITY, providerId)}
				target={target}
			/>
			{rows.map(({ entry, icon, label }) => (
				<NodeLayerMenu
					// Candidates that exist but are not enabled. Load-bearing for
					// `web.search`, whose five providers all ship opt-in: without this
					// the toolkit rendered as "No provider bound" with an empty menu and
					// no hint that anything could serve it.
					available={entry.available.map(
						(provider): LayerOption => ({
							name: provider.id,
							label: provider.name,
							active: false,
							detail: provider.isDefault
								? "default · not enabled"
								: "not enabled",
							select: () => enableProvider(provider, label),
						})
					)}
					caption={layerCaption(entry)}
					currentLabel={entry.boundProvider?.name ?? "None"}
					icon={icon}
					installed={entry.providers.map(
						(provider): LayerOption => ({
							name: provider.id,
							label: provider.name,
							active: provider.id === entry.bound,
							detail: providerDetail(provider, entry.providers),
							// A provider that serves NOTHING is shown but NOT selectable.
							// Selecting one resolves the capability to it and then finds
							// nothing to serve, so every tool in the layer disappears —
							// silently, with no error anywhere. Better to say why it
							// cannot be picked than to let the layer go dark.
							//
							// "Serves nothing" is `canServe`, not `!servesVerbs`: verbs are
							// one of two serving surfaces, and gating on them alone marked
							// every route-backed provider dead. `document.parse` is served
							// entirely by route, so all five of its parsers — including the
							// bound default — rendered disabled with "serves no verbs yet"
							// while parsing worked fine, and the layer could not be swapped
							// from here at all.
							disabled: !canServe(provider),
							// Not "serves no verbs yet": verbs are one of two ways to
							// serve, so naming only that one sent a reader looking for a
							// missing verb table on a provider whose real problem is that
							// it declares no serving surface of either kind.
							disabledReason: canServe(provider)
								? null
								: "declares no verbs or route",
							select: () => pick(entry, provider, label),
						})
					)}
					key={entry.capability}
					label={label}
					selectionMode="swap"
					// No version badge. The only version available here is the
					// CAPABILITY CONTRACT version from `provides[].version`, which every
					// manifest in the repo declares as "1.0.0" — so every row would badge
					// an identical, information-free "v1.0.0" in the same slot where the
					// engine rows above show a real build. The provider app's own version
					// would be meaningful, but the read model does not carry it.
					version={null}
				>
					{entry.capability === "web.search" ? (
						<WebSearchAccessMenu enabled={enabled} target={target} />
					) : null}
				</NodeLayerMenu>
			))}
		</PanelSection>
	);
}

/** Typed-decision providers share the binding contract but stay out of Toolkits. */
function DecisionModelsSection({
	target,
	enabled,
}: {
	enabled: boolean;
	target: ApiTarget;
}) {
	const { decisionModels, refresh, select } = useCapabilityLayers(
		target,
		enabled
	);
	if (!enabled || decisionModels.length === 0) {
		return null;
	}

	const enableProvider = async (
		entry: CapabilityLayerEntry,
		provider: CapabilityProvider,
		label: string
	) => {
		try {
			await enableApp(target, provider.id);
			try {
				// Enabling an available provider is an explicit selection, including
				// when Core had no unique provider bound before this choice.
				await select(entry.capability, provider.id);
			} finally {
				await refresh();
			}
			sileo.success({ title: `${label} → ${provider.name}` });
		} catch (error) {
			sileo.error({
				title:
					error instanceof Error
						? error.message
						: `Couldn't enable ${provider.name}`,
			});
		}
	};

	const pickProvider = async (
		entry: CapabilityLayerEntry,
		provider: CapabilityProvider,
		label: string
	) => {
		if (provider.id === entry.bound) {
			return;
		}
		try {
			await select(entry.capability, provider.id);
			sileo.success({ title: `${label} → ${provider.name}` });
		} catch (error) {
			sileo.error({ title: describeBindingFailure(error, provider.name) });
		}
	};

	return (
		<PanelSection title="Decision Models">
			{decisionModels.map((entry) => {
				const label = capabilityLabel(entry, "Typed Decisions");
				return (
					<NodeLayerMenu
						available={entry.available.map(
							(provider): LayerOption => ({
								name: provider.id,
								label: provider.name,
								active: false,
								detail: provider.isDefault
									? "default · not enabled"
									: "not enabled",
								select: () => enableProvider(entry, provider, label),
							})
						)}
						caption={layerCaption(entry)}
						currentLabel={entry.boundProvider?.name ?? "None"}
						icon={BrainIcon}
						installed={entry.providers.map(
							(provider): LayerOption => ({
								name: provider.id,
								label: provider.name,
								active: provider.id === entry.bound,
								detail: providerDetail(provider, entry.providers),
								disabled: !canServe(provider),
								disabledReason: canServe(provider)
									? null
									: "declares no verbs or route",
								select: () => pickProvider(entry, provider, label),
							})
						)}
						key={entry.capability}
						label={label}
						selectionMode="swap"
						version={null}
					/>
				);
			})}
		</PanelSection>
	);
}

/** A reachable Core found by the sweep (mirrors the Rust DiscoveredNode). */
interface DiscoveredNode {
	latency_ms: number;
	/** Which profile answered, derived from the PORT it was found on. Discovery
	 *  now sweeps every profile's port, so one host can legitimately return
	 *  several nodes and they must be distinguishable. */
	profile?: string;
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
				<span
					className="flex-1 truncate text-left text-muted-foreground"
					title={label}
				>
					{label}
				</span>
				<span className="type-compact shrink-0 text-status-warning">
					needs token
				</span>
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
			<span
				className="flex-1 truncate text-left text-muted-foreground"
				title={label}
			>
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
	const networkLabel =
		status.backend === MESH_BACKEND_OPENTUNNEL ||
		status.backend === MESH_BACKEND_PLUGIN
			? status.publicUrl
				? "Public URL ready"
				: (status.backendError ?? "Tunnel starting…")
			: status.backend === MESH_BACKEND_CLOUDFLARED
				? status.cloudflaredUrl
					? "Cloudflare URL ready"
					: reachable
						? "Cloudflare connected"
						: "Cloudflare starting…"
				: status.backend === MESH_BACKEND_TAILCAT
					? status.tailcatAddress
						? "Tailcat address ready"
						: reachable
							? "Tailcat connected"
							: "Tailcat starting…"
					: (status.magicDnsName ?? (reachable ? "Connected" : "Connecting…"));
	return (
		<div className="px-1 py-0.5">
			<p className="type-compact px-2 pt-0.5 pb-1 font-medium text-muted-foreground/50">
				Network
			</p>
			<div className="flex items-center gap-2 px-2 py-1 text-xs">
				<span
					aria-hidden
					className={cn("size-1.5 shrink-0 rounded-full", dotColor)}
				/>
				<span
					className="flex-1 truncate text-muted-foreground"
					title={networkLabel}
				>
					{networkLabel}
				</span>
				{status.backend && (
					<span className="type-compact shrink-0 text-muted-foreground/60">
						{status.backend}
					</span>
				)}
			</div>
			{status.publicUrl && (
				<p className="type-compact truncate px-2 pb-0.5 text-muted-foreground/60">
					<a
						className="underline-offset-2 hover:underline"
						href={status.publicUrl}
						rel="noopener noreferrer"
						target="_blank"
						title={status.publicUrl}
					>
						{status.publicUrl}
					</a>
				</p>
			)}
			{ingress?.up && ingress.kind && (
				// Through `ingressLabel`, not raw: Core serializes this as
				// `IngressKind::as_str()`, which is kebab-case (`own-relay`,
				// `tailscale-funnel`), and rendering that verbatim showed the wire
				// value in the UI. The same helper backs the Integrations tab picker,
				// so the two surfaces name a backend identically.
				<p className="type-compact px-2 pb-0.5 text-muted-foreground/60">
					Ingress: {ingressLabel(ingress.kind)}
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
				<p className="type-compact px-2 pt-0.5 pb-0.5 text-muted-foreground/60">
					{peers?.note ??
						"Peer needs an enrollment token — provision the same RYU_TOKEN on both computers, or add the peer's own token by hand."}
				</p>
			)}
		</div>
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
		<div className="px-1 py-0.5">
			<p className="type-compact px-2 pt-0.5 pb-1 font-medium text-muted-foreground/50">
				Connected · {clients.length}
			</p>
			{clients.map((c) => {
				const surface = connectionSurfaceMeta(c.surface);
				const displayName = connectionDisplayName(c);
				return (
					<div
						className="flex items-center gap-2 px-2 py-1 text-xs"
						key={c.clientId}
					>
						<span
							aria-hidden
							className="size-1.5 shrink-0 rounded-full bg-success"
						/>
						<HugeiconsIcon
							aria-hidden
							className="size-3.5 shrink-0 text-muted-foreground"
							icon={surface.icon}
						/>
						<AutoScrollText
							className="flex-1 text-muted-foreground"
							title={`${displayName}${c.clientId === selfClientId ? " (you)" : ""}`}
						>
							{displayName}
							{c.clientId === selfClientId && (
								<span className="text-muted-foreground/50"> (you)</span>
							)}
						</AutoScrollText>
						<span className="type-compact shrink-0 text-muted-foreground/60">
							{surface.label}
						</span>
						<span className="type-compact shrink-0 text-muted-foreground/50 tabular-nums">
							{relativeAge(c.lastSeen)}
						</span>
					</div>
				);
			})}
		</div>
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
function formatCreditResetDate(
	value: string | null | undefined
): string | null {
	if (!value) {
		return null;
	}
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) {
		return null;
	}
	return new Intl.DateTimeFormat(undefined, {
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
		month: "short",
	}).format(date);
}

function ManagedNodeWallet({ node }: { node: Node | undefined }) {
	const openSettings = useSettingsDialog((s) => s.openSettings);
	const { activeOrgId, billing, organization } = useOrgBillingStatus();
	const { authed, wallet, entitlement, loading } = useCreditsWallet();

	// The warning belongs to the node the user is actually using. A different
	// configured cloud node must not make a local sidebar look billable.
	if (
		!(node?.managed && authed && entitlement?.managedInference) ||
		(node?.orgId && activeOrgId && node.orgId !== activeOrgId)
	) {
		return null;
	}

	const currency = wallet?.currency ?? "usd";
	const balanceLabel =
		wallet && !loading ? formatMicroUsd(wallet.balanceMicroUsd, currency) : "—";
	const status =
		wallet && !loading
			? creditBalanceStatus({
					balanceMicroUsd: wallet.balanceMicroUsd,
					monthlyCreditPoolMicroUsd: entitlement.monthlyCreditPoolMicroUsd,
				})
			: null;
	const warning = status?.kind === "low" || status?.kind === "empty";
	const resetDate = formatCreditResetDate(
		billing?.subscription?.currentPeriodEnd
	);
	const organizationLabel = organization?.name ?? "Organization wallet";
	const warningLabel =
		status?.kind === "empty"
			? "Credits empty"
			: status?.kind === "low"
				? `${status.remainingPercent}% credits remaining`
				: "Cloud credits";
	const openCredits = () => openSettings("credits");

	const cssVariables2: LayoutCssVariables = {
		"--desktop-inline2-width": `${status?.remainingPercent ?? 0}%`,
	};
	return (
		<div
			className={cn(
				"mt-1 rounded-xl text-xs",
				warning
					? "border border-warning/30 bg-warning/10 text-status-warning dark:text-status-warning"
					: "text-muted-foreground"
			)}
			data-credit-state={status?.kind ?? "loading"}
			data-testid="managed-node-wallet"
		>
			<button
				className="flex w-full items-center gap-2 rounded-xl px-2 py-1.5 text-left hover:bg-accent/50 hover:text-foreground"
				onClick={openCredits}
				type="button"
			>
				<HugeiconsIcon
					className="shrink-0"
					icon={warning ? Alert02Icon : DollarCircleIcon}
					size={13}
				/>
				<span className="flex min-w-0 flex-1 flex-col">
					<span className="truncate" title={warningLabel}>
						{warningLabel}
					</span>
					<span
						className="type-compact truncate text-muted-foreground/70"
						title={organizationLabel}
					>
						{organizationLabel}
					</span>
				</span>
				<span className="shrink-0 font-heading font-medium tabular-nums">
					{balanceLabel}
				</span>
			</button>
			{warning && status ? (
				<div className="space-y-2 px-2 pb-2">
					<div
						aria-label="Credits remaining"
						aria-valuemax={100}
						aria-valuemin={0}
						aria-valuenow={status.remainingPercent}
						className="h-1.5 overflow-hidden rounded-full bg-warning/20"
						role="progressbar"
					>
						<div
							className={cn(
								cn("h-full rounded-full bg-warning", layoutStyles.authored1),
								layoutStyles.inline2
							)}
							style={cssVariables2}
						/>
					</div>
					<div className="type-compact flex items-center justify-between gap-2">
						<span className="truncate text-muted-foreground/80">
							{resetDate ? `Resets ${resetDate}` : "Shared organization wallet"}
						</span>
						<button
							className="shrink-0 rounded-md bg-background/70 px-2 py-1 font-medium text-foreground hover:bg-background"
							onClick={openCredits}
							type="button"
						>
							Add credits
						</button>
					</div>
				</div>
			) : null}
		</div>
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
			sileo.error({ title: "Couldn't add cloud computer" });
		} finally {
			setAddingUrl(null);
		}
	};

	return (
		<div className={cn("space-y-0.5", compact ? "px-1 py-0.5" : "mt-1")}>
			<p className="type-compact px-2 pt-0.5 pb-1 font-medium text-muted-foreground/50">
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
							className="type-caption shrink-0 rounded-md px-1.5 py-0.5 font-medium text-primary hover:bg-primary/10 disabled:opacity-50"
							disabled={busy}
							onClick={() => handleAdd(node)}
							type="button"
						>
							{busy ? "Adding…" : "Add"}
						</button>
						<button
							aria-label={`Dismiss ${cloudLabel(node.name)}`}
							className="relative shrink-0 rounded-md p-0.5 text-muted-foreground/60 after:absolute after:-inset-1 hover:bg-muted hover:text-foreground disabled:opacity-50"
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
const AUTO_SELECT_POLICY =
	"Prefer a reachable remote computer, else use your computer";

/**
 * Subline under the auto-select switch: what the setting is actually DOING right
 * now, never a promise the store does not keep. `picked` is the node the probe
 * landed on (already resolved from `autoSelectedNode`), or null before it has run.
 */
function autoSelectSubline(autoSelect: boolean, picked: Node | null): string {
	if (!autoSelect) {
		return "Always use your default computer";
	}
	if (!picked) {
		return AUTO_SELECT_POLICY;
	}
	// Branch on the URL, not the name: a remote node someone named "local" must not
	// be reported as local compute.
	if (isLocalNode(picked)) {
		return "No remote computer reachable — using your computer";
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
function AutoSelectRow({
	compact = false,
	variant = "menu",
}: {
	compact?: boolean;
	/** `settings`: the computer dialog's App Settings switch row + caption. */
	variant?: "menu" | "settings";
}) {
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

	if (variant === "settings") {
		return (
			<SettingsGroup>
				<SettingsItem
					actions={
						<Switch
							aria-label={AUTO_SELECT_POLICY}
							checked={autoSelect}
							onCheckedChange={setAutoSelect}
						/>
					}
					description={autoSelectSubline(autoSelect, picked)}
					title="Auto-select computer"
				/>
			</SettingsGroup>
		);
	}

	return (
		<div className={cn(compact ? "px-1 py-0.5" : "mt-1")}>
			<div className="flex items-center gap-2 rounded-lg px-2 py-1.5">
				<div className="min-w-0 flex-1">
					<p className="truncate font-medium text-xs">Auto-select computer</p>
					<p
						className="type-compact truncate text-muted-foreground"
						title={autoSelectSubline(autoSelect, picked)}
					>
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

function NodeMenuHardware({
	target,
	enabled,
}: {
	target: ApiTarget;
	enabled: boolean;
}) {
	const { data: info } = useNodeSystemInfo(target, enabled);
	return info ? (
		<div className="px-3 pt-1 pb-1.5">
			<NodeStats info={info} />
		</div>
	) : null;
}

function NodeMenuGateway({
	coreReachable,
	target,
	...props
}: Omit<ComponentProps<typeof ServiceRow>, "label" | "target"> & {
	coreReachable: boolean;
	target: ApiTarget;
}) {
	const { data } = useQuery({
		queryKey: [
			"node-gateway-status",
			target.url,
			target.token ?? null,
			target.userJwt ?? null,
		],
		queryFn: ({ signal }) => fetchGatewayStatus(target, signal),
		enabled: coreReachable,
		refetchInterval: 30_000,
		retry: false,
	});
	const count = data?.health?.providers.length ?? 0;
	const label =
		props.running && count > 0
			? `Gateway · ${count} provider${count === 1 ? "" : "s"}`
			: "Gateway";
	return <ServiceRow {...props} label={label} target={target} />;
}

/** How long Core may miss status polls before the dialog's Core-backed pages
 *  treat it as gone. Covers a couple of polls of a reconnect blip. */
const CORE_BLIP_GRACE_MS = 12_000;

/**
 * `reachable`, but a drop only counts once it has lasted
 * {@link CORE_BLIP_GRACE_MS}. Recovery counts at once, and a new `key` (another
 * computer) starts from its own reading instead of inheriting the last one's.
 */
function useSteadyReachable(reachable: boolean, key: string): boolean {
	const [steady, setSteady] = useState({ key, reachable });
	if (steady.key !== key) {
		setSteady({ key, reachable });
	}
	useEffect(() => {
		if (reachable) {
			setSteady({ key, reachable: true });
			return;
		}
		const timer = setTimeout(
			() => setSteady({ key, reachable: false }),
			CORE_BLIP_GRACE_MS
		);
		return () => clearTimeout(timer);
	}, [reachable, key]);
	return reachable || (steady.key === key && steady.reachable);
}

const TONE_LABEL = {
	green: "Online",
	amber: "Online · some services need attention",
	red: "Unreachable",
	pending: "Checking…",
} satisfies Record<Tone, string>;

export function NodeSelector({ mode }: NodeSelectorProps) {
	const { nodes, defaultNode, setDefault, removeNode, addNode } =
		useNodeStore();
	const simpleInterface = useInterfaceLevel() === "simple";
	const [addOpen, setAddOpen] = useState(false);
	// The Gateway dialog is backed by a global store so other surfaces (command
	// palette, deep links, the Settings page) can open it at a chosen section.
	const gatewayOpen = useGatewayDialog((s) => s.open);
	const gatewaySection = useGatewayDialog((s) => s.section);
	const setGatewayOpen = useGatewayDialog((s) => s.setOpen);
	const openGateway = useGatewayDialog((s) => s.openGateway);
	const [shareNode, setShareNode] = useState<Node | null>(null);
	const [hardwareNode, setHardwareNode] = useState<Node | null>(null);
	const [settingsOpen, setSettingsOpen] = useState(false);
	const [showDetail] = useNodeSelectorDetail();
	// Panel actions can open the Gateway or App Settings dialog (a toolkit's
	// "Set control server URL…", the wallet's credits link). Hand the screen over
	// instead of stacking a second modal on top of the computer dialog.
	const appSettingsOpen = useSettingsDialog((s) => s.open);
	useEffect(() => {
		if (gatewayOpen || appSettingsOpen) {
			setSettingsOpen(false);
		}
	}, [gatewayOpen, appSettingsOpen]);
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
		userJwt: activeNode?.userJwt ?? null,
	};

	// Island is a device-local Electron companion the shell installs + launches
	// (Core can't — it's not a Core sidecar). The Island row surfaces this only when
	// the local island isn't reachable; the status dot goes green on the next probe.
	// The row itself is behind the ISLAND_ENABLED release gate.
	const handleIslandLaunch = async () => {
		await installAndLaunchIsland();
	};

	// Installed version + update verdict for Core/Gateway (single release train):
	// drives the version badge on both rows and the shared app-wide "Update"
	// action. Core owns the verdict; install is the native tauri updater.
	const {
		version: appVersion,
		updateAvailable: appUpdateAvailable,
		update: handleAppUpdate,
	} = useNodeVersion(target, coreReachable === true);

	// Connected-client presence (the "who's on this computer" view). Soft dependency:
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

	// Service health in one line, for the dropdown's Services row and the
	// dialog's Services link: the dot already says "something is off", this says
	// WHAT.
	const services: Array<{ label: string; up: boolean | null }> = [
		{ label: "Core", up: coreReachable },
		{ label: "Gateway", up: gatewayReachable },
		{ label: "Shadow", up: shadowReachable },
	];
	if (ISLAND_ENABLED && islandReachable !== null) {
		services.push({ label: "Island", up: islandReachable });
	}
	// Mesh feeds the same amber tone as the services, so the line must name it
	// too — otherwise an amber dot sits next to "All running".
	if (meshStatus !== null) {
		services.push({ label: "Network", up: meshReachable });
	}
	const stoppedServices = services.filter((svc) => svc.up === false);
	let servicesSummary = "All running";
	if (loading) {
		servicesSummary = "Checking…";
	} else if (stoppedServices.length > 0) {
		servicesSummary = `${stoppedServices.map((svc) => svc.label).join(", ")} stopped`;
	}

	const openSettings = () => setSettingsOpen(true);

	const serviceRows = (
		<>
			<ServiceRow
				icon={ServerStack01Icon}
				label="Core"
				onChanged={refresh}
				onUpdate={handleAppUpdate}
				running={coreReachable}
				sidecarKey="core"
				target={target}
				updateAvailable={appUpdateAvailable}
				version={appVersion}
			/>
			<NodeMenuGateway
				coreReachable={coreReachable === true}
				icon={Router01Icon}
				onChanged={refresh}
				onUpdate={handleAppUpdate}
				running={gatewayReachable}
				sidecarKey="gateway"
				target={target}
				updateAvailable={appUpdateAvailable}
				version={appVersion}
			/>
			{/* Shadow is preinstalled and managed by Core's normal sidecar lifecycle. */}
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
			    is null = not relevant for another machine) and while the
			    ISLAND_ENABLED release gate is off. */}
			{ISLAND_ENABLED && islandReachable !== null && (
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
		</>
	);

	// Engines, voice and toolkits are all read from Core; with Core down their
	// pages would open blank, so the rows say why instead of opening. They read
	// the STEADY reachability: one missed status poll must not unmount the
	// sections and throw the user off the layer page they are on.
	const coreSteady = useSteadyReachable(coreReachable === true, target.url);
	let coreUnavailable: string | null = null;
	if (loading) {
		coreUnavailable = "Checking…";
	} else if (!coreSteady) {
		coreUnavailable = "Unavailable — Core isn't reachable";
	}

	// Steady like the rows above: a failed status poll nulls `meshStatus`, and an
	// unmounted row would send a user mid-task on this page back to the root.
	const hasNetwork = useSteadyReachable(
		meshStatus !== null || (connections?.clients.length ?? 0) > 0,
		target.url
	);

	// The expanded node selector: an iOS-Settings-style page stack. The root lists
	// computers and one row per area; every area — and every layer inside it —
	// pushes its own page instead of nesting a submenu in a 380px popover.
	const settingsRoot = (
		<>
			<SettingsCard>
				<div className="flex items-center gap-3">
					<span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-foreground/5">
						<NodeStatusIcon
							borderClassName="border-muted"
							icon={
								isLocalNode(activeNode ?? LOCAL_FALLBACK)
									? LaptopIcon
									: Link01Icon
							}
							tone={tone}
						/>
					</span>
					<div className="min-w-0 flex-1">
						<p
							className="truncate font-medium text-sm"
							title={computerName(activeNode ?? LOCAL_FALLBACK)}
						>
							{computerName(activeNode ?? LOCAL_FALLBACK)}
						</p>
						<p className="type-caption truncate text-muted-foreground">
							{TONE_LABEL[tone]}
							{activeNode && !isLocalNode(activeNode)
								? ` · ${activeNode.managed ? "Cloud Computers" : activeNode.url}`
								: ""}
						</p>
					</div>
				</div>
				<NodeMenuHardware enabled={coreReachable === true} target={target} />
			</SettingsCard>
			<PanelSection title="This computer">
				<PanelPageLink
					icon={ServerStack01Icon}
					label="Services"
					tint="green"
					trailing={
						<>
							<span
								aria-hidden
								className={cn("size-1.5 shrink-0 rounded-full", TONE_DOT[tone])}
							/>
							<span className="truncate">{servicesSummary}</span>
						</>
					}
				>
					<PanelSection footer="Core runs Ryu on this computer; Gateway routes model and tool calls.">
						{serviceRows}
					</PanelSection>
				</PanelPageLink>
				<PanelPageLink
					disabled={coreUnavailable !== null}
					icon={LayerIcon}
					label="Engines & models"
					tint="purple"
					trailing={coreUnavailable ?? undefined}
				>
					<EnginesSection target={target} />
					<DecisionModelsSection enabled={coreSteady} target={target} />
				</PanelPageLink>
				<PanelPageLink
					disabled={coreUnavailable !== null}
					icon={VolumeHighIcon}
					label="Voice & sandbox"
					tint="pink"
					trailing={coreUnavailable ?? undefined}
				>
					<VoiceAndSandboxSection enabled={coreSteady} target={target} />
					<SettingsCard className="py-1.5 empty:hidden">
						<SandboxesSection enabled={coreSteady} target={target} />
					</SettingsCard>
				</PanelPageLink>
				<PanelPageLink
					disabled={coreUnavailable !== null}
					icon={Layers01Icon}
					label="Toolkits"
					tint="orange"
					trailing={coreUnavailable ?? undefined}
				>
					<LayersSection enabled={coreSteady} target={target} />
				</PanelPageLink>
				{hasNetwork && (
					<PanelPageLink
						icon={WifiConnected01Icon}
						label="Network & devices"
						tint="blue"
					>
						<SettingsCard className="space-y-2 py-1.5 empty:hidden">
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
						</SettingsCard>
					</PanelPageLink>
				)}
				<PanelPageLink icon={CpuIcon} label="Hardware" tint="gray">
					<NodeHardwareContent
						enabled={coreReachable === true}
						pending={loading}
						target={target}
					/>
				</PanelPageLink>
			</PanelSection>
			<PanelSection title="Computers">
				{nodes.map((node) => {
					const active = node.name === defaultNode;
					return (
						<PanelRow
							current={active}
							icon={isLocalNode(node) ? LaptopIcon : Link01Icon}
							key={node.name}
							onClick={() => setDefault(node.name)}
							sideAction={
								<button
									aria-label={`Share ${computerName(node)}`}
									className="relative z-10 shrink-0 rounded-md p-1 text-muted-foreground/70 hover:bg-foreground/5 hover:text-foreground"
									onClick={() => setShareNode(node)}
									type="button"
								>
									<HugeiconsIcon className="size-4" icon={Share08Icon} />
								</button>
							}
							tint={isLocalNode(node) ? "blue" : "teal"}
							trailing={
								active ? (
									<HugeiconsIcon
										aria-label="Active"
										className="size-4 shrink-0 text-primary"
										icon={Tick02Icon}
										strokeWidth={2.5}
									/>
								) : null
							}
							value={
								isLocalNode(node)
									? undefined
									: node.managed
										? "Cloud Computers"
										: node.url
							}
						>
							{computerName(node)}
						</PanelRow>
					);
				})}
				<PanelRow
					icon={Add01Icon}
					onClick={() => setAddOpen(true)}
					tint="gray"
					tone="accent"
				>
					Add computer
				</PanelRow>
			</PanelSection>
			{/* Prefer whichever node is actually reachable (opt-in, OFF by default). */}
			<AutoSelectRow variant="settings" />
			{/* The wallet belongs to the active managed node's organization. */}
			{activeNode?.managed && <ManagedNodeWallet node={activeNode} />}
			{/* Auto-detected cloud instances tied to this workspace, not yet added. */}
			<CloudSuggestions compact />
			<PanelGroup>
				<PanelRow
					icon={RefreshIcon}
					onClick={() => {
						refresh()
							.catch(() => undefined)
							.finally(triggerGlobalRefresh);
					}}
					tint="gray"
				>
					Refresh all data
				</PanelRow>
				<PanelRow
					icon={Settings01Icon}
					onClick={() => {
						setSettingsOpen(false);
						openGateway(simpleInterface ? "computer" : undefined);
					}}
					tint="gray"
				>
					{simpleInterface ? "Device settings" : "Gateway settings"}
				</PanelRow>
				<PanelRow
					icon={Share08Icon}
					onClick={openManageCloudServers}
					tint="gray"
				>
					Manage cloud computers
				</PanelRow>
			</PanelGroup>
		</>
	);

	const settingsDialog = (
		<Dialog onOpenChange={setSettingsOpen} open={settingsOpen}>
			{/* A grouped pane, like App Settings: Apple's grouped background with
			    the settings cards raised onto it. On the bare popover surface
			    (`--popover` is `--muted`) the cards had no visible edge. */}
			<DialogContent className="grouped-pane flex h-[min(85vh,720px)] max-w-lg flex-col gap-3 bg-grouped">
				<NodePanelNav
					bodyClassName="scroll-fade -me-2 min-h-0 flex-1 overflow-y-auto pe-2 pb-2"
					renderHeader={({ back, backLabel, title }) => (
						<DialogHeader className="min-h-12 gap-1 pe-10">
							{back && backLabel ? (
								<>
									<PanelBackButton label={backLabel} onClick={back} />
									<DialogTitle className="truncate px-0.5 font-medium text-base">
										{title}
									</DialogTitle>
								</>
							) : (
								<>
									<DialogTitle className="font-medium text-base">
										Computer
									</DialogTitle>
									<DialogDescription>
										Where Ryu runs, and everything running on it.
									</DialogDescription>
								</>
							)}
						</DialogHeader>
					)}
					root={settingsRoot}
				/>
			</DialogContent>
		</Dialog>
	);

	if (mode === "persistent-sidebar") {
		return (
			<div className="space-y-0.5">
				<p className="type-compact mb-1 px-2 font-medium text-muted-foreground/60">
					Computers
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
				{/* The wallet belongs to the active managed node's organization. */}
				{activeNode?.managed && <ManagedNodeWallet node={activeNode} />}
				{/* Auto-detected cloud instances tied to this workspace, not yet added. */}
				<CloudSuggestions />
				{/* Prefer whichever node is actually reachable (opt-in, OFF by default). */}
				<AutoSelectRow />
				<button
					className="flex w-full items-center gap-1.5 px-2 py-1.5 text-muted-foreground/60 text-xs hover:text-muted-foreground"
					onClick={() => openSettings()}
					type="button"
				>
					<HugeiconsIcon icon={Settings01Icon} size={11} />
					Computer settings
				</button>
				<button
					className="flex w-full items-center gap-1.5 px-2 py-1.5 text-muted-foreground/60 text-xs hover:text-muted-foreground"
					onClick={() => setAddOpen(true)}
					type="button"
				>
					<HugeiconsIcon icon={Add01Icon} size={11} />
					Add computer
				</button>
				<button
					className="flex w-full items-center gap-1.5 px-2 py-1.5 text-muted-foreground/60 text-xs hover:text-muted-foreground"
					onClick={openManageCloudServers}
					type="button"
				>
					<HugeiconsIcon icon={Share08Icon} size={11} />
					Manage cloud computers
				</button>
				{settingsDialog}
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

	// compact-dropdown mode — trigger dot reflects system health. The dropdown is
	// the quick switcher (pick a computer, see its health); everything else —
	// engines, voice, toolkits, network — lives one click away in the expanded
	// settings dialog, so the popover stays short.
	return (
		<>
			<DropdownMenu>
				<DropdownMenuTrigger
					render={
						<Button className="max-w-[160px]" size="sm" variant="ghost" />
					}
				>
					{isLocalNode(activeNode ?? LOCAL_FALLBACK) ? (
						<NodeStatusIcon
							borderClassName="border-sidebar"
							icon={LaptopIcon}
							tone={tone}
						/>
					) : (
						<NodeStatusIcon
							borderClassName="border-sidebar"
							icon={Link01Icon}
							tone={tone}
						/>
					)}
					<span
						className="min-w-0 truncate"
						title={computerName(activeNode ?? LOCAL_FALLBACK)}
					>
						{computerName(activeNode ?? LOCAL_FALLBACK)}
					</span>
					<HugeiconsIcon
						className="shrink-0 text-muted-foreground"
						icon={ArrowDown01Icon}
						size={12}
					/>
				</DropdownMenuTrigger>
				<DropdownMenuContent
					align="start"
					className="w-[340px] overflow-hidden"
				>
					<div className="border-border/60 border-b bg-muted/20 px-3 py-3">
						<div className="flex items-start justify-between gap-3">
							<div className="min-w-0">
								<p className="font-medium text-sm">Choose a computer</p>
								<p className="mt-0.5 text-muted-foreground text-xs">
									Where should Ryu run this conversation?
								</p>
							</div>
							{/* A menu item, not a bare button: Base UI's arrow-key roving
							    focus only reaches controls registered as menu items. */}
							<DropdownMenuItem
								aria-label="Expand computer settings"
								className="size-7 shrink-0 justify-center p-0"
								onClick={() => openSettings()}
								title="Expand"
							>
								<HugeiconsIcon icon={ExpandIcon} size={14} />
							</DropdownMenuItem>
						</div>
					</div>
					<div className="max-h-[min(68vh,520px)] overflow-y-auto p-2">
						<p className="type-compact px-2 pt-0.5 pb-1 font-medium text-muted-foreground/60">
							Computers
						</p>
						{nodes.map((node) => (
							<DropdownMenuItem
								className="mb-1"
								key={node.name}
								onClick={() => setDefault(node.name)}
								purpose="node-choice"
								selected={node.name === defaultNode}
							>
								{isLocalNode(node) ? (
									<NodeStatusIcon
										borderClassName="border-accent"
										icon={LaptopIcon}
										subdued={node.name !== defaultNode}
										tone={node.name === defaultNode ? tone : undefined}
									/>
								) : (
									<NodeStatusIcon
										borderClassName="border-accent"
										icon={Link01Icon}
										subdued={node.name !== defaultNode}
										tone={node.name === defaultNode ? tone : undefined}
									/>
								)}
								<span className="min-w-0 flex-1">
									<span
										className="block truncate font-medium"
										title={computerName(node)}
									>
										{computerName(node)}
									</span>
									{showDetail && !isLocalNode(node) && (
										<span className="type-caption mt-0.5 block truncate text-muted-foreground">
											{node.managed ? "Cloud Computers" : node.url}
										</span>
									)}
								</span>
								{node.name === defaultNode && (
									<span className="type-compact rounded-full bg-primary/10 px-1.5 py-0.5 font-medium text-primary">
										Active
									</span>
								)}
								<button
									aria-label={`Share ${computerName(node)}`}
									className="relative shrink-0 text-muted-foreground after:absolute after:-inset-1.5 hover:text-foreground"
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
					</div>
					{showDetail && (
						<NodeMenuHardware
							enabled={coreReachable === true}
							target={target}
						/>
					)}
					{/* Full hardware detail sits right beneath the live usage bars it
					    expands on. */}
					{showDetail && activeNode && (
						<DropdownMenuItem onClick={() => setHardwareNode(activeNode)}>
							<HugeiconsIcon icon={CpuIcon} size={12} />
							<span className="flex-1">Hardware</span>
						</DropdownMenuItem>
					)}
					{/* The wallet belongs to the active managed node's organization. */}
					{activeNode?.managed && (
						<div className="px-1 pt-0.5 pb-1">
							<ManagedNodeWallet node={activeNode} />
						</div>
					)}
					{/* Auto-detected cloud instances tied to this workspace, not yet added. */}
					<CloudSuggestions compact />
					{/* Prefer whichever node is actually reachable (opt-in, OFF by default). */}
					<AutoSelectRow compact />
					<div className="px-1 py-0.5">
						<p className="type-compact px-2 pt-0.5 pb-1 font-medium text-muted-foreground/50">
							Services
						</p>
						{serviceRows}
					</div>
					<div className="border-border/60 border-t p-1">
						<DropdownMenuItem onClick={() => openSettings()}>
							<HugeiconsIcon icon={Settings01Icon} size={12} />
							<span className="flex-1">Engines, voice, toolkits…</span>
							<HugeiconsIcon
								className="text-muted-foreground/60"
								icon={ExpandIcon}
								size={12}
							/>
						</DropdownMenuItem>
						{/* One action to re-check Core and refetch every data source, so after
						    Core recovers nobody has to press "Try again" section by section.
						    Reconnects already fire this automatically (useSystemStatus). */}
						<DropdownMenuItem
							closeOnClick={false}
							onClick={() => {
								refresh()
									.catch(() => undefined)
									.finally(triggerGlobalRefresh);
							}}
						>
							<HugeiconsIcon icon={RefreshIcon} size={12} />
							<span className="flex-1">Refresh all data</span>
						</DropdownMenuItem>
						<DropdownMenuItem onClick={() => setAddOpen(true)}>
							<HugeiconsIcon icon={Add01Icon} size={12} />
							<span className="flex-1">Add computer</span>
						</DropdownMenuItem>
						<DropdownMenuItem
							onClick={() =>
								openGateway(simpleInterface ? "computer" : undefined)
							}
							onFocus={preloadGatewayDialog}
							onPointerEnter={preloadGatewayDialog}
						>
							<HugeiconsIcon icon={Settings01Icon} size={12} />
							<span className="flex-1">
								{simpleInterface ? "Device settings" : "Gateway settings"}
							</span>
						</DropdownMenuItem>
						<DropdownMenuItem onClick={openManageCloudServers}>
							<HugeiconsIcon icon={Share08Icon} size={12} />
							<span className="flex-1">Manage cloud computers</span>
						</DropdownMenuItem>
					</div>
				</DropdownMenuContent>
			</DropdownMenu>
			{settingsDialog}
			<AddNodeDialog onClose={() => setAddOpen(false)} open={addOpen} />
			<GatewayDialog
				defaultSection={gatewaySection}
				onOpenChange={setGatewayOpen}
				open={gatewayOpen}
			/>
			<AgentAutoRoutingEditor />
			{/* Mounted once here, beside the other globally-triggered dialogs, so the
			    six "New agent" entry points all drive one instance. */}
			<CreateAgentDialog />
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

interface LayoutCssVariables extends LayoutCSSProperties {
	"--desktop-inline1-width"?: string | number;
	"--desktop-inline2-width"?: string | number;
}
