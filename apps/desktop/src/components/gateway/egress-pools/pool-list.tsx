import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { Switch } from "@ryu/ui/components/switch.tsx";
import type { Dispatch, SetStateAction } from "react";
import {
	SettingsCard,
	SettingsGroup,
	SettingsItem,
} from "@/src/components/settings/shared/settings-items.tsx";
import type { GatewayEgressConfig } from "@/src/lib/api/gateway.ts";
import type { DraftPool } from "./shared.ts";

/** The saved egress pools, each editable or removable. */
export function EgressPoolList({
	begin,
	disabled,
	egress,
	persist,
	unsupported,
}: {
	begin: (poolName?: string) => void;
	disabled: boolean;
	egress: GatewayEgressConfig | null;
	persist: (
		change: (current: GatewayEgressConfig) => GatewayEgressConfig
	) => Promise<boolean>;
	unsupported: boolean;
}) {
	const tl = useLiteralMessages();
	return egress && !unsupported ? (
		Object.keys(egress.pools).length === 0 ? (
			<SettingsCard>
				<p className="py-3 text-muted-foreground text-sm">
					No proxy pools yet.
				</p>
			</SettingsCard>
		) : (
			<SettingsGroup>
				{Object.entries(egress.pools).map(([poolName, current]) => (
					<SettingsItem
						actions={
							<div className="flex items-center gap-2">
								<span className="text-muted-foreground text-sm">
									{current.include_direct
										? tl("{count} proxies + direct", {
												count: current.endpoints.filter(
													(endpoint) => endpoint.enabled
												).length,
											})
										: tl("{count} proxies", {
												count: current.endpoints.filter(
													(endpoint) => endpoint.enabled
												).length,
											})}
								</span>
								<Button
									aria-label={tl("Edit proxy pool {poolName}", { poolName })}
									disabled={disabled}
									onClick={() => begin(poolName)}
									size="sm"
									variant="ghost"
								>
									Edit
								</Button>
								<Button
									aria-label={tl("Remove proxy pool {poolName}", { poolName })}
									disabled={disabled}
									onClick={() => {
										void persist((value) => {
											if (Object.values(value.assignments).includes(poolName)) {
												throw new Error(
													"Remove provider assignments before deleting this pool."
												);
											}
											const pools = { ...value.pools };
											delete pools[poolName];
											return { ...value, pools };
										});
									}}
									size="sm"
									variant="ghost"
								>
									Remove
								</Button>
							</div>
						}
						key={poolName}
						title={poolName}
					/>
				))}
			</SettingsGroup>
		)
	) : null;
}

/** The name and rotation settings of the pool being edited. */
export function EgressPoolSettings({
	disabled,
	name,
	pool,
	setName,
	setPool,
}: {
	disabled: boolean;
	name: string;
	pool: DraftPool;
	setName: Dispatch<SetStateAction<string>>;
	setPool: Dispatch<SetStateAction<DraftPool>>;
}) {
	return (
		<SettingsGroup>
			<SettingsItem
				actions={
					<div>
						<Input
							className="h-8 w-56"
							disabled={disabled}
							id="egress-pool-name"
							onChange={(event) => setName(event.target.value)}
							value={name}
						/>
					</div>
				}
				title={<label htmlFor="egress-pool-name">Pool name</label>}
			/>
			<SettingsItem
				actions={
					<Switch
						checked={pool.include_direct}
						disabled={disabled}
						id="egress-direct"
						onCheckedChange={(checked) =>
							setPool((current) => ({
								...current,
								include_direct: checked,
								direct_fallback_only: checked
									? current.direct_fallback_only
									: false,
							}))
						}
					/>
				}
				title={<label htmlFor="egress-direct">Include direct connection</label>}
			/>
			<SettingsItem
				actions={
					<Switch
						checked={pool.direct_fallback_only ?? false}
						disabled={disabled || !pool.include_direct}
						id="egress-direct-fallback"
						onCheckedChange={(checked) =>
							setPool((current) => ({
								...current,
								direct_fallback_only: checked,
							}))
						}
					/>
				}
				title={
					<label htmlFor="egress-direct-fallback">
						Use direct only as fallback
					</label>
				}
			/>
		</SettingsGroup>
	);
}
