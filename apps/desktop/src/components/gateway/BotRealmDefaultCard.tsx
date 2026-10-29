import { Label } from "@ryu/ui/components/label.tsx";
import { Skeleton } from "@ryu/ui/components/skeleton.tsx";
import { AgentSelectionField } from "@/components/agent-elements/input/agent-selection-field.tsx";
import { SettingsCard } from "@/src/components/settings/shared/settings-items.tsx";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	type AgentSelection,
	defaultCloudAgentSelection,
	isAgentSelectionEmpty,
} from "@/src/lib/api/preferences.ts";

/**
 * The managed-node cloud default shared by Console and the Bot realm.
 *
 * The stored value stays empty until an admin chooses a custom route. A managed
 * node still renders the effective product default, Auto cloud, so the Console
 * surface explains what Bot will do before anyone changes it.
 */
export function BotRealmDefaultCard({
	canConfigure,
	loaded,
	managed,
	onChange,
	target,
	value,
}: {
	canConfigure: boolean;
	loaded: boolean;
	managed: boolean;
	onChange: (next: AgentSelection) => void;
	target: ApiTarget;
	value: AgentSelection;
}) {
	const displayedSelection =
		managed && isAgentSelectionEmpty(value)
			? defaultCloudAgentSelection(true)
			: value;

	return (
		<div data-testid={managed ? "bot-realm-default-card" : undefined}>
			<SettingsCard className="space-y-4">
				<div className="flex flex-col gap-1.5">
					<Label size="compact" tone="muted">
						{managed ? "Bot realm default" : "Default cloud agent"}
					</Label>
					{loaded ? (
						<AgentSelectionField
							ariaLabel="Default cloud agent or model"
							disabled={!canConfigure}
							onChange={onChange}
							placeholder={
								managed
									? "Auto cloud · Ryu-managed"
									: "No cloud default — use local"
							}
							preserveRyuRoute
							target={target}
							value={displayedSelection}
						/>
					) : (
						<Skeleton className="h-8 w-full" />
					)}
					<p className="text-muted-foreground text-xs">
						{managed
							? "Organization owners and admins can choose the provider and model for every Bot chat on this managed node. When no custom value is saved, Bot uses Auto cloud and lets Ryu select the model."
							: "Normal interactive chats use this lane when set. Paid onboarding starts with Ryu on managed OpenRouter; free users can choose a configured BYOK provider or leave this unset."}
					</p>
				</div>
			</SettingsCard>
		</div>
	);
}
