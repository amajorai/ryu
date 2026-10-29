import { Skeleton } from "@ryu/ui/components/skeleton.tsx";
import { cn } from "@ryu/ui/lib/utils";
import { ChevronDown, House, TrendingUp } from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import {
	type Community,
	type CommunityScope,
	communityLabel,
} from "./community-model.ts";
import { CommunityIcon } from "./community-parts.tsx";

const ITEM =
	"flex h-10 w-full min-w-0 items-center gap-3 rounded-lg px-4 text-left text-sm outline-none transition-colors duration-100 focus-visible:ring-2 focus-visible:ring-ring/50";

function itemTone(active: boolean): string {
	return active
		? "bg-secondary font-medium text-foreground"
		: "text-foreground hover:bg-muted";
}

function NavSection({
	children,
	label,
}: {
	children: ReactNode;
	label: string;
}) {
	const [open, setOpen] = useState(true);
	const listId = useId();
	return (
		<section className="flex flex-col">
			<h2>
				<button
					aria-controls={listId}
					aria-expanded={open}
					className="flex h-10 w-full items-center justify-between rounded-lg px-4 text-muted-foreground text-xs uppercase tracking-widest outline-none transition-colors duration-100 hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50"
					onClick={() => setOpen((value) => !value)}
					type="button"
				>
					{label}
					<ChevronDown
						aria-hidden="true"
						className={cn(
							"size-4 transition-transform duration-150 motion-reduce:transition-none",
							!open && "-rotate-90"
						)}
						strokeWidth={1.75}
					/>
				</button>
			</h2>
			<ul className={cn("flex flex-col", !open && "hidden")} id={listId}>
				{children}
			</ul>
		</section>
	);
}

function CommunityItem({
	active,
	community,
	onSelect,
}: {
	active: boolean;
	community: Community;
	onSelect: (community: Community) => void;
}) {
	return (
		<li>
			<button
				aria-current={active ? "page" : undefined}
				className={cn(ITEM, itemTone(active))}
				onClick={() => onSelect(community)}
				type="button"
			>
				<CommunityIcon
					community={community}
					ring={active ? "ring-secondary" : "ring-background"}
					showWorking
					size={32}
				/>
				<span className="truncate">{communityLabel(community)}</span>
			</button>
		</li>
	);
}

export interface CommunityNavProps {
	communities: readonly Community[];
	loading: boolean;
	onHome: () => void;
	onPopular: () => void;
	onSelect: (community: Community) => void;
	/** The scope to mark current, or null while a post or the composer is up. */
	scope: CommunityScope | null;
}

/**
 * Reddit's left rail: Home and Popular, then collapsible sections for the
 * user's communities (projects and teams) and for agents.
 */
export function CommunityNav({
	communities,
	loading,
	onHome,
	onPopular,
	onSelect,
	scope,
}: CommunityNavProps) {
	const groups = communities.filter(
		(community) => community.kind === "project" || community.kind === "team"
	);
	const agents = communities.filter((community) => community.kind === "agent");
	const activeKey = scope?.kind === "community" ? scope.key : null;
	return (
		<nav
			aria-label="Communities"
			className="flex min-h-0 flex-col gap-1 overflow-y-auto px-4 py-4"
			data-testid="community-nav"
		>
			<ul className="flex flex-col">
				<li>
					<button
						aria-current={scope?.kind === "home" ? "page" : undefined}
						className={cn(ITEM, itemTone(scope?.kind === "home"))}
						onClick={onHome}
						type="button"
					>
						<House aria-hidden="true" className="size-5" strokeWidth={1.75} />
						Home
					</button>
				</li>
				<li>
					<button
						aria-current={scope?.kind === "popular" ? "page" : undefined}
						className={cn(ITEM, itemTone(scope?.kind === "popular"))}
						onClick={onPopular}
						type="button"
					>
						<TrendingUp
							aria-hidden="true"
							className="size-5"
							strokeWidth={1.75}
						/>
						Popular
					</button>
				</li>
			</ul>
			<hr className="mx-4 my-3 border-border" />
			{loading && communities.length === 0 ? (
				<div aria-hidden="true" className="flex flex-col gap-1">
					{["one", "two", "three", "four"].map((key) => (
						<div className="flex h-10 items-center gap-3 px-4" key={key}>
							<Skeleton className="size-8 rounded-full" />
							<Skeleton className="h-3 w-32" radius="dense" />
						</div>
					))}
				</div>
			) : (
				<>
					{groups.length > 0 ? (
						<NavSection label="Communities">
							{groups.map((community) => (
								<CommunityItem
									active={community.key === activeKey}
									community={community}
									key={community.key}
									onSelect={onSelect}
								/>
							))}
						</NavSection>
					) : null}
					{groups.length > 0 && agents.length > 0 ? (
						<hr className="mx-4 my-3 border-border" />
					) : null}
					{agents.length > 0 ? (
						<NavSection label="Agents">
							{agents.map((community) => (
								<CommunityItem
									active={community.key === activeKey}
									community={community}
									key={community.key}
									onSelect={onSelect}
								/>
							))}
						</NavSection>
					) : null}
				</>
			)}
		</nav>
	);
}
