import { useLiteralMessages } from "@ryu/i18n/react";
import { EmployeeBadge } from "@ryu/ui/components/employee-badge.tsx";
import { useQuery } from "@tanstack/react-query";
import { motion } from "motion/react";
import { useTheme } from "next-themes";
import { Component, lazy, type ReactNode } from "react";
import { AGENT_IDENTITY_MODE_OPTIONS } from "@/src/components/agents/AgentIdentityModePicker.tsx";
import { AgentCatalogLogo } from "@/src/lib/agent-catalog-logo.tsx";
import {
	type MysteryAgent,
	mysteryAgentDescription,
	mysteryAgentId,
	mysteryAgentName,
} from "@/src/lib/agent-mystery-box.ts";
import { ApiError } from "@/src/lib/api/client.ts";
import {
	fetchDetail,
	type MarketplaceCard,
} from "@/src/lib/api/marketplace.ts";
import { communityAgentNotice } from "../CommunityAgents.tsx";

// The Agent Mystery Box's stage pieces: the lazy 3D scene, its WebGL fallback,
// the revealed prize card and the template disclosure.

export const MysteryBoxScene = lazy(
	() => import("@ryu/ui/components/mystery-box/mystery-box-scene.tsx")
);

/** Ribbon color of a closed box — neutral, so the tier is a surprise. */
export const CLOSED_ACCENT = "#d4d4d8";
/** How long after the lid pops the card starts flying out. */
export const REVEAL_DELAY_MS = 180;
/** The flat fallback box's rattle, standing in for the scene's `onBurst`. */
export const FLAT_BOX_OPEN_MS = 900;

export type Phase = "closed" | "opening" | "revealed" | "added";

/** WebGL can be missing (remote desktops, disabled GPU): show a flat box. */
export class SceneBoundary extends Component<
	{ children: ReactNode; fallback: ReactNode; onError: () => void },
	{ failed: boolean }
> {
	state = { failed: false };

	static getDerivedStateFromError() {
		return { failed: true };
	}

	componentDidCatch() {
		this.props.onError();
	}

	render() {
		return this.state.failed ? this.props.fallback : this.props.children;
	}
}

export function FlatBox({
	accent,
	opening,
	onActivate,
}: {
	accent: string;
	opening: boolean;
	onActivate: () => void;
}) {
	return (
		<div className="flex h-full items-center justify-center">
			<motion.button
				animate={
					opening
						? { rotate: [0, -8, 8, -12, 12, 0], scale: [1, 1.05, 1.1, 0.4] }
						: { rotate: 0, scale: 1 }
				}
				aria-label="Open the mystery box"
				className="flex size-36 items-center justify-center rounded-3xl bg-background font-semibold text-6xl"
				disabled={opening}
				onClick={onActivate}
				style={{ color: accent }}
				transition={{ duration: 0.9 }}
				type="button"
			>
				?
			</motion.button>
		</div>
	);
}

export function errorMessage(cause: unknown): string {
	if (cause instanceof ApiError && cause.serverMessage) {
		return cause.serverMessage;
	}
	return cause instanceof Error ? cause.message : String(cause);
}

export function PrizeCard({
	agent,
	ringed,
}: {
	agent: MysteryAgent;
	/** The animated metal ring is its own WebGL instance: off without WebGL. */
	ringed: boolean;
}) {
	const { resolvedTheme } = useTheme();
	const id = mysteryAgentId(agent);
	return (
		<div className="relative w-56">
			<div className="relative overflow-hidden rounded-2xl">
				<EmployeeBadge
					employeeId={id}
					logo={
						agent.kind === "runtime" ? (
							<AgentCatalogLogo
								className="size-20"
								entry={agent.entry}
								size="80px"
							/>
						) : undefined
					}
					metalTheme={resolvedTheme === "light" ? "light" : "dark"}
					name={mysteryAgentName(agent)}
					ringed={ringed}
					role={mysteryAgentDescription(agent) ?? undefined}
				/>
			</div>
		</div>
	);
}

/**
 * What an Agent Template will do with the user's accounts, shown before Add:
 * its Identity setting (from the listing's detail read, the same one the Store
 * detail panel makes) and the trust notice the Store shows above Install.
 */
export function TemplateDisclosure({ card }: { card: MarketplaceCard }) {
	const tl = useLiteralMessages();
	const detailQuery = useQuery({
		queryKey: ["marketplace", "detail", "agent", card.id],
		queryFn: () => fetchDetail("agent", card.id),
	});
	const identityMode = detailQuery.data?.identityMode ?? null;
	return (
		<div
			className="mt-1 flex max-w-md flex-col gap-1"
			data-testid="mystery-template-disclosure"
		>
			{identityMode ? (
				<p className="font-medium text-xs">
					{tl("Identity: {title}", {
						title: AGENT_IDENTITY_MODE_OPTIONS[identityMode].title,
					})}
				</p>
			) : null}
			<p className="text-muted-foreground text-xs">
				{communityAgentNotice(identityMode)}
			</p>
		</div>
	);
}
