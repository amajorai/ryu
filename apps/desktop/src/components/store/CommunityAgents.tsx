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
//
// One account setting does travel: the Identity setting ("Acts as you", "Its own
// identity", "Both"). It names whose accounts the agent works with, never which,
// and the installed agent starts with no account limit, exactly like an agent the
// user creates. So the detail shows the mode BEFORE install, and the notice says
// plainly that an "Acts as you" or "Both" agent can use the user's connected
// accounts until they limit it under Account access.

import StoreCatalogCard from "@ryu/marketplace/catalog/chrome/store-catalog-card";
import {
	StoreCardGrid,
	useStoreViewMode,
} from "@ryu/marketplace/catalog/chrome/store-catalog-layout";
import { storeItemContextMenu } from "@ryu/marketplace/catalog/chrome/store-item-action";
import StoreShelfHeading from "@ryu/marketplace/catalog/chrome/store-shelf-heading";
import { Badge } from "@ryu/ui/components/badge.tsx";
import { Spinner } from "@ryu/ui/components/spinner.tsx";
import { AgentBadgeCard } from "@/src/components/agents/AgentBadgeCard.tsx";
import type { MarketplaceCard } from "@/src/lib/api/marketplace.ts";
import { CommunityAgentAction } from "./community/community-agent-parts.tsx";

export {
	CommunityAgentDetail,
	type CommunityAgentDetailProps,
} from "./community/CommunityAgentDetail.tsx";
export { communityAgentNotice } from "./community/community-agent-parts.tsx";

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
						<Spinner className="size-3.5" />
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
									<Badge typography="normal" variant="outline">
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
