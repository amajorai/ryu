import {
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "@ryu/blocks/desktop/settings-items.tsx";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
} from "@ryu/ui/components/dialog.tsx";
import { Progress } from "@ryu/ui/components/progress.tsx";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ryu/ui/components/tooltip.tsx";
import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { sileo } from "sileo";
import { cn } from "@/lib/utils.ts";
import { useNodeSystemInfo } from "@/src/hooks/useNodeSystemInfo.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import type { SystemInfo } from "@/src/lib/api/system.ts";
import {
	fetchDependencies,
	installMissingDeps,
} from "@/src/lib/services-api.ts";
import type { Node } from "@/src/store/useNodeStore.ts";
import layoutStyles from "./NodeSelector.module.css";
import {
	computerName,
	type LayoutCssVariables,
} from "./NodeSelector-status.tsx";

const GPU_VENDOR_NVIDIA = /^NVIDIA\s+(GeForce\s+)?/i;
const GPU_VENDOR_AMD = /^AMD\s+(Radeon\s+)?/i;
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
			<div className="flex items-center justify-between gap-2 text-muted-foreground/70 text-xs">
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
export function NodeStats({ info }: { info: SystemInfo }) {
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
								<p className="relative truncate text-muted-foreground/70 text-xs">
									{specs.join(" · ")}
								</p>
							}
						/>
						<TooltipContent>{info.cpuName}</TooltipContent>
					</Tooltip>
				) : (
					<p className="truncate text-muted-foreground/70 text-xs">
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
	const tl = useLiteralMessages();
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
					{installing
						? "Installing…"
						: tl("Install {count} missing", { count: missing.length })}
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
export function NodeHardwareDialog({
	node,
	open,
	onClose,
}: {
	node: Node | null;
	open: boolean;
	onClose: () => void;
}) {
	const tl = useLiteralMessages();
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
						{node
							? tl("Hardware · {name}", { name: computerName(node) })
							: tl("Hardware")}
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
export function NodeHardwareContent({
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
