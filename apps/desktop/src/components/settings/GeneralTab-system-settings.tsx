import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { toast } from "@ryu/ui/components/sileo.tsx";
import { Switch } from "@ryu/ui/components/switch.tsx";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { relaunch } from "@tauri-apps/plugin-process";
import { useMemo } from "react";
import { z } from "zod";
import { useAppSurface } from "@/src/contexts/app-surface-context.tsx";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import { toTarget } from "@/src/lib/api/client.ts";
import {
	DEFAULT_GATEWAY_ACP,
	type GatewayAcpSettings,
	updateGatewayConfig,
} from "@/src/lib/api/gateway.ts";
import { gatewayAcpQueryOptions } from "@/src/lib/gateway-acp-query.ts";
import { SettingsItem } from "./shared/settings-items.tsx";

export function KeepAwakeSetting() {
	const { canManageDesktopLifecycle } = useAppSurface();
	const node = useActiveNode();
	const target = useMemo(
		() => toTarget(node),
		[node.token, node.url, node.userJwt]
	);
	const queryClient = useQueryClient();
	const options = gatewayAcpQueryOptions(target);
	const configQuery = useQuery({
		...options,
		enabled: canManageDesktopLifecycle,
		subscribed: canManageDesktopLifecycle,
	});
	const config = configQuery.data?.acp ?? DEFAULT_GATEWAY_ACP;
	const save = useMutation({
		mutationFn: (keepComputerAwake: boolean) => {
			const acp: GatewayAcpSettings = {
				idle_timeout_minutes: config.idle_timeout_minutes,
				keep_computer_awake: keepComputerAwake,
				max_parallel_agents: config.max_parallel_agents,
			};
			return updateGatewayConfig(target, { acp });
		},
		onSuccess: async () => {
			await queryClient.invalidateQueries({
				queryKey: options.queryKey,
			});
		},
		onError: (error: Error) => {
			toast.error("Couldn't update the sleep prevention setting", {
				description: error.message,
			});
		},
	});

	return (
		<SettingsItem
			actions={
				<Switch
					checked={config.keep_computer_awake}
					disabled={
						!canManageDesktopLifecycle ||
						configQuery.isLoading ||
						configQuery.isError ||
						save.isPending
					}
					id="prevent-sleep-while-running-toggle"
					onCheckedChange={(checked) => save.mutate(checked)}
				/>
			}
			description="Keep this computer awake while an ACP agent runs."
			settingsId="general.system.prevent-sleep-while-running"
			title="Prevent sleep while running"
		/>
	);
}

const hardwareAccelerationSchema = z.object({
	active: z.boolean(),
	enabled: z.boolean(),
	supported: z.boolean(),
});

const HARDWARE_ACCELERATION_QUERY_KEY = ["desktop", "hardware-acceleration"];

/**
 * GPU rendering for the desktop window. The webview reads its GPU switches at
 * launch, so the native side keeps the choice in a file applied before the first
 * webview starts, and a change only takes effect after a restart.
 */
export function HardwareAccelerationSetting() {
	const tl = useLiteralMessages();
	const queryClient = useQueryClient();
	const statusQuery = useQuery({
		queryKey: HARDWARE_ACCELERATION_QUERY_KEY,
		queryFn: async () =>
			hardwareAccelerationSchema.parse(
				await invoke("get_hardware_acceleration")
			),
	});
	const save = useMutation({
		mutationFn: (enabled: boolean) =>
			invoke("set_hardware_acceleration", { enabled }),
		onSuccess: async () => {
			await queryClient.invalidateQueries({
				queryKey: HARDWARE_ACCELERATION_QUERY_KEY,
			});
		},
		onError: (error: Error) => {
			toast.error("Couldn't update hardware acceleration", {
				description: error.message,
			});
		},
	});
	const restart = useMutation({
		mutationFn: () => relaunch(),
		onError: (error: Error) => {
			toast.error("Couldn't restart Ryu", { description: error.message });
		},
	});

	const status = statusQuery.data;
	const supported = status?.supported ?? true;
	const enabled = status?.enabled ?? true;
	const pendingRestart = status ? status.enabled !== status.active : false;
	let description =
		"Turn off if the window flickers or goes blank. Applies after a restart.";
	if (!supported) {
		description = "Always on for macOS.";
	} else if (pendingRestart) {
		description = enabled
			? tl("Restart Ryu to turn hardware acceleration on.")
			: tl("Restart Ryu to turn hardware acceleration off.");
	}

	return (
		<SettingsItem
			actions={
				<div className="flex items-center gap-2">
					{pendingRestart ? (
						<Button
							disabled={restart.isPending}
							onClick={() => restart.mutate()}
							size="sm"
							variant="ghost"
						>
							Restart now
						</Button>
					) : null}
					<Switch
						checked={enabled}
						disabled={
							!supported ||
							statusQuery.isLoading ||
							statusQuery.isError ||
							save.isPending
						}
						id="hardware-acceleration-toggle"
						onCheckedChange={(checked) => save.mutate(checked)}
					/>
				</div>
			}
			description={description}
			settingsId="general.system.hardware-acceleration"
			title="Use hardware acceleration"
		/>
	);
}
