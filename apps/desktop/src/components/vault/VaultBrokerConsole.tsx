// The broker console views beside Requests: Sessions, Activity (discovered
// hosts and the request log) and Settings, scoped to one environment picked
// here. Each view loads only while it is shown.

import { Label } from "@ryu/ui/components/label.tsx";
import {
	NativeSelect,
	NativeSelectOption,
} from "@ryu/ui/components/native-select.tsx";
import { useQuery } from "@tanstack/react-query";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import { listVaultEnvironments } from "@/src/lib/api/vault.ts";
import { BrokerActivity } from "./VaultBrokerActivity.tsx";
import { BrokerSessions } from "./VaultBrokerSessions.tsx";
import { BrokerSettings } from "./VaultBrokerSettings.tsx";

export type BrokerConsoleView = "sessions" | "activity" | "settings";

/** Environment slugs to offer: the node's list, always including `current`. */
export function environmentChoices(
	listed: { name: string; slug: string }[] | undefined,
	current: string
): { label: string; value: string }[] {
	const choices = (listed ?? []).map((item) => ({
		label: item.name || item.slug,
		value: item.slug,
	}));
	if (!choices.some((choice) => choice.value === current)) {
		choices.unshift({ label: current, value: current });
	}
	return choices;
}

export function BrokerConsole({
	environment,
	onEnvironmentChange,
	target,
	view,
}: {
	environment: string;
	onEnvironmentChange: (environment: string) => void;
	target: ApiTarget;
	view: BrokerConsoleView;
}) {
	const environmentsQuery = useQuery({
		queryKey: ["vault", "environments", target.url],
		queryFn: () => listVaultEnvironments(target),
	});
	const choices = environmentChoices(
		environmentsQuery.data?.environments,
		environment
	);
	return (
		<div className="space-y-6">
			<div className="flex items-center gap-2">
				<Label htmlFor="broker-environment">Environment</Label>
				<NativeSelect
					id="broker-environment"
					onChange={(event) => onEnvironmentChange(event.target.value)}
					size="sm"
					value={environment}
				>
					{choices.map((choice) => (
						<NativeSelectOption key={choice.value} value={choice.value}>
							{choice.label}
						</NativeSelectOption>
					))}
				</NativeSelect>
			</div>
			{view === "sessions" ? (
				<BrokerSessions environment={environment} target={target} />
			) : null}
			{view === "activity" ? (
				<BrokerActivity environment={environment} target={target} />
			) : null}
			{view === "settings" ? (
				<BrokerSettings environment={environment} target={target} />
			) : null}
		</div>
	);
}
