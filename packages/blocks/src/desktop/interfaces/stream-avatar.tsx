import {
	Avatar,
	AvatarFallback,
	AvatarImage,
} from "@ryu/ui/components/avatar.tsx";
import {
	DitherAvatar,
	ditherAvatarSeed,
} from "@ryu/ui/components/dither-kit/avatar.tsx";
import { cn } from "@ryu/ui/lib/utils";
import type { InterfaceAgent } from "@ryuhq/protocol/interfaces";

/** The pixel sizes Stream draws faces at. */
export type StreamAvatarSize = 12 | 14 | 18 | 20 | 36 | 84;

const SIZE: Record<StreamAvatarSize, string> = {
	12: "size-3",
	14: "size-3.5",
	18: "size-4.5",
	20: "size-5",
	36: "size-9",
	84: "size-21",
};

/**
 * An agent's picture, else the generative dither tile the rest of Ryu falls
 * back to (seeded by id so it survives renames). Decorative: the name next to
 * it, or the control around it, carries the accessible name.
 */
export function StreamAvatar({
	agent,
	className,
	name,
	size,
}: {
	agent: InterfaceAgent | undefined;
	className?: string;
	name: string;
	size: StreamAvatarSize;
}) {
	const seed = ditherAvatarSeed({ id: agent?.id, name: agent?.name ?? name });
	return (
		<Avatar aria-hidden="true" className={cn(SIZE[size], className)}>
			{agent?.avatarUrl ? <AvatarImage alt="" src={agent.avatarUrl} /> : null}
			<AvatarFallback appearance="artwork" className="overflow-hidden bg-muted">
				<DitherAvatar animate={false} className="size-full" name={seed} />
			</AvatarFallback>
		</Avatar>
	);
}

/** Face positions inside the 36px cluster, by how many faces it holds. */
const CLUSTER: Record<
	1 | 2 | 3,
	{ left: string; size: StreamAvatarSize; top: string }[]
> = {
	1: [{ left: "left-2", size: 20, top: "top-2" }],
	2: [
		{ left: "left-0.5", size: 20, top: "top-2" },
		{ left: "left-3.5", size: 20, top: "top-2" },
	],
	3: [
		{ left: "left-0", size: 18, top: "top-1" },
		{ left: "left-5", size: 14, top: "top-0" },
		{ left: "left-4.5", size: 12, top: "top-5.5" },
	],
};

/**
 * The reply facepile under the thread line: up to three faces clustered in
 * the avatar column, the way the reference draws who replied.
 */
export function StreamFacepile({ agents }: { agents: InterfaceAgent[] }) {
	const shown = agents.slice(0, 3);
	const count = shown.length;
	if (count === 0) {
		return <span aria-hidden="true" className="block size-9" />;
	}
	const slots = CLUSTER[count as 1 | 2 | 3];
	return (
		<span aria-hidden="true" className="relative block size-9 shrink-0">
			{shown.map((agent, index) => {
				const slot = slots[index] ?? slots[0];
				return (
					<StreamAvatar
						agent={agent}
						className={cn("absolute ring-2 ring-card", slot?.left, slot?.top)}
						key={agent.id}
						name={agent.name}
						size={slot?.size ?? 20}
					/>
				);
			})}
		</span>
	);
}

/** A flat overlapping row of faces, for profile and suggestion meta lines. */
export function StreamFaceRow({ agents }: { agents: InterfaceAgent[] }) {
	if (agents.length === 0) {
		return null;
	}
	return (
		<span aria-hidden="true" className="flex shrink-0 -space-x-1.5">
			{agents.slice(0, 3).map((agent) => (
				<StreamAvatar
					agent={agent}
					className="ring-2 ring-card"
					key={agent.id}
					name={agent.name}
					size={18}
				/>
			))}
		</span>
	);
}
