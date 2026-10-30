import { CpuIcon, Delete01Icon, Share08Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
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
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ryu/ui/components/tooltip.tsx";
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils.ts";
import { useNodeSystemInfo } from "@/src/hooks/useNodeSystemInfo.ts";
import { invokeWhenReady } from "@/src/lib/tauri-ready.ts";
import type { Node } from "@/src/store/useNodeStore.ts";
import { NodeStats } from "./NodeSelector-hardware.tsx";
import { computerName, StatusDot } from "./NodeSelector-status.tsx";

export function NodeItem({
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
	const tl = useLiteralMessages();
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
									<span className="relative shrink-0 rounded-full bg-accent px-1.5 py-0.5 font-medium text-accent-foreground text-xs">
										Cloud Computers
									</span>
								}
							/>
							<TooltipContent>
								{info?.orgName
									? tl("Cloud Computers · {orgName}", { orgName: info.orgName })
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
									<span className="relative shrink-0 rounded-full bg-accent px-1.5 py-0.5 font-medium text-accent-foreground text-xs">
										GPU
									</span>
								}
							/>
							<TooltipContent>{info.gpuName}</TooltipContent>
						</Tooltip>
					)}
					{onHardware && (
						<button
							aria-label={tl("Hardware for {name}", {
								name: computerName(node),
							})}
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
							aria-label={tl("Share {name}", { name: computerName(node) })}
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
							aria-label={tl("Remove {name}", { name: computerName(node) })}
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
							<AlertDialogTitle>
								{tl("Remove {name}?", { name: computerName(node) })}
							</AlertDialogTitle>
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
