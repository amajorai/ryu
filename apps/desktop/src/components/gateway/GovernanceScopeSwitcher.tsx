import {
	Tabs,
	TabsIndicator,
	TabsList,
	TabsTrigger,
} from "@ryu/ui/components/tabs.tsx";
import { z } from "zod";
import {
	SettingsGroup,
	SettingsItem,
} from "@/src/components/settings/shared/settings-items.tsx";
import type {
	GatewayGovernanceLayer,
	GovernanceScope,
} from "@/src/lib/api/governance.ts";

export type GovernanceView = "effective" | GovernanceScope;

const VIEWS: ReadonlyArray<{ label: string; value: GovernanceView }> = [
	{ label: "Effective", value: "effective" },
	{ label: "User", value: "user" },
	{ label: "Team", value: "team" },
	{ label: "Organization", value: "organization" },
	{ label: "Node", value: "node" },
];

const governanceViewSchema = z.enum([
	"effective",
	"user",
	"team",
	"organization",
	"node",
]);

const scopeHint = (
	layers: readonly GatewayGovernanceLayer[],
	value: GovernanceView
): string => {
	if (value === "effective") {
		return "Resolved from user, team, organization, then node defaults.";
	}
	return layers.find((layer) => layer.scope === value)?.writable
		? "Changes at this level override broader defaults."
		: "This level is inherited here and can only be changed by an authorized administrator.";
};

export function GovernanceScopeSwitcher({
	layers,
	onValueChange,
	value,
}: {
	layers: readonly GatewayGovernanceLayer[];
	onValueChange: (value: GovernanceView) => void;
	value: GovernanceView;
}) {
	const hint = scopeHint(layers, value);
	// Its own grouped row: a segmented control on the right, the level's meaning
	// as the iOS footer caption under the card.
	const control = (
		<Tabs
			onValueChange={(next) => {
				const parsed = governanceViewSchema.safeParse(next);
				if (parsed.success) {
					onValueChange(parsed.data);
				}
			}}
			value={value}
		>
			<TabsList
				aria-label="Configuration scope"
				manageLayout={false}
				variant="segmented"
			>
				<TabsIndicator />
				{VIEWS.map((view) => {
					const layer = layers.find((item) => item.scope === view.value);
					const unavailable =
						view.value === "effective"
							? undefined
							: (layer?.unavailableReason ??
								(layer ? undefined : "This scope is unavailable."));
					return (
						<TabsTrigger
							disabled={Boolean(unavailable)}
							key={view.value}
							title={unavailable}
							value={view.value}
						>
							{view.label}
						</TabsTrigger>
					);
				})}
			</TabsList>
		</Tabs>
	);
	return (
		<SettingsGroup>
			<SettingsItem actions={control} description={hint} title="Scope" />
		</SettingsGroup>
	);
}
