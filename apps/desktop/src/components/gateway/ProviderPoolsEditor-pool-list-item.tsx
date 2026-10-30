import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { SettingsItem } from "@/src/components/settings/shared/settings-items.tsx";
import { type Pool, strategyLabel } from "./ProviderPoolsEditor-options.ts";

export function ProviderPoolListItem({
	poolName,
	pool,
	disabled,
	saving,
	startEdit,
	remove,
}: {
	poolName: string;
	pool: Pool;
	disabled: boolean;
	saving: boolean;
	startEdit: (poolName: string) => void;
	remove: (poolName: string) => Promise<void>;
}) {
	const tl = useLiteralMessages();
	return (
		<SettingsItem
			actions={
				<div className="flex flex-wrap items-center gap-2">
					<span className="font-mono text-muted-foreground text-xs">
						pool:{poolName}
					</span>
					<Button
						aria-label={tl("Edit pool {poolName}", { poolName })}
						disabled={disabled || saving}
						onClick={() => startEdit(poolName)}
						size="sm"
						variant="ghost"
					>
						Edit
					</Button>
					<Button
						aria-label={tl("Remove pool {poolName}", { poolName })}
						disabled={disabled || saving}
						onClick={() => remove(poolName)}
						size="sm"
						variant="ghost"
					>
						Remove
					</Button>
				</div>
			}
			title={
				<span className="block min-w-0">
					<span className="block truncate" title={poolName}>
						{poolName}
					</span>
					<span className="mt-0.5 block text-muted-foreground text-xs">
						{strategyLabel(pool.strategy)} ·{" "}
						{pool.strategy === "round_robin" && (pool.sticky_limit ?? 1) > 1
							? `${tl("{sticky_limit} new sessions per member ·", { sticky_limit: pool.sticky_limit })} `
							: null}
						{tl("{count} active members", {
							count: String(
								pool.members.filter((member) => member.enabled).length
							),
						})}
					</span>
				</span>
			}
		/>
	);
}
