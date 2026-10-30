import {
	Add01Icon,
	CpuIcon,
	LaptopIcon,
	LayerIcon,
	Layers01Icon,
	Link01Icon,
	RefreshIcon,
	ServerStack01Icon,
	Settings01Icon,
	Share08Icon,
	Tick02Icon,
	VolumeHighIcon,
	WifiConnected01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { SettingsCard } from "@ryu/blocks/desktop/settings-items.tsx";
import { useLiteralMessages } from "@ryu/i18n/react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils.ts";
import { type ApiTarget, currentClientId } from "@/src/lib/api/client.ts";
import type { ConnectionsSnapshot } from "@/src/lib/api/connections.ts";
import type {
	MeshPeerEntry,
	MeshPeersResult,
	MeshStatus,
	WebhookIngressStatus,
} from "@/src/lib/api/mesh.ts";
import { triggerGlobalRefresh } from "@/src/lib/core-refresh.ts";
import type { useGatewayDialog } from "@/src/store/useGatewayDialog.ts";
import {
	isLocalNode,
	LOCAL_FALLBACK,
	type Node,
} from "@/src/store/useNodeStore.ts";
import {
	PanelGroup,
	PanelPageLink,
	PanelRow,
	PanelSection,
} from "./NodePanelNav.tsx";
import { AutoSelectRow } from "./NodeSelector-auto-select.tsx";
import { EnginesSection } from "./NodeSelector-engines.tsx";
import { NodeHardwareContent } from "./NodeSelector-hardware.tsx";
import {
	DecisionModelsSection,
	LayersSection,
} from "./NodeSelector-layers-section.tsx";
import { NodeMenuHardware, TONE_LABEL } from "./NodeSelector-menu-parts.tsx";
import { ConnectedSection, MeshSection } from "./NodeSelector-mesh.tsx";
import { SandboxesSection } from "./NodeSelector-sandboxes.tsx";
import {
	computerName,
	NodeStatusIcon,
	openManageCloudServers,
	TONE_DOT,
	type Tone,
} from "./NodeSelector-status.tsx";
import { VoiceAndSandboxSection } from "./NodeSelector-voice-sandbox.tsx";
import { CloudSuggestions, ManagedNodeWallet } from "./NodeSelector-wallet.tsx";

type OpenGateway = ReturnType<typeof useGatewayDialog.getState>["openGateway"];

/** The expanded computer dialog's root page (see {@link NodeSelector}). */
export function NodeSelectorSettingsRoot({
	activeNode,
	connections,
	coreReachable,
	coreSteady,
	coreUnavailable,
	defaultNode,
	handleAddPeer,
	hasNetwork,
	ingress,
	loading,
	meshPeers,
	meshReachable,
	meshStatus,
	nodes,
	openGateway,
	refresh,
	serviceRows,
	servicesSummary,
	setAddOpen,
	setDefault,
	setSettingsOpen,
	setShareNode,
	simpleInterface,
	target,
	tone,
}: {
	activeNode: Node | undefined;
	connections: ConnectionsSnapshot | null | undefined;
	coreReachable: boolean;
	coreSteady: boolean;
	coreUnavailable: string | null;
	defaultNode: string;
	handleAddPeer: (peer: MeshPeerEntry) => Promise<void>;
	hasNetwork: boolean;
	ingress: WebhookIngressStatus | null | undefined;
	loading: boolean;
	meshPeers: MeshPeersResult | null | undefined;
	meshReachable: boolean | null;
	meshStatus: MeshStatus | null;
	nodes: Node[];
	openGateway: OpenGateway;
	refresh: () => Promise<void>;
	serviceRows: ReactNode;
	servicesSummary: string;
	setAddOpen: (open: boolean) => void;
	setDefault: (name: string) => Promise<void>;
	setSettingsOpen: (open: boolean) => void;
	setShareNode: (node: Node | null) => void;
	simpleInterface: boolean;
	target: ApiTarget;
	tone: Tone;
}) {
	const tl = useLiteralMessages();
	return (
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
						<p className="truncate text-muted-foreground text-xs">
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
									aria-label={tl("Share {name}", { name: computerName(node) })}
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
}
