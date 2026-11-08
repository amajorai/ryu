// Broker settings for one environment: what happens to a request no service
// matches (refused with a hint to propose a service, or forwarded without a
// credential), whether agent runs are brokered under the refusing policy too,
// and the skills text agents read with discovery. Reading needs
// `list` on `sys/broker`, saving needs `admin`. Also shows whether the local
// proxy is listening.

import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Label } from "@ryu/ui/components/label.tsx";
import {
	NativeSelect,
	NativeSelectOption,
} from "@ryu/ui/components/native-select.tsx";
import { SkeletonRows } from "@ryu/ui/components/skeleton.tsx";
import { Switch } from "@ryu/ui/components/switch.tsx";
import { Textarea } from "@ryu/ui/components/textarea.tsx";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { sileo } from "sileo";
import {
	SettingsCard,
	SettingsSection,
} from "@/src/components/settings/shared/settings-items.tsx";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	getVaultBrokerEnvironment,
	getVaultBrokerStatus,
	putVaultBrokerEnvironment,
	type VaultBrokerEnvironmentSettings,
	type VaultBrokerUnmatchedHostPolicy,
} from "@/src/lib/api/vault-broker-console.ts";
import { vaultErrorMessage } from "./vault-errors.ts";

/** Core's cap on the skills text. */
export const MAX_SKILLS_BYTES = 64 * 1024;

const POLICY_COPY = {
	deny: "Refuse, and tell the agent how to propose a service",
	passthrough: "Forward without adding a credential",
} satisfies Record<VaultBrokerUnmatchedHostPolicy, string>;

function SettingsForm({
	environment,
	saved,
	target,
}: {
	environment: string;
	saved: VaultBrokerEnvironmentSettings;
	target: ApiTarget;
}) {
	const tl = useLiteralMessages();
	const queryClient = useQueryClient();
	const [policy, setPolicy] = useState(saved.unmatchedHostPolicy);
	const [runsUnderDeny, setRunsUnderDeny] = useState(saved.brokerRunsUnderDeny);
	const [skills, setSkills] = useState(saved.skills);
	const tooLong = new TextEncoder().encode(skills).length > MAX_SKILLS_BYTES;
	const saveMutation = useMutation({
		mutationFn: () =>
			putVaultBrokerEnvironment(target, environment, {
				brokerRunsUnderDeny: runsUnderDeny,
				skills,
				unmatchedHostPolicy: policy,
			}),
		onSuccess: async () => {
			await queryClient.invalidateQueries({
				queryKey: ["vault", "broker", "environment"],
			});
			sileo.success({ title: "Broker settings saved" });
		},
	});
	const dirty =
		policy !== saved.unmatchedHostPolicy ||
		runsUnderDeny !== saved.brokerRunsUnderDeny ||
		skills !== saved.skills;

	return (
		<form
			className="space-y-4 p-4"
			onSubmit={(event) => {
				event.preventDefault();
				saveMutation.mutate();
			}}
		>
			<div className="space-y-1.5">
				<Label htmlFor="broker-unmatched-policy">Unmatched hosts</Label>
				<NativeSelect
					className="w-full"
					id="broker-unmatched-policy"
					onChange={(event) =>
						setPolicy(
							event.target.value === "passthrough" ? "passthrough" : "deny"
						)
					}
					value={policy}
				>
					<NativeSelectOption value="deny">
						{POLICY_COPY.deny}
					</NativeSelectOption>
					<NativeSelectOption value="passthrough">
						{POLICY_COPY.passthrough}
					</NativeSelectOption>
				</NativeSelect>
			</div>
			{policy === "deny" ? (
				<div className="flex items-start justify-between gap-4">
					<div className="space-y-1">
						<Label htmlFor="broker-runs-under-deny">
							Broker agent runs in trusted folders
						</Label>
						<p className="text-muted-foreground text-xs">
							Those agents and the tools they run can then reach only the hosts
							your services cover. Agents that sign in to their model provider
							directly, and agents in untrusted folders, are never brokered.
						</p>
					</div>
					<Switch
						checked={runsUnderDeny}
						id="broker-runs-under-deny"
						onCheckedChange={setRunsUnderDeny}
					/>
				</div>
			) : null}
			<div className="space-y-1.5">
				<Label htmlFor="broker-skills">Agent skills</Label>
				<Textarea
					aria-invalid={tooLong}
					className="min-h-32"
					id="broker-skills"
					onChange={(event) => setSkills(event.target.value)}
					placeholder="How agents should use these services: endpoints, conventions, limits."
					value={skills}
				/>
				<p className="text-muted-foreground text-xs">
					{tooLong
						? "Keep the skills under 64 KiB."
						: "Agents read this with discovery. Do not put credentials here."}
				</p>
			</div>
			{saveMutation.error ? (
				<p className="text-sm text-status-destructive" role="alert">
					{vaultErrorMessage(
						saveMutation.error,
						"Could not save the settings.",
						tl
					)}
				</p>
			) : null}
			<div className="flex justify-end">
				<Button
					disabled={!dirty || tooLong || saveMutation.isPending}
					type="submit"
				>
					Save
				</Button>
			</div>
		</form>
	);
}

function ProxyStatus({ target }: { target: ApiTarget }) {
	const tl = useLiteralMessages();
	const statusQuery = useQuery({
		queryKey: ["vault", "broker", "status", target.url],
		queryFn: () => getVaultBrokerStatus(target),
	});
	const status = statusQuery.data;
	if (!status) {
		return null;
	}
	return (
		<span>
			{status.listening && status.port
				? tl("The broker proxy is listening on 127.0.0.1:{port}.", {
						port: status.port,
					})
				: tl("The broker proxy is not running. Set {env} to start it.", {
						env: status.portEnv,
					})}
		</span>
	);
}

export function BrokerSettings({
	environment,
	target,
}: {
	environment: string;
	target: ApiTarget;
}) {
	const tl = useLiteralMessages();
	const settingsQuery = useQuery({
		queryKey: ["vault", "broker", "environment", target.url, environment],
		queryFn: () => getVaultBrokerEnvironment(target, environment),
	});
	return (
		<SettingsSection
			caption={<ProxyStatus target={target} />}
			title="Environment settings"
		>
			<SettingsCard className="p-0">
				{settingsQuery.isLoading ? (
					<SkeletonRows inset="panel" rows={2} />
				) : settingsQuery.error || !settingsQuery.data ? (
					<p className="p-4 text-sm text-status-destructive">
						{vaultErrorMessage(
							settingsQuery.error,
							"Could not load the broker settings.",
							tl
						)}
					</p>
				) : (
					<SettingsForm
						environment={environment}
						key={`${environment}:${settingsQuery.data.updatedAt ?? ""}`}
						saved={settingsQuery.data}
						target={target}
					/>
				)}
			</SettingsCard>
		</SettingsSection>
	);
}
