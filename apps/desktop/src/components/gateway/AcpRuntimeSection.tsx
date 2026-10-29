import { useLiteralMessages } from "@ryu/i18n/react";
import { Badge } from "@ryu/ui/components/badge.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { Label } from "@ryu/ui/components/label.tsx";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select.tsx";
import { SkeletonRows } from "@ryu/ui/components/skeleton.tsx";
import { Switch } from "@ryu/ui/components/switch.tsx";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState } from "react";
import { sileo } from "sileo";
import {
	SettingsCard,
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "@/src/components/settings/shared/settings-items.tsx";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	DEFAULT_GATEWAY_ACP,
	type GatewayAcpConfig,
	type GatewayAcpSettings,
	type GatewayConfig,
	updateGatewayConfig,
} from "@/src/lib/api/gateway.ts";
import { gatewayAcpQueryOptions } from "@/src/lib/gateway-acp-query.ts";
import { SettingsNotice } from "./SettingsNotice.tsx";

const MIN_IDLE_MINUTES = 1;
const MAX_IDLE_MINUTES = 24 * 60;
const PARALLEL_OPTIONS = [1, 2, 4, 8, 16, 32];

function acpSettings(config: GatewayAcpConfig): GatewayAcpSettings {
	return {
		idle_timeout_minutes: config.idle_timeout_minutes,
		max_parallel_agents: config.max_parallel_agents,
		keep_computer_awake: config.keep_computer_awake,
	};
}

function formatRam(bytes: number | undefined): string {
	if (!bytes || bytes < 1) {
		return "RAM unavailable";
	}
	const gib = bytes / 1024 ** 3;
	return `${gib >= 10 ? gib.toFixed(0) : gib.toFixed(1)} GiB RAM`;
}

function runtimeConfig(config: GatewayConfig | undefined): GatewayAcpConfig {
	return config?.acp ?? DEFAULT_GATEWAY_ACP;
}

