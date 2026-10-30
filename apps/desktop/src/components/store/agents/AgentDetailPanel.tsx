// The Agents section's detail panel for one catalog agent. Split from
// AgentsCatalogSection.

import { Alert01Icon, Target01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	ListingAsideCard,
	ListingDetailShell,
	ListingHero,
	ListingInfoGrid,
	ListingSection,
	ListingStatStrip,
} from "@ryu/marketplace/catalog/detail/listing-detail-shell";
import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@ryu/ui/components/empty.tsx";
import { NativeProviderAccounts } from "@/src/components/settings/NativeProviderAccounts.tsx";
import { AgentCatalogLogo } from "@/src/lib/agent-catalog-logo.tsx";
import type { AgentCatalogEntry } from "@/src/lib/api/agents.ts";
import {
	FLAGSHIP_AGENT_ID,
	InstallButton,
	UNAVAILABLE_AGENT_REASON,
} from "./agent-list.tsx";

// The Agents section's detail panel for a catalog agent. Split from
// AgentsCatalogSection.

export function AgentDetailPanel({
	entry,
	busy,
	error,
	onInstall,
	onUninstall,
}: {
	entry: AgentCatalogEntry | null;
	busy: boolean;
	error: string | null;
	onInstall: () => void;
	onUninstall: () => void;
}) {
	if (!entry) {
		return (
			<Empty className="h-full">
				<EmptyHeader>
					<EmptyMedia variant="icon">
						<HugeiconsIcon icon={Target01Icon} />
					</EmptyMedia>
					<EmptyTitle>No agent selected</EmptyTitle>
					<EmptyDescription>
						Pick an agent on the left to review its details and install it.
					</EmptyDescription>
				</EmptyHeader>
			</Empty>
		);
	}

	const updateAvailable =
		entry.versionStatus === "behind_latest" ||
		entry.bridgeVersionStatus === "behind_latest";

	return (
		<ListingDetailShell
			actions={
				<>
					<InstallButton
						busy={busy}
						entry={entry}
						onInstall={onInstall}
						onUninstall={onUninstall}
					/>
					{error && (
						<span className="ml-auto flex items-center gap-1.5 text-sm text-status-destructive">
							<HugeiconsIcon className="size-4 shrink-0" icon={Alert01Icon} />
							{error}
						</span>
					)}
				</>
			}
			aside={
				<ListingAsideCard title="Information">
					<ListingInfoGrid
						rows={[
							{ label: "Engine", value: entry.engine ?? "—" },
							{ label: "Transport", value: entry.transport ?? "—" },
							{ label: "Registry ID", value: entry.registryId ?? "—" },
							{
								label: "On PATH",
								value:
									entry.detected === null
										? "Unknown"
										: entry.detected
											? "Yes"
											: "No",
							},
							{
								label: "Gateway",
								value: entry.gatewayBypass ? "Bypassed" : "Routed",
							},
						]}
					/>
				</ListingAsideCard>
			}
			hero={
				<ListingHero
					badges={[
						entry.added ? "Added" : "Not added",
						entry.recommended ? "Recommended" : null,
						entry.available ? null : UNAVAILABLE_AGENT_REASON,
						updateAvailable ? "Update available" : null,
					].filter((b): b is string => Boolean(b))}
					icon={
						<AgentCatalogLogo className="size-9" entry={entry} size="36px" />
					}
					name={entry.name}
					tagline={entry.description}
				/>
			}
			stats={
				<ListingStatStrip
					items={[
						{
							label: "Agent",
							sub: entry.latestVersion
								? `Latest v${entry.latestVersion}`
								: undefined,
							value: entry.installedVersion
								? `v${entry.installedVersion}`
								: (entry.latestVersion ?? "—"),
						},
						{
							label: "Bridge",
							sub: entry.latestBridgeVersion
								? `Latest v${entry.latestBridgeVersion}`
								: undefined,
							value: entry.installedBridgeVersion
								? `v${entry.installedBridgeVersion}`
								: (entry.latestBridgeVersion ?? "—"),
						},
						{ label: "Engine", value: entry.engine ?? "—" },
						{ label: "Transport", value: entry.transport ?? "—" },
						{
							label: "Status",
							value: entry.added ? "Added" : "Available",
						},
					]}
				/>
			}
		>
			<ListingSection title="About">
				<p className="text-muted-foreground text-sm leading-relaxed">
					{entry.description ?? "No description provided."}
				</p>
			</ListingSection>
			{entry.installHint ? (
				<ListingSection title="Adding this agent">
					<p className="text-muted-foreground text-sm">{entry.installHint}</p>
				</ListingSection>
			) : null}
			{entry.added && entry.id !== FLAGSHIP_AGENT_ID ? (
				<NativeProviderAccounts agentId={entry.id} key={entry.id} />
			) : null}
		</ListingDetailShell>
	);
}
