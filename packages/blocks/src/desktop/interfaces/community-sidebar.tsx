import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { cn } from "@ryu/ui/lib/utils";
import {
	Bot,
	Clock,
	Folder,
	type LucideIcon,
	UserRound,
	UsersRound,
} from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import {
	type Community,
	communityLabel,
	plural,
	posterLabel,
	redditAge,
	shortCount,
} from "./community-model.ts";
import { AgentFace, CommunityIcon } from "./community-parts.tsx";

/** The rail's surface: a soft muted block, no border or shadow, like Reddit's. */
function RailCard({
	children,
	className,
	labelledBy,
	testId,
}: {
	children: ReactNode;
	className?: string;
	labelledBy: string;
	testId?: string;
}) {
	return (
		<section
			aria-labelledby={labelledBy}
			className={cn("flex flex-col rounded-2xl bg-muted/50 py-4", className)}
			data-testid={testId}
		>
			{children}
		</section>
	);
}

function RailHeading({ children, id }: { children: ReactNode; id: string }) {
	return (
		<h2
			className="px-4 pb-2 text-muted-foreground text-xs uppercase tracking-widest"
			id={id}
		>
			{children}
		</h2>
	);
}

const KIND_LABEL: Record<Community["kind"], string> = {
	agent: "Agent community",
	profile: "Your profile",
	project: "Project",
	team: "Team",
};

const KIND_ICON: Record<Community["kind"], LucideIcon> = {
	agent: Bot,
	profile: UserRound,
	project: Folder,
	team: UsersRound,
};

function Stat({
	label,
	live = false,
	value,
}: {
	label: string;
	live?: boolean;
	value: number;
}) {
	return (
		<div className="flex flex-col">
			<dd className="order-1 font-semibold text-base text-foreground tabular-nums leading-6">
				{shortCount(value)}
			</dd>
			<dt className="order-2 flex items-center gap-1.5 text-muted-foreground text-xs">
				{live ? (
					<span aria-hidden="true" className="size-2 rounded-full bg-success" />
				) : null}
				{label}
			</dt>
		</div>
	);
}

export interface AboutCardProps {
	/** The `r/` label of an agent's own community. */
	agentLabel: (agentId: string) => string;
	community: Community;
	now: number;
	/** Set beside a post, where the card leads with a link to its community. */
	onOpenCommunity?: (community: Community) => void;
	onSelectAgent: (agentId: string) => void;
}

/**
 * Reddit's About community card: name, description, created and kind, a
 * stat row (members, working, threads), then the member list where Reddit
 * lists moderators.
 */
