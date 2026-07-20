"use client";

// Presentational layer of the desktop Hardware settings tab. The live app
// (`apps/desktop/src/components/settings/HardwareTab.tsx`) is a thin container
// that loads system info via Tauri `invoke` and renders this view; the storyboard
// renders the same component with mock data. One source of truth, so editing this
// block changes the real desktop too.

import { Loading01Icon, Refresh01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "@ryu/blocks/desktop/settings-items";
import { Button } from "@ryu/ui/components/button";
import { Progress } from "@ryu/ui/components/progress";
import type { ReactNode } from "react";

export interface CpuInfo {
	arch: string;
	core_count: number;
	extensions: string[];
	name: string;
	usage: number;
}

export interface GpuInfo {
	name: string;
	total_memory: number;
	uuid?: string;
	vendor: string;
}

export interface HardwareData {
	cpu: CpuInfo;
	gpus: GpuInfo[];
	os_name: string;
	os_type: string;
	total_memory: number;
}

export interface SystemUsage {
	cpu: number;
	total_memory: number;
	used_memory: number;
}

export interface HardwareViewProps {
	hardware?: HardwareData | null;
	loading?: boolean;
	onRefresh?: () => void;
	refreshing?: boolean;
	usage?: SystemUsage | null;
}

function formatBytes(bytes: number): string {
	const gb = bytes / (1024 * 1024 * 1024);
	return `${gb.toFixed(2)} GB`;
}

function InfoRow({ label, value }: { label: string; value: ReactNode }) {
	return (
		<SettingsItem
			actions={<span className="text-right font-mono text-xs">{value}</span>}
			title={<span className="font-normal text-muted-foreground">{label}</span>}
		/>
	);
}

function Section({ title, children }: { title: string; children: ReactNode }) {
	return (
		<SettingsSection title={title}>
			<SettingsGroup>{children}</SettingsGroup>
		</SettingsSection>
	);
}

export function HardwareView({
	hardware,
	usage,
	loading,
	refreshing,
	onRefresh,
}: HardwareViewProps) {
	if (loading) {
		return (
			<div className="flex h-32 items-center justify-center text-muted-foreground">
				<HugeiconsIcon className="size-5 animate-spin" icon={Loading01Icon} />
			</div>
		);
	}

	if (!(hardware && usage)) {
		return (
			<div className="flex h-32 items-center justify-center text-muted-foreground text-sm">
				Could not load hardware info. Try refreshing.
			</div>
		);
	}

	const memUsedPct = (usage.used_memory / usage.total_memory) * 100;

	return (
		<div className="space-y-6">
			<Section title="Operating System">
				<InfoRow
					label="Name"
					value={<span className="capitalize">{hardware.os_type}</span>}
				/>
				<InfoRow label="Version" value={hardware.os_name} />
			</Section>

			<Section title="CPU">
				<InfoRow label="Model" value={hardware.cpu.name} />
				<InfoRow label="Architecture" value={hardware.cpu.arch} />
				<InfoRow label="Cores" value={hardware.cpu.core_count} />
				{hardware.cpu.extensions.length > 0 ? (
					<InfoRow
						label="Instructions"
						value={hardware.cpu.extensions.join(", ")}
					/>
				) : null}
				<InfoRow
					label="Usage"
					value={
						<div className="flex items-center gap-2">
							<Progress className="h-1.5 w-20" value={usage.cpu} />
							<span>{usage.cpu.toFixed(1)}%</span>
						</div>
					}
				/>
			</Section>

			<Section title="Memory">
				<InfoRow label="Total RAM" value={formatBytes(hardware.total_memory)} />
				<InfoRow
					label="Available"
					value={formatBytes(usage.total_memory - usage.used_memory)}
				/>
				<InfoRow
					label="Usage"
					value={
						<div className="flex items-center gap-2">
							<Progress className="h-1.5 w-20" value={memUsedPct} />
							<span>{memUsedPct.toFixed(1)}%</span>
						</div>
					}
				/>
			</Section>

			{hardware.gpus.length > 0 ? (
				<Section title="GPU">
					{hardware.gpus.map((gpu, i) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: static hardware list
						<div key={i}>
							<InfoRow label="Model" value={gpu.name} />
							<InfoRow label="Vendor" value={gpu.vendor} />
							{gpu.total_memory > 0 ? (
								<InfoRow label="VRAM" value={formatBytes(gpu.total_memory)} />
							) : null}
							{gpu.uuid ? <InfoRow label="UUID" value={gpu.uuid} /> : null}
						</div>
					))}
				</Section>
			) : null}

			<div className="flex justify-center pt-2">
				<Button
					disabled={refreshing}
					onClick={onRefresh}
					size="sm"
					variant="ghost"
				>
					<HugeiconsIcon
						className={`mr-2 size-4 ${refreshing ? "animate-spin" : ""}`}
						icon={Refresh01Icon}
					/>
					Refresh
				</Button>
			</div>
		</div>
	);
}
