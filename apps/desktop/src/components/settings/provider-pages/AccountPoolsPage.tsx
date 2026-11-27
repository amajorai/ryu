// The one place that manages the account pools themselves: the pool editor
// (create, rename, pick accounts, delete) and under it every agent that is on
// a pool or on Auto, with the accounts it rotates over and its backup models.
// The choice of an agent's pool stays in the agent's own settings, where its
// lock check sits; this page only reads it.

import { useLiteralMessages } from "@ryu/i18n/react";
import { Badge } from "@ryu/ui/components/badge.tsx";
import { SkeletonRows } from "@ryu/ui/components/skeleton.tsx";
import { useQuery } from "@tanstack/react-query";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import type { AccountPoolMember } from "@/src/lib/api/account-pools.ts";
import { fetchAgents } from "@/src/lib/api/agents.ts";
import type { PiProvider } from "@/src/lib/api/pi-config.ts";
import { AccountPoolsSettings } from "../AccountPoolsSettings.tsx";
import {
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "../shared/settings-items.tsx";
import { useAccountPoolCatalog } from "./ProviderAccountPools.tsx";
import { type AgentPoolUse, agentPoolUses } from "./provider-pages-model.ts";

/** "Provider: account" for one pool member, from the catalog's labels. */
export function memberLabel(
	member: AccountPoolMember,
	providers: PiProvider[]
): string {
	const provider = providers.find((entry) => entry.id === member.providerId);
	const account = provider?.accounts?.find(
		(entry) => entry.accountId === member.accountId
	);
	return `${provider?.label ?? member.providerId}: ${account?.label ?? member.accountId}`;
}

function AgentPoolRow({
	name,
	providers,
	use,
}: {
	name: string;
	providers: PiProvider[];
	use: AgentPoolUse;
}) {
	const tl = useLiteralMessages();
	const accounts =
		use.mode === "pool" && use.pool
			? use.pool.accounts
					.map((member) => memberLabel(member, providers))
					.join(", ")
			: "";
	const backups = use.backups
		.map((backup) => {
			const provider = providers.find(
				(entry) => entry.id === backup.providerId
			);
			return `${backup.model} (${provider?.label ?? backup.providerId})`;
		})
		.join(", ");
	return (
		<SettingsItem
			actions={
				<Badge variant="outline">
					{use.mode === "pool" ? (use.pool?.name ?? tl("None")) : tl("Auto")}
				</Badge>
			}
			description={
				<>
					<span className="block" data-agent-pool-accounts="">
						{use.mode === "pool"
							? accounts || tl("None")
							: tl("Auto (try every account)")}
					</span>
					{backups ? (
						<span className="block" data-agent-pool-backups="">
							{tl("Backup models")}: {backups}
						</span>
					) : null}
				</>
			}
			title={<span data-agent-pool-use={use.agentId}>{name}</span>}
		/>
	);
}

/** Every agent on a pool or on Auto. Read only. */
function PoolAgents({ providers }: { providers: PiProvider[] }) {
	const node = useActiveNode();
	const { catalog, supported } = useAccountPoolCatalog();
	const agentsQuery = useQuery({
		queryKey: ["agents", node.url],
		queryFn: () =>
			fetchAgents({
				url: node.url,
				token: node.token,
				userJwt: node.userJwt ?? null,
			}),
		staleTime: 60_000,
	});
	if (!(supported && catalog)) {
		return null;
	}
	const uses = agentPoolUses(catalog);
	const nameOf = (agentId: string) =>
		agentsQuery.data?.find((agent) => agent.id === agentId)?.name ?? agentId;
	return (
		<SettingsSection title="Agents">
			{agentsQuery.isPending ? (
				<SkeletonRows label="Loading agents…" rows={2} />
			) : null}
			{!agentsQuery.isPending && uses.length === 0 ? (
				<p className="py-3 text-muted-foreground text-sm" role="status">
					No agent uses a pool yet.
				</p>
			) : null}
			{!agentsQuery.isPending && uses.length > 0 ? (
				<SettingsGroup>
					{uses.map((use) => (
						<AgentPoolRow
							key={use.agentId}
							name={nameOf(use.agentId)}
							providers={providers}
							use={use}
						/>
					))}
				</SettingsGroup>
			) : null}
		</SettingsSection>
	);
}

export function AccountPoolsPage({ providers }: { providers: PiProvider[] }) {
	return (
		<>
			<AccountPoolsSettings heading={false} providers={providers} />
			<PoolAgents providers={providers} />
		</>
	);
}
