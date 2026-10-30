import { Key01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import type { Dispatch, SetStateAction } from "react";
import {
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "@/src/components/settings/shared/settings-items.tsx";
import type { GatewayEgressConfig } from "@/src/lib/api/gateway.ts";
import {
	ProviderBrandLogo,
	svglForProvider,
} from "@/src/lib/provider-brand.tsx";

/** Which egress pool each connected provider sends its traffic through. */
export function EgressProviderAssignments({
	assignment,
	connected,
	disabled,
	egress,
	persist,
	provider,
	selectClass,
	setAssignment,
	setProvider,
	unsupported,
}: {
	assignment: string;
	connected: string[];
	disabled: boolean;
	egress: GatewayEgressConfig | null;
	persist: (
		change: (current: GatewayEgressConfig) => GatewayEgressConfig
	) => Promise<boolean>;
	provider: string;
	selectClass: string;
	setAssignment: Dispatch<SetStateAction<string>>;
	setProvider: Dispatch<SetStateAction<string>>;
	unsupported: boolean;
}) {
	const tl = useLiteralMessages();
	return egress && !unsupported ? (
		<SettingsSection title="Provider assignments">
			<SettingsGroup>
				{Object.entries(egress.assignments).map(([id, poolName]) => (
					<SettingsItem
						actions={
							<Button
								aria-label={tl("Remove proxy assignment for {id}", { id })}
								disabled={disabled}
								onClick={() => {
									void persist((current) => {
										const assignments = { ...current.assignments };
										delete assignments[id];
										return { ...current, assignments };
									});
								}}
								size="sm"
								variant="ghost"
							>
								Remove
							</Button>
						}
						key={id}
						title={
							<>
								{svglForProvider(id) ? (
									<ProviderBrandLogo providerKey={id} size={16} />
								) : (
									<HugeiconsIcon
										className="size-4 text-muted-foreground"
										icon={Key01Icon}
									/>
								)}
								<span>
									{id} → {poolName}
								</span>
							</>
						}
					/>
				))}
				<SettingsItem
					actions={
						<div className="flex flex-wrap items-center gap-2">
							<label className="flex items-center gap-1.5 text-muted-foreground text-xs">
								Provider
								<select
									className={selectClass}
									disabled={disabled}
									onChange={(event) => setProvider(event.target.value)}
									value={provider}
								>
									<option value="">Select provider</option>
									{connected.map((id) => (
										<option key={id} value={id}>
											{id}
										</option>
									))}
								</select>
							</label>
							<label className="flex items-center gap-1.5 text-muted-foreground text-xs">
								Pool
								<select
									className={selectClass}
									disabled={disabled}
									onChange={(event) => setAssignment(event.target.value)}
									value={assignment}
								>
									<option value="">Select pool</option>
									{Object.keys(egress.pools).map((id) => (
										<option key={id} value={id}>
											{id}
										</option>
									))}
								</select>
							</label>
							<Button
								disabled={disabled || !provider || !assignment}
								onClick={() => {
									void persist((current) => ({
										...current,
										assignments: {
											...current.assignments,
											[provider]: assignment,
										},
									}));
								}}
								size="sm"
								variant="secondary"
							>
								Assign
							</Button>
						</div>
					}
					title="New assignment"
				/>
			</SettingsGroup>
		</SettingsSection>
	) : null;
}
