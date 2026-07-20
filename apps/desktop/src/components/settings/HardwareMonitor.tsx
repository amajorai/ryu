import { Loading01Icon, Refresh01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@ryu/ui/components/button";
import {
	Item,
	ItemActions,
	ItemGroup,
	ItemSeparator,
	ItemTitle,
} from "@ryu/ui/components/item";
import { Progress } from "@ryu/ui/components/progress";
import { toast } from "@ryu/ui/components/sileo";
import { useCallback, useEffect, useState } from "react";

interface HardwareData {
	cpu_brand: string;
	cpu_cores: number;
	gpu_name?: string;
	os_name: string;
	os_type: string;
	total_memory: number;
}

interface SystemUsage {
	cpu_usage: number;
	gpu_usage?: number;
	total_memory: number;
	used_memory: number;
}

export function HardwareMonitor() {
	const [hardwareData, setHardwareData] = useState<HardwareData | null>(null);
	const [systemUsage, setSystemUsage] = useState<SystemUsage | null>(null);
	const [isLoading, setIsLoading] = useState(true);
	const [isRefreshing, setIsRefreshing] = useState(false);

	const fetchHardwareInfo = useCallback(async (isRefresh = false) => {
		setIsRefreshing(true);
		try {
			// These will call Tauri backend commands
			const [hardware, usage] = await Promise.all([
				window.__TAURI__?.core.invoke("get_hardware_info") ||
					Promise.resolve(null),
				window.__TAURI__?.core.invoke("get_system_usage") ||
					Promise.resolve(null),
			]);

			if (hardware) {
				setHardwareData(hardware as HardwareData);
			}
			if (usage) {
				setSystemUsage(usage as SystemUsage);
			}
		} catch (error) {
			console.error("Failed to fetch hardware info:", error);
			if (isRefresh) {
				toast.error("Couldn't refresh hardware info", {
					description:
						"The numbers shown may be out of date. Please try again.",
				});
			}
		} finally {
			setIsLoading(false);
			setIsRefreshing(false);
		}
	}, []);

	useEffect(() => {
		fetchHardwareInfo();

		// Poll for system usage every 5 seconds
		const interval = setInterval(async () => {
			try {
				const usage = await (window.__TAURI__?.core.invoke(
					"get_system_usage"
				) || Promise.resolve(null));
				if (usage) {
					setSystemUsage(usage as SystemUsage);
				}
			} catch (error) {
				console.error("Failed to fetch system usage:", error);
			}
		}, 5000);

		return () => clearInterval(interval);
	}, [fetchHardwareInfo]);

	const formatBytes = (bytes: number): string => {
		const gb = bytes / (1024 * 1024 * 1024);
		return `${gb.toFixed(2)} GB`;
	};

	if (isLoading) {
		return (
			<div className="flex h-32 items-center justify-center text-muted-foreground">
				<HugeiconsIcon className="h-6 w-6 animate-spin" icon={Loading01Icon} />
			</div>
		);
	}

	if (!(hardwareData && systemUsage)) {
		return (
			<div className="flex h-32 items-center justify-center">
				<div className="text-muted-foreground">
					I couldn't load your hardware information.{" "}
					<Button onClick={() => fetchHardwareInfo(true)} variant="link">
						Try again
					</Button>
				</div>
			</div>
		);
	}

	const memoryUsagePercent =
		(systemUsage.used_memory / systemUsage.total_memory) * 100;

	return (
		<div className="space-y-6">
			{/* Operating System */}
			<div className="space-y-1">
				<h3 className="px-3 py-2 font-medium text-muted-foreground text-xs">
					Operating System
				</h3>
				<ItemGroup className="overflow-hidden rounded-lg bg-muted/50 shadow-none">
					<Item className="justify-between" size="sm">
						<ItemTitle>Name</ItemTitle>
						<ItemActions>
							<span className="text-foreground capitalize">
								{hardwareData.os_type}
							</span>
						</ItemActions>
					</Item>
					<ItemSeparator />
					<Item className="justify-between" size="sm">
						<ItemTitle>Version</ItemTitle>
						<ItemActions>
							<span className="text-foreground">{hardwareData.os_name}</span>
						</ItemActions>
					</Item>
				</ItemGroup>
			</div>

			{/* CPU */}
			<div className="space-y-1">
				<h3 className="px-3 py-2 font-medium text-muted-foreground text-xs">
					CPU
				</h3>
				<ItemGroup className="overflow-hidden rounded-lg bg-muted/50 shadow-none">
					<Item className="justify-between" size="sm">
						<ItemTitle>Brand</ItemTitle>
						<ItemActions>
							<span className="text-foreground">{hardwareData.cpu_brand}</span>
						</ItemActions>
					</Item>
					<ItemSeparator />
					<Item className="justify-between" size="sm">
						<ItemTitle>Cores</ItemTitle>
						<ItemActions>
							<span className="text-foreground">{hardwareData.cpu_cores}</span>
						</ItemActions>
					</Item>
					<ItemSeparator />
					<Item className="justify-between" size="sm">
						<ItemTitle>Usage</ItemTitle>
						<ItemActions className="w-32">
							<Progress className="h-2" value={systemUsage.cpu_usage} />
							<span className="text-foreground text-xs">
								{systemUsage.cpu_usage.toFixed(1)}%
							</span>
						</ItemActions>
					</Item>
				</ItemGroup>
			</div>

			{/* Memory */}
			<div className="space-y-1">
				<h3 className="px-3 py-2 font-medium text-muted-foreground text-xs">
					Memory
				</h3>
				<ItemGroup className="overflow-hidden rounded-lg bg-muted/50 shadow-none">
					<Item className="justify-between" size="sm">
						<ItemTitle>Total</ItemTitle>
						<ItemActions>
							<span className="text-foreground">
								{formatBytes(hardwareData.total_memory)}
							</span>
						</ItemActions>
					</Item>
					<ItemSeparator />
					<Item className="justify-between" size="sm">
						<ItemTitle>Used</ItemTitle>
						<ItemActions>
							<span className="text-foreground">
								{formatBytes(systemUsage.used_memory)}
							</span>
						</ItemActions>
					</Item>
					<ItemSeparator />
					<Item className="justify-between" size="sm">
						<ItemTitle>Usage</ItemTitle>
						<ItemActions className="w-32">
							<Progress className="h-2" value={memoryUsagePercent} />
							<span className="text-foreground text-xs">
								{memoryUsagePercent.toFixed(1)}%
							</span>
						</ItemActions>
					</Item>
				</ItemGroup>
			</div>

			{/* GPU */}
			{hardwareData.gpu_name && (
				<div className="space-y-1">
					<h3 className="px-3 py-2 font-medium text-muted-foreground text-xs">
						GPU
					</h3>
					<ItemGroup className="overflow-hidden rounded-lg bg-muted/50 shadow-none">
						<Item className="justify-between" size="sm">
							<ItemTitle>Name</ItemTitle>
							<ItemActions>
								<span className="text-foreground">{hardwareData.gpu_name}</span>
							</ItemActions>
						</Item>
						{systemUsage.gpu_usage !== undefined && (
							<>
								<ItemSeparator />
								<Item className="justify-between" size="sm">
									<ItemTitle>Usage</ItemTitle>
									<ItemActions className="w-32">
										<Progress className="h-2" value={systemUsage.gpu_usage} />
										<span className="text-foreground text-xs">
											{systemUsage.gpu_usage.toFixed(1)}%
										</span>
									</ItemActions>
								</Item>
							</>
						)}
					</ItemGroup>
				</div>
			)}

			{/* Refresh Button */}
			<Button
				className="w-full"
				disabled={isRefreshing}
				onClick={() => fetchHardwareInfo(true)}
				variant="ghost"
			>
				{isRefreshing ? (
					<>
						<HugeiconsIcon
							className="mr-2 h-4 w-4 animate-spin"
							icon={Loading01Icon}
						/>
						Refreshing...
					</>
				) : (
					<>
						<HugeiconsIcon className="mr-2 h-4 w-4" icon={Refresh01Icon} />
						Refresh Hardware Info
					</>
				)}
			</Button>
		</div>
	);
}