/** Gateway-level controls for the resident ACP process pool. */
export function AcpRuntimeSection({
	canConfigure,
	target,
}: {
	canConfigure: boolean;
	target: ApiTarget;
}) {
	const controlId = useId();
	const tl = useLiteralMessages();
	const queryClient = useQueryClient();
	const options = gatewayAcpQueryOptions(target);
	const configQuery = useQuery(options);
	const config = runtimeConfig(configQuery.data);
	const [idleDraft, setIdleDraft] = useState(
		String(config.idle_timeout_minutes)
	);

	useEffect(() => {
		setIdleDraft(String(config.idle_timeout_minutes));
	}, [config.idle_timeout_minutes]);

	const writePending = useRef(false);
	const [parallelOpen, setParallelOpen] = useState(false);

	const save = useMutation({
		mutationFn: (next: GatewayAcpSettings) =>
			updateGatewayConfig(target, { acp: next }),
		onSuccess: async () => {
			await queryClient.invalidateQueries({
				queryKey: options.queryKey,
			});
		},
		onSettled: () => {
			writePending.current = false;
		},
		onError: (error: Error) => {
			sileo.error({
				title: "Could not save ACP runtime settings",
				description: error.message,
			});
		},
	});

	const disabled = !canConfigure || save.isPending || !configQuery.isSuccess;
	const commit = (patch: Partial<GatewayAcpSettings>) => {
		if (disabled || writePending.current) {
			return;
		}
		const next = { ...acpSettings(config), ...patch };
		if (
			next.idle_timeout_minutes === config.idle_timeout_minutes &&
			next.max_parallel_agents === config.max_parallel_agents &&
			next.keep_computer_awake === config.keep_computer_awake
		) {
			return;
		}
		// A control callback can run before React Query paints its pending state.
		// Close the selection surface and synchronously admit only one write.
		writePending.current = true;
		setParallelOpen(false);
		save.mutate(next);
	};
	const commitIdle = () => {
		const value = Number(idleDraft);
		if (!Number.isInteger(value)) {
			setIdleDraft(String(config.idle_timeout_minutes));
			return;
		}
		const bounded = Math.min(
			MAX_IDLE_MINUTES,
			Math.max(MIN_IDLE_MINUTES, value)
		);
		setIdleDraft(String(bounded));
		if (bounded !== config.idle_timeout_minutes) {
			commit({ idle_timeout_minutes: bounded });
		}
	};

	if (configQuery.isLoading) {
		return (
			<div data-testid="acp-runtime-settings">
				<SettingsSection
					caption="Core owns the ACP process pool; these node-level controls apply to every ACP agent."
					title="ACP agent runtime"
				>
					<SettingsCard>
						<SkeletonRows />
					</SettingsCard>
				</SettingsSection>
			</div>
		);
	}

	const autoLimit = config.auto_max_parallel_agents;
	const parallelItems = [
		{ value: "auto", label: `Auto${autoLimit ? ` (${autoLimit})` : ""}` },
		...PARALLEL_OPTIONS.map((value) => ({
			value: String(value),
			label: String(value),
		})),
	];
	const effectiveLimit =
		config.effective_max_parallel_agents ??
		config.max_parallel_agents ??
		autoLimit;
	const activeAgents = config.active_agents ?? 0;

	return (
		<div data-testid="acp-runtime-settings">
			<SettingsSection
				caption="ACP sessions stay warm for faster replies, but old inactive threads are reaped and new processes wait behind a node-wide limit so they cannot accumulate without bound."
				title="ACP agent runtime"
			>
				{configQuery.isError ? (
					<SettingsNotice
						action={
							<Button
								onClick={() => void configQuery.refetch()}
								size="sm"
								variant="outline"
							>
								Retry ACP runtime settings
							</Button>
						}
						role="alert"
					>
						Could not load ACP runtime settings.
					</SettingsNotice>
				) : null}
				{/* Titles stay real <Label>s: they name the controls for assistive
				    technology, and the proofs look the switch up by that name. */}
				<SettingsGroup>
					<SettingsItem
						actions={
							<div className="flex items-center gap-2">
								<Input
									aria-label="ACP idle timeout in minutes"
									className="w-20 text-right"
									disabled={disabled}
									id={`${controlId}-acp-idle-timeout`}
									inputMode="numeric"
									max={MAX_IDLE_MINUTES}
									min={MIN_IDLE_MINUTES}
									onBlur={commitIdle}
									onChange={(event) => setIdleDraft(event.target.value)}
									onKeyDown={(event) => {
										if (event.key === "Enter") {
											event.currentTarget.blur();
										}
									}}
									purpose="numeric-setting"
									type="number"
									value={idleDraft}
								/>
								<span className="text-muted-foreground text-sm">min</span>
							</div>
						}
						description="An inactive session is killed after this many minutes to release its memory. The next message starts a new ACP process and may take longer."
						title={
							<Label
								className="font-normal"
								htmlFor={`${controlId}-acp-idle-timeout`}
							>
								{"Stop idle ACP sessions after"}
							</Label>
						}
					/>
					<SettingsItem
						actions={
							<Select
								disabled={disabled}
								items={parallelItems}
								onOpenChange={(open) =>
									setParallelOpen(open && !disabled && !writePending.current)
								}
								onValueChange={(value) =>
									commit({
										max_parallel_agents:
											value === "auto" ? null : Number(value),
									})
								}
								open={parallelOpen}
								value={
									config.max_parallel_agents === null
										? "auto"
										: String(config.max_parallel_agents)
								}
							>
								<SelectTrigger
									aria-label="Maximum parallel ACP agents"
									className="w-32"
									id={`${controlId}-acp-max-parallel`}
								>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{parallelItems.map((item) => (
										<SelectItem
											disabled={disabled}
											key={item.value}
											value={item.value}
										>
											{item.label}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						}
						description="Auto uses a conservative CPU/RAM estimate for this node. New agents wait instead of spawning when the limit is full."
						title={
							<Label
								className="font-normal"
								htmlFor={`${controlId}-acp-max-parallel`}
							>
								{"Maximum parallel ACP agents"}
							</Label>
						}
					>
						<div className="flex flex-wrap items-center gap-2 text-xs">
							<Badge variant="secondary">
								{tl("{activeAgents} active / {allowedLimit} allowed", {
									activeAgents: String(activeAgents),
									allowedLimit: String(effectiveLimit ?? "—"),
								})}
							</Badge>
							{config.hardware ? (
								<span className="text-muted-foreground">
									{tl("{physicalCores} physical · {ramSummary}", {
										physicalCores: String(config.hardware.physical_cores),
										ramSummary: formatRam(config.hardware.total_ram_bytes),
									})}
								</span>
							) : null}
						</div>
					</SettingsItem>
					<SettingsItem
						actions={
							<Switch
								aria-label="Keep this device awake while ACP agents run"
								checked={config.keep_computer_awake}
								disabled={disabled}
								id={`${controlId}-acp-keep-awake`}
								onCheckedChange={(keep_computer_awake) =>
									commit({ keep_computer_awake })
								}
							/>
						}
						description="Uses the native OS sleep-inhibition API only while a local ACP agent is active. The display may still turn off."
						title={
							<Label
								className="font-normal"
								htmlFor={`${controlId}-acp-keep-awake`}
							>
								{"Keep this device awake while agents run"}
							</Label>
						}
					/>
				</SettingsGroup>
			</SettingsSection>
		</div>
	);
}