export function AboutCard({
	agentLabel,
	community,
	now,
	onOpenCommunity,
	onSelectAgent,
}: AboutCardProps) {
	const tl = useLiteralMessages();
	const headingId = useId();
	const membersId = useId();
	const isProfile = community.kind === "profile";
	const KindIcon = KIND_ICON[community.kind];
	return (
		<RailCard labelledBy={headingId} testId="community-about">
			{onOpenCommunity ? (
				<button
					aria-label={tl("Open {community}", {
						community: communityLabel(community),
					})}
					className="mb-3 flex items-center gap-2 self-start rounded-full px-4 font-semibold text-foreground text-sm outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/50"
					onClick={() => onOpenCommunity(community)}
					type="button"
				>
					<CommunityIcon community={community} size={32} />
					{communityLabel(community)}
				</button>
			) : null}
			<div className="flex flex-col gap-1 px-4">
				<h2
					className="font-semibold! text-base text-foreground leading-6"
					id={headingId}
				>
					{community.name}
				</h2>
				<p className="text-muted-foreground text-sm leading-5">
					{community.description}
				</p>
			</div>
			<ul className="mt-3 flex flex-col gap-1.5 px-4 text-muted-foreground text-sm">
				<li className="flex items-center gap-2">
					<KindIcon aria-hidden="true" className="size-4" strokeWidth={1.75} />
					{KIND_LABEL[community.kind]}
				</li>
				{isProfile ? null : (
					<li className="flex items-center gap-2">
						<UserRound
							aria-hidden="true"
							className="size-4"
							strokeWidth={1.75}
						/>
						Created by you
					</li>
				)}
				{community.lastActivity ? (
					<li className="flex items-center gap-2">
						<Clock aria-hidden="true" className="size-4" strokeWidth={1.75} />
						{tl("Last post {age}", {
							age: redditAge(community.lastActivity, now),
						})}
					</li>
				) : null}
			</ul>
			<dl className="mt-4 grid grid-cols-3 gap-2 px-4">
				<Stat label="Members" value={community.members.length} />
				<Stat label="Working" live value={community.workingCount} />
				<Stat label="Threads" value={community.threadCount} />
			</dl>
			{isProfile || community.members.length === 0 ? null : (
				<>
					<hr className="mx-4 my-4 border-border" />
					<RailHeading id={membersId}>Members</RailHeading>
					<ul aria-labelledby={membersId} className="flex flex-col">
						{community.members.map((agent) => (
							<li key={agent.id}>
								<button
									aria-label={
										agent.status === "working"
											? tl("Open {agent}, working", {
													agent: agentLabel(agent.id),
												})
											: tl("Open {agent}", { agent: agentLabel(agent.id) })
									}
									className="flex min-h-12 w-full items-center gap-3 px-4 py-1.5 text-left outline-none transition-colors duration-100 hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset"
									onClick={() => onSelectAgent(agent.id)}
									type="button"
								>
									<AgentFace
										agent={agent}
										ring="ring-muted"
										showWorking
										size={32}
									/>
									<span className="flex min-w-0 flex-col">
										<span className="truncate text-foreground text-sm leading-5">
											{posterLabel(agent)}
										</span>
										<span className="truncate text-muted-foreground text-xs leading-4">
											{agent.description || "Agent"}
										</span>
									</span>
								</button>
							</li>
						))}
					</ul>
				</>
			)}
		</RailCard>
	);
}

const RAIL_LIMIT = 5;

export interface CommunitiesCardProps {
	communities: readonly Community[];
	onSelect: (community: Community) => void;
}

/** Home's right rail: busiest communities first, five at a time. */
export function CommunitiesCard({
	communities,
	onSelect,
}: CommunitiesCardProps) {
	const tl = useLiteralMessages();
	const headingId = useId();
	const [expanded, setExpanded] = useState(false);
	if (communities.length === 0) {
		return null;
	}
	const shown = expanded ? communities : communities.slice(0, RAIL_LIMIT);
	return (
		<RailCard labelledBy={headingId} testId="community-rail">
			<RailHeading id={headingId}>Popular communities</RailHeading>
			<ul className="flex flex-col">
				{shown.map((community) => (
					<li key={community.key}>
						<button
							className="flex min-h-12 w-full items-center gap-3 px-4 py-1.5 text-left outline-none transition-colors duration-100 hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset"
							onClick={() => onSelect(community)}
							type="button"
						>
							<CommunityIcon
								community={community}
								ring="ring-muted"
								showWorking
								size={32}
							/>
							<span className="flex min-w-0 flex-col">
								<span className="truncate text-foreground text-sm leading-5">
									{communityLabel(community)}
								</span>
								<span className="truncate text-muted-foreground text-xs leading-4">
									{plural(community.threadCount, "thread")}
									{community.workingCount > 0
										? tl(" · {workingCount} working", {
												workingCount: community.workingCount,
											})
										: ""}
								</span>
							</span>
						</button>
					</li>
				))}
			</ul>
			{communities.length > RAIL_LIMIT ? (
				<div className="px-1.5 pt-2">
					<Button
						aria-expanded={expanded}
						onClick={() => setExpanded((value) => !value)}
						size="xs"
						variant="ghost"
					>
						{expanded ? "See less" : "See more"}
					</Button>
				</div>
			) : null}
		</RailCard>
	);
}
