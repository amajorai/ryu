// apps/desktop/src/components/store/CommunityAgents.tsx
//
// Agent Templates: the shelf and detail panel for customized agent definitions
// PUBLISHED by other users, shown inside the Store's Agents tab next to the ACP
// runtimes.
//
// The two are not the same thing and the tab must not let them read as the same
// thing. A runtime (Claude Code, Codex, the flagship Ryu) is a vendor program
// this app knows how to drive. An Agent Template is a CONFIGURATION someone
// customized — instructions, a model preference, and a list of things it expects
// the installer to already have. So the shelf sits under its own heading, every
// card carries a "Community" chip, and the detail panel leads with a trust notice
// BEFORE the install control (that is what `ListingDetailShell`'s `notice` slot
// exists for).
//
// Installing never grants anything. Core creates a new local agent from the
// published template and strips the privilege-bearing bindings — identities,
// Composio actions, memory/Spaces, the Gateway policy — returning them as
// `requires`. Those come back here as "Set this up yourself", which is the whole
// point: the agent asked, the user decides, in their own editor, on their own
// accounts.

import {
	Alert01Icon,
	Download01Icon,
	ShoppingCart01Icon,
	Target01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import StoreCatalogCard from "@ryu/marketplace/catalog/chrome/store-catalog-card";
import {
	StoreCardGrid,
	useStoreViewMode,
} from "@ryu/marketplace/catalog/chrome/store-catalog-layout";
import { storeItemContextMenu } from "@ryu/marketplace/catalog/chrome/store-item-action";
import StoreShelfHeading from "@ryu/marketplace/catalog/chrome/store-shelf-heading";
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
import { Spinner } from "@ryu/ui/components/spinner.tsx";
import { formatNumber } from "@ryu/ui/lib/number-format.ts";
import { useQuery } from "@tanstack/react-query";
import { AgentBadgeCard } from "@/src/components/agents/AgentBadgeCard.tsx";
import type { AgentInstallDisclosure } from "@/src/lib/api/agents.ts";
import {
	fetchDetail,
	formatPricingLabel,
	type MarketplaceCard,
} from "@/src/lib/api/marketplace.ts";

/** Readable label for a listing's provenance verdict. */
function verificationLabel(card: MarketplaceCard): string | null {
	switch (card.verification) {
		case "verified":
			return "Signed";
		case "invalid":
			return "Signature invalid";
		case "unsigned":
			return "Unsigned";
		default:
			return null;
	}
}

function priceLabel(card: MarketplaceCard): string {
	return card.pricing ? formatPricingLabel(card.pricing) : "Free";
}

function CommunityAgentAction({
	busy,
	card,
	onBuy,
	onInstall,
}: {
	busy: boolean;
	card: MarketplaceCard;
	onBuy: () => void;
	onInstall: () => void;
}) {
	return (
		<div className="flex items-center gap-1">
			{card.pricing ? (
				<Button
					disabled={busy}
					onClick={(event) => {
						event.stopPropagation();
						onBuy();
					}}
					size="sm"
					variant="ghost"
				>
					<HugeiconsIcon className="size-4" icon={ShoppingCart01Icon} />
					<span className="font-mono tabular-nums">{priceLabel(card)}</span>
				</Button>
			) : null}
			<Button
				loading={busy}
				onClick={(event) => {
					event.stopPropagation();
					onInstall();
				}}
				size="sm"
				variant="ghost"
			>
				{!busy && <HugeiconsIcon className="size-4" icon={Download01Icon} />}
				Add
			</Button>
		</div>
	);
}

export interface CommunityAgentsShelfProps {
	agents: MarketplaceCard[];
	/** Listing id whose install/purchase is in flight, or null. */
	busyId: string | null;
	error: string | null;
	loading: boolean;
	onBuy: (card: MarketplaceCard) => void;
	onInstall: (card: MarketplaceCard) => void;
	onSelect: (card: MarketplaceCard) => void;
	selectedId: string | null;
}

/**
 * The community shelf. Renders nothing at all when there is nothing to show —
 * an empty or unreachable marketplace must never push an empty state into a tab
 * whose runtimes loaded fine.
 */
export function CommunityAgentsShelf({
	agents,
	busyId,
	error,
	loading,
	onBuy,
	onInstall,
	onSelect,
	selectedId,
}: CommunityAgentsShelfProps) {
	const view = useStoreViewMode()?.mode ?? "showcase";
	if (error || (agents.length === 0 && !loading)) {
		return null;
	}
	return (
		<section className="mb-6">
			<StoreShelfHeading
				action={
					loading && agents.length === 0 ? (
						<Spinner className="size-3.5 text-muted-foreground" />
					) : null
				}
				className="mb-3"
				description="Customized Agent Templates written and published by other people — instructions and settings, not programs. Adding one creates a new agent from the template; it turns nothing on."
			>
				Agent Templates
			</StoreShelfHeading>
			<StoreCardGrid>
				{agents.map((card) => {
					const action = (
						<CommunityAgentAction
							busy={busyId === card.id}
							card={card}
							onBuy={() => onBuy(card)}
							onInstall={() => onInstall(card)}
						/>
					);
					const contextMenu = storeItemContextMenu({
						installed: false,
						onInstall: () => onInstall(card),
					});
					if (view === "showcase") {
						return (
							<AgentBadgeCard
								action={action}
								contextMenu={contextMenu}
								employeeId={card.id}
								footer={
									<Badge className="font-normal" variant="outline">
										{card.author ?? "Community"}
									</Badge>
								}
								key={card.id}
								name={card.name}
								onOpen={() => onSelect(card)}
								role={card.description}
								selected={card.id === selectedId}
							/>
						);
					}
					return (
						<StoreCatalogCard
							action={action}
							contextMenu={contextMenu}
							description={card.description}
							iconUrl={card.iconUrl}
							key={card.id}
							name={card.name}
							onClick={() => onSelect(card)}
							seedId={card.id}
							selected={card.id === selectedId}
						/>
					);
				})}
			</StoreCardGrid>
		</section>
	);
}

/** One "the agent asked for this and did not get it" row. */
function RequiresRow({ label, values }: { label: string; values: string[] }) {
	if (values.length === 0) {
		return null;
	}
	return (
		<div className="flex flex-col gap-1">
			<span className="font-medium text-xs">{label}</span>
			<div className="flex flex-wrap gap-1">
				{values.map((value) => (
					<Badge className="font-normal" key={value} variant="outline">
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
	onBuy: () => void;
	onInstall: () => void;
	/** How many publisher Space bindings were dropped on that install. */
	requestedSpaceCount: number;
	/** What Core stripped when this listing was installed, or null if it has not
	 *  been installed in this session. Every entry is something to grant by hand. */
	requires: AgentInstallDisclosure | null;
}

export function CommunityAgentDetail({
	busy,
	card,
	onBuy,
	onInstall,
	requires,
	requestedSpaceCount,
}: CommunityAgentDetailProps) {
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
						Written by another user, not by Ryu. Adding this Agent Template
						copies its instructions and model preference into a new agent of
						your own. It never gains your credentials, your Spaces, or your
						connected accounts — anything it needs, you grant yourself
						afterwards.
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

			{detail && detail.capabilities.length > 0 ? (
				<ListingSection title="What it expects to use">
					<div className="flex flex-wrap gap-1">
						{detail.capabilities.map((capability) => (
							<Badge className="font-normal" key={capability} variant="outline">
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
								It asked for {requestedSpaceCount} Space
								{requestedSpaceCount === 1 ? "" : "s"} of the publisher's. Those
								do not exist here; pick your own in the agent's Memory settings.
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
