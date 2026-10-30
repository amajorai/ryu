import { Download01Icon, ShoppingCart01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { AGENT_IDENTITY_MODE_OPTIONS } from "@/src/components/agents/AgentIdentityModePicker.tsx";
import type { AgentIdentityMode } from "@/src/lib/api/agents.ts";
import {
	formatPricingLabel,
	type MarketplaceCard,
} from "@/src/lib/api/marketplace.ts";

/**
 * The trust notice above the install control. Its account sentence follows the
 * mode the agent arrives with; `null` (a listing that does not report one) gets
 * the sentence that holds for every mode.
 */
export function communityAgentNotice(mode: AgentIdentityMode | null): string {
	const lead =
		"Written by another user, not by Ryu. Adding this Agent Template copies its instructions, model preference and Identity setting into a new agent of your own. It gets none of your credentials, Spaces or Composio actions.";
	if (mode === "individual") {
		return `${lead} Set to Its own identity, it works with accounts of its own and never uses yours.`;
	}
	const limit =
		"You can limit which of your accounts it may use under Account access after adding it.";
	if (mode === "managed" || mode === "mixed") {
		return `${lead} Set to ${AGENT_IDENTITY_MODE_OPTIONS[mode].title}, it can use your connected accounts like an agent you create. ${limit}`;
	}
	return `${lead} ${limit}`;
}

/** Readable label for a listing's provenance verdict. */
export function verificationLabel(card: MarketplaceCard): string | null {
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

export function priceLabel(card: MarketplaceCard): string {
	return card.pricing ? formatPricingLabel(card.pricing) : "Free";
}

export function CommunityAgentAction({
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
	const tl = useLiteralMessages();
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
				{tl("Add")}
			</Button>
		</div>
	);
}
