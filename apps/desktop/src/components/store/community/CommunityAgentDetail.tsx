import { Alert01Icon, Target01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import {
	ListingAsideCard,
	ListingDetailShell,
	ListingHero,
	ListingInfoGrid,
	ListingSection,
	ListingStatStrip,
} from "@ryu/marketplace/catalog/detail/listing-detail-shell";
import { Badge } from "@ryu/ui/components/badge.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import { formatNumber } from "@ryu/ui/lib/number-format.ts";
import { useQuery } from "@tanstack/react-query";
import { AGENT_IDENTITY_MODE_OPTIONS } from "@/src/components/agents/AgentIdentityModePicker.tsx";
import type {
	AgentIdentityMode,
	AgentInstallDisclosure,
} from "@/src/lib/api/agents.ts";
import {
	fetchDetail,
	type MarketplaceCard,
} from "@/src/lib/api/marketplace.ts";
import {
	CommunityAgentAction,
	communityAgentNotice,
	priceLabel,
	verificationLabel,
} from "./community-agent-parts.tsx";

/** One "the agent asked for this and did not get it" row. */
export function RequiresRow({
	label,
	values,
}: {
	label: string;
	values: string[];
}) {
	if (values.length === 0) {
		return null;
	}
	return (
		<div className="flex flex-col gap-1">
			<span className="font-medium text-xs">{label}</span>
			<div className="flex flex-wrap gap-1">
				{values.map((value) => (
					<Badge key={value} typography="normal" variant="outline">
						{value}
					</Badge>
				))}
			</div>
		</div>
	);
}

export interface CommunityAgentDetailProps {
	busy: boolean;
	card: MarketplaceCard;
	/** The Identity setting of the agent this listing was installed as, read
	 *  from the created record. Null until it is installed in this session. */
	installedIdentityMode?: AgentIdentityMode | null;
	onBuy: () => void;
	onInstall: () => void;
	/** Open the installed agent's editor at Account access. Omitted by hosts
	 *  that cannot open a tab, which then show no link. */
	onOpenAccountAccess?: () => void;
	/** How many publisher Space bindings were dropped on that install. */
	requestedSpaceCount: number;
	/** What Core stripped when this listing was installed, or null if it has not
	 *  been installed in this session. Every entry is something to grant by hand. */
	requires: AgentInstallDisclosure | null;
}

export function CommunityAgentDetail({
	busy,
	card,
	installedIdentityMode = null,
	onBuy,
	onInstall,
	onOpenAccountAccess,
	requires,
	requestedSpaceCount,
}: CommunityAgentDetailProps) {
	const tl = useLiteralMessages();
	// The listing's rich preview (capabilities, example prompts, publisher). A
	// separate public read, so a failure degrades to the card's own fields rather
	// than blanking the panel.
	const detailQuery = useQuery({
		queryKey: ["marketplace", "detail", "agent", card.id],
		queryFn: () => fetchDetail("agent", card.id),
	});
	const detail = detailQuery.data ?? null;
	const verification = verificationLabel(card);
	const description = detail?.description ?? card.description;
	// What the agent really got wins once installed; before that, the listing.
	const identityMode =
		installedIdentityMode ??
		requires?.identityMode ??
		detail?.identityMode ??
		null;
	const identityLabel = identityMode
		? AGENT_IDENTITY_MODE_OPTIONS[identityMode].title
		: null;

	return (
		<ListingDetailShell
			actions={
				<CommunityAgentAction
					busy={busy}
					card={card}
					onBuy={onBuy}
					onInstall={onInstall}
				/>
			}
			aside={
				<ListingAsideCard title="Information">
					<ListingInfoGrid
						rows={[
							{ label: "Publisher", value: card.author ?? "Unknown" },
							{ label: "Version", value: card.version },
							{ label: "Listing ID", value: card.id },
							{
								label: "Price",
								value: (
									<span className="font-mono tabular-nums">
										{priceLabel(card)}
									</span>
								),
							},
							{ label: "Identity", value: identityLabel ?? "Not stated" },
							{ label: "Provenance", value: verification ?? "Unknown" },
							{
								label: "Reviews",
								value:
									card.ratingCount > 0
										? `${card.ratingAverage.toFixed(1)} (${formatNumber(card.ratingCount)})`
										: "None yet",
							},
						]}
					/>
				</ListingAsideCard>
			}
			hero={
				<ListingHero
					badges={[
						"Agent Template",
						card.category,
						verification,
						card.firstParty ? "First party" : null,
					].filter((badge): badge is string => Boolean(badge))}
					icon={
						<HugeiconsIcon className="size-9 opacity-90" icon={Target01Icon} />
					}
					name={card.name}
					tagline={card.description}
				/>
			}
			notice={
				<div className="flex items-start gap-2 rounded-2xl bg-secondary/60 p-3 text-xs">
					<HugeiconsIcon
						className="mt-0.5 size-4 shrink-0 text-muted-foreground"
						icon={Alert01Icon}
					/>
					<p className="text-muted-foreground">
						{communityAgentNotice(identityMode)}
					</p>
				</div>
			}
			stats={
				<ListingStatStrip
					items={[
						{ label: "Version", value: card.version },
						{ label: "Publisher", value: card.author ?? "—" },
						{
							label: "Rating",
							sub: card.ratingCount > 0 ? `${card.ratingCount} reviews` : "",
							value:
								card.ratingCount > 0 ? card.ratingAverage.toFixed(1) : "New",
						},
						{ label: "Price", value: priceLabel(card) },
						{ label: "Kind", value: "Agent Template" },
					]}
				/>
			}
		>
			<ListingSection title="About">
				<p className="text-muted-foreground text-sm leading-relaxed">
					{description ?? "No description provided."}
				</p>
			</ListingSection>

			{identityMode ? (
				<ListingSection title="Identity">
					<div className="flex items-start gap-3">
						<HugeiconsIcon
							className="mt-0.5 size-5 shrink-0 text-muted-foreground"
							icon={AGENT_IDENTITY_MODE_OPTIONS[identityMode].icon}
						/>
						<div className="flex flex-col gap-0.5">
							<span className="font-medium text-sm">{identityLabel}</span>
							<p className="text-muted-foreground text-sm">
								{AGENT_IDENTITY_MODE_OPTIONS[identityMode].description}
							</p>
						</div>
					</div>
				</ListingSection>
			) : null}

			{detail && detail.capabilities.length > 0 ? (
				<ListingSection title="What it expects to use">
					<div className="flex flex-wrap gap-1">
						{detail.capabilities.map((capability) => (
							<Badge key={capability} typography="normal" variant="outline">
								{capability}
							</Badge>
						))}
					</div>
					<p className="mt-2 text-muted-foreground text-xs">
						Declarations from the publisher. Nothing here is installed or
						enabled by adding the agent.
					</p>
				</ListingSection>
			) : null}

			{detail && detail.examplePrompts.length > 0 ? (
				<ListingSection title="Try it with">
					<ul className="flex flex-col gap-1 text-muted-foreground text-sm">
						{detail.examplePrompts.map((prompt) => (
							<li key={prompt}>“{prompt}”</li>
						))}
					</ul>
				</ListingSection>
			) : null}

			{requires ? (
				<ListingSection title="Set this up yourself">
					<p className="text-muted-foreground text-sm">
						The agent is installed. These are the things it asked for that an
						install cannot grant — open the agent to decide on each one.
					</p>
					{onOpenAccountAccess ? (
						<div className="mt-3 flex flex-col items-start gap-2">
							<p className="text-muted-foreground text-xs">
								{identityMode === "individual"
									? "Connect accounts of its own under Account access."
									: "It can use your connected accounts until you limit which ones under Account access."}
							</p>
							<Button onClick={onOpenAccountAccess} size="sm" variant="outline">
								Choose account access
							</Button>
						</div>
					) : null}
					<div className="mt-3 flex flex-col gap-3">
						<RequiresRow label="Tools it expects" values={requires.tools} />
						<RequiresRow
							label="Plugins it expects (not installed)"
							values={requires.requiredPlugins}
						/>
						<RequiresRow
							label="Composio actions (not enabled)"
							values={requires.composioActions}
						/>
						<RequiresRow
							label="Identity profiles (not bound)"
							values={requires.identityProfileIds}
						/>
						<RequiresRow
							label="Memory levels (not granted)"
							values={requires.memoryReadLevels}
						/>
						{requestedSpaceCount > 0 ? (
							<p className="text-muted-foreground text-xs">
								{tl(
									"It asked for {requestedSpaceCount, plural, one {{countText} Space} other {{countText} Spaces}} of the publisher's. Those do not exist here; pick your own in the agent's Memory settings.",
									{
										countText: String(requestedSpaceCount),
										requestedSpaceCount,
									}
								)}
							</p>
						) : null}
						{requires.memoryWriteEnabled ? (
							<p className="text-muted-foreground text-xs">
								It asked to write memories. Turn that on yourself if you want
								it.
							</p>
						) : null}
						{requires.policyId ? (
							<p className="text-muted-foreground text-xs">
								It named the Gateway policy{" "}
								<span className="font-mono">{requires.policyId}</span>. Your
								node's own policy applies instead.
							</p>
						) : null}
						{requires.remoteAvatarUrl ? (
							<p className="text-muted-foreground text-xs">
								Its avatar was a remote image, which was dropped so opening the
								agent does not call the publisher's server.
							</p>
						) : null}
						{requires.systemPromptTruncated ? (
							<p className="text-muted-foreground text-xs">
								Its instructions were longer than the limit and were truncated.
							</p>
						) : null}
					</div>
				</ListingSection>
			) : null}
		</ListingDetailShell>
	);
}
