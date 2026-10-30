import {
	Add01Icon,
	ArrowDown01Icon,
	CpuIcon,
	ExpandIcon,
	LaptopIcon,
	Link01Icon,
	RefreshIcon,
	Settings01Icon,
	Share08Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@ryu/ui/components/dropdown-menu.tsx";
import type { ReactNode } from "react";
import { preloadGatewayDialog } from "@/src/components/gateway/LazyGatewayDialog.tsx";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import { triggerGlobalRefresh } from "@/src/lib/core-refresh.ts";
import type { useGatewayDialog } from "@/src/store/useGatewayDialog.ts";
import {
	isLocalNode,
	LOCAL_FALLBACK,
	type Node,
} from "@/src/store/useNodeStore.ts";
import { AutoSelectRow } from "./NodeSelector-auto-select.tsx";
import { NodeMenuHardware } from "./NodeSelector-menu-parts.tsx";
import {
	computerName,
	NodeStatusIcon,
	openManageCloudServers,
	type Tone,
} from "./NodeSelector-status.tsx";
import { CloudSuggestions, ManagedNodeWallet } from "./NodeSelector-wallet.tsx";

type OpenGateway = ReturnType<typeof useGatewayDialog.getState>["openGateway"];

/** The compact-dropdown quick switcher (see {@link NodeSelector}). */
export function NodeSelectorDropdown({
	activeNode,
	coreReachable,
	defaultNode,
	nodes,
	openGateway,
	openSettings,
	refresh,
	serviceRows,
	setAddOpen,
	setDefault,
	setHardwareNode,
	setShareNode,
	showDetail,
	simpleInterface,
	target,
	tone,
}: {
	activeNode: Node | undefined;
	coreReachable: boolean;
	defaultNode: string;
	nodes: Node[];
	openGateway: OpenGateway;
	openSettings: () => void;
	refresh: () => Promise<void>;
	serviceRows: ReactNode;
	setAddOpen: (open: boolean) => void;
	setDefault: (name: string) => Promise<void>;
	setHardwareNode: (node: Node | null) => void;
	setShareNode: (node: Node | null) => void;
	showDetail: boolean;
	simpleInterface: boolean;
	target: ApiTarget;
	tone: Tone;
}) {
	const tl = useLiteralMessages();
	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				render={
					<Button
						className="max-w-[160px]"
						size="sm"
						title={computerName(activeNode ?? LOCAL_FALLBACK)}
						variant="ghost"
					/>
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
				{/* The fixed back/forward/sidebar/search cluster sits on this row's
				    left, so the name only takes the width the sidebar has beyond its
				    260px default; at the default the trigger is icon-only and the
				    name stays in the accessible label, the tooltip and the menu. */}
				<span className="min-w-0 max-w-[max(0px,calc(var(--sidebar-width,360px)-260px))] truncate">
					{computerName(activeNode ?? LOCAL_FALLBACK)}
				</span>
				<HugeiconsIcon
					className="shrink-0 text-muted-foreground"
					icon={ArrowDown01Icon}
					size={12}
				/>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="start" className="w-[340px] overflow-hidden">
				<div className="border-border border-b bg-muted/20 px-3 py-3">
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
					<p className="px-2 pt-0.5 pb-1 font-medium text-muted-foreground/70 text-xs">
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
									<span className="mt-0.5 block truncate text-muted-foreground text-xs">
										{node.managed ? "Cloud Computers" : node.url}
									</span>
								)}
							</span>
							{node.name === defaultNode && (
								<span className="rounded-full bg-primary/10 px-1.5 py-0.5 font-medium text-primary text-xs">
									Active
								</span>
							)}
							<button
								aria-label={tl("Share {name}", { name: computerName(node) })}
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
					<NodeMenuHardware enabled={coreReachable === true} target={target} />
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
					<p className="px-2 pt-0.5 pb-1 font-medium text-muted-foreground/70 text-xs">
						Services
					</p>
					{serviceRows}
				</div>
				<div className="border-border border-t p-1">
					<DropdownMenuItem onClick={() => openSettings()}>
						<HugeiconsIcon icon={Settings01Icon} size={12} />
						<span className="flex-1">Engines, voice, toolkits…</span>
						<HugeiconsIcon
							className="text-muted-foreground/70"
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
	);
}
