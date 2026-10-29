import { cn } from "@ryu/ui/lib/utils";
import { createContext, type ReactNode, useContext, useMemo } from "react";
import {
	brigadeColors,
	CHEF_AVATAR_HAT,
	CHEF_AVATAR_INK,
	chefColors,
	hashId,
} from "./kitchen-palette.ts";

/**
 * A chef's face in the DOM layer: a disc in the chef's jacket colour with a
 * white toque, the same colour the chef wears at their station, so a ticket,
 * a name plate and a chef in the scene map to each other at a glance. The
 * colour slots come from the brigade (the same de-duplicated slots the
 * scene uses), shared through context.
 */

const ChefSlots = createContext<ReadonlyMap<string, number> | null>(null);

export function ChefColorsProvider({
	agentIds,
	children,
}: {
	agentIds: readonly string[];
	children: ReactNode;
}) {
	const key = agentIds.join("\n");
	// biome-ignore lint/correctness/useExhaustiveDependencies: the joined key is the identity of the brigade.
	const slots = useMemo(() => brigadeColors(agentIds), [key]);
	return <ChefSlots.Provider value={slots}>{children}</ChefSlots.Provider>;
}

/** The colour slot for a chef: the brigade's, or the id's own pick. */
export function useChefSlot(agentId: string): number {
	const slots = useContext(ChefSlots);
	return slots?.get(agentId) ?? hashId(agentId);
}

export function ChefAvatar({
	agentId,
	className,
	size = 20,
}: {
	agentId: string;
	className?: string;
	size?: number;
}) {
	const { body, shade } = chefColors(useChefSlot(agentId));
	return (
		<svg
			aria-hidden="true"
			className={cn("block shrink-0", className)}
			height={size}
			viewBox="0 0 20 20"
			width={size}
		>
			<circle cx="10" cy="10" fill={body} r="10" />
			<rect fill={shade} height="2" rx="0.5" width="9" x="5.5" y="12" />
			<path
				d="M6 12 V9.6 A2.6 2.6 0 0 1 7.4 4.9 A2.9 2.9 0 0 1 12.6 4.9 A2.6 2.6 0 0 1 14 9.6 V12 Z"
				fill={CHEF_AVATAR_HAT}
				stroke={CHEF_AVATAR_INK}
				strokeOpacity="0.18"
				strokeWidth="0.75"
			/>
		</svg>
	);
}
