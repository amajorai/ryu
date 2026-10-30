import {
	Add01Icon,
	Router01Icon,
	ServerStack01Icon,
	Settings01Icon,
	Share08Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@ryu/ui/components/dialog.tsx";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { AgentAutoRoutingEditor } from "@/src/components/agents/AgentAutoRoutingEditor.tsx";
import { CreateAgentDialog } from "@/src/components/agents/LazyCreateAgentDialog.tsx";
import { GatewayDialog } from "@/src/components/gateway/LazyGatewayDialog.tsx";
import { useSystemStatusContext } from "@/src/contexts/SystemStatusContext.tsx";
import { useInterfaceLevel } from "@/src/hooks/useInterfaceLevel.ts";
import { useNodeSelectorDetail } from "@/src/hooks/useNodeSelectorDetail.ts";
import { useNodeVersion } from "@/src/hooks/useNodeVersion.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import { fetchConnections } from "@/src/lib/api/connections.ts";
import { installAndLaunchIsland } from "@/src/lib/api/island.ts";
import {
	fetchMeshPeers,
	fetchWebhookIngressStatus,
	type MeshPeerEntry,
} from "@/src/lib/api/mesh.ts";
import { ISLAND_ENABLED } from "@/src/lib/island-availability.ts";
import { useGatewayDialog } from "@/src/store/useGatewayDialog.ts";
import { type Node, useNodeStore } from "@/src/store/useNodeStore.ts";
import { useSettingsDialog } from "@/src/store/useSettingsDialog.ts";
import { NodePanelNav, PanelBackButton } from "./NodePanelNav.tsx";
import { AddNodeDialog } from "./NodeSelector-add-node-dialog.tsx";
import { AutoSelectRow } from "./NodeSelector-auto-select.tsx";
import { NodeSelectorDropdown } from "./NodeSelector-dropdown.tsx";
import { NodeHardwareDialog } from "./NodeSelector-hardware.tsx";
import { ShareNodeDialog } from "./NodeSelector-lazy-share-node-dialog.tsx";
import {
	NodeMenuGateway,
	useSteadyReachable,
} from "./NodeSelector-menu-parts.tsx";
import { NodeItem } from "./NodeSelector-node-item.tsx";
import { ServiceRow } from "./NodeSelector-service-row.tsx";
import { NodeSelectorSettingsRoot } from "./NodeSelector-settings-root.tsx";
import { openManageCloudServers, resolveTone } from "./NodeSelector-status.tsx";
import { CloudSuggestions, ManagedNodeWallet } from "./NodeSelector-wallet.tsx";

export { AddNodeDialog } from "./NodeSelector-add-node-dialog.tsx";

interface NodeSelectorProps {
	mode: "persistent-sidebar" | "compact-dropdown";
}

export function NodeSelector({ mode }: NodeSelectorProps) {
	const { nodes, defaultNode, setDefault, removeNode, addNode } = useNodeStore(
		useShallow((state) => ({
			addNode: state.addNode,
			defaultNode: state.defaultNode,
			nodes: state.nodes,
			removeNode: state.removeNode,
			setDefault: state.setDefault,
		}))
	);
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
		<NodeSelectorSettingsRoot
			activeNode={activeNode}
			connections={connections}
			coreReachable={coreReachable}
			coreSteady={coreSteady}
			coreUnavailable={coreUnavailable}
			defaultNode={defaultNode}
			handleAddPeer={handleAddPeer}
			hasNetwork={hasNetwork}
			ingress={ingress}
			loading={loading}
			meshPeers={meshPeers}
			meshReachable={meshReachable}
			meshStatus={meshStatus}
			nodes={nodes}
			openGateway={openGateway}
			refresh={refresh}
			serviceRows={serviceRows}
			servicesSummary={servicesSummary}
			setAddOpen={setAddOpen}
			setDefault={setDefault}
			setSettingsOpen={setSettingsOpen}
			setShareNode={setShareNode}
			simpleInterface={simpleInterface}
			target={target}
			tone={tone}
		/>
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
									<DialogTitle className="truncate px-0.5 font-sans font-semibold text-lg tracking-tight">
										{title}
									</DialogTitle>
								</>
							) : (
								<>
									<DialogTitle className="font-sans font-semibold text-lg tracking-tight">
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
				<p className="mb-1 px-2 font-medium text-muted-foreground/70 text-xs">
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
					className="flex w-full items-center gap-1.5 px-2 py-1.5 text-muted-foreground/70 text-xs hover:text-muted-foreground"
					onClick={() => openSettings()}
					type="button"
				>
					<HugeiconsIcon icon={Settings01Icon} size={11} />
					Computer settings
				</button>
				<button
					className="flex w-full items-center gap-1.5 px-2 py-1.5 text-muted-foreground/70 text-xs hover:text-muted-foreground"
					onClick={() => setAddOpen(true)}
					type="button"
				>
					<HugeiconsIcon icon={Add01Icon} size={11} />
					Add computer
				</button>
				<button
					className="flex w-full items-center gap-1.5 px-2 py-1.5 text-muted-foreground/70 text-xs hover:text-muted-foreground"
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
			<NodeSelectorDropdown
				activeNode={activeNode}
				coreReachable={coreReachable}
				defaultNode={defaultNode}
				nodes={nodes}
				openGateway={openGateway}
				openSettings={openSettings}
				refresh={refresh}
				serviceRows={serviceRows}
				setAddOpen={setAddOpen}
				setDefault={setDefault}
				setHardwareNode={setHardwareNode}
				setShareNode={setShareNode}
				showDetail={showDetail}
				simpleInterface={simpleInterface}
				target={target}
				tone={tone}
			/>
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
