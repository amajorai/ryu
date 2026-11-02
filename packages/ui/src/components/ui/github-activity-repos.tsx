"use client";

// The repository half of `github-activity.tsx`: the public push-event fetch
// and the avatar, row and chevron the repo panel draws.

import { safeHttpUrl } from "@ryu/ui/lib/safe-url.ts";
import { cn } from "@ryu/ui/lib/utils.ts";
import { motion, type Transition } from "motion/react";
import * as React from "react";
import { formatNumber } from "../../lib/number-format.ts";
import {
	type Contribution,
	fetchCalendar,
	type RepoContribution,
} from "./github-activity-model.ts";

/** Repositories the collapsed panel stacks as avatars. */
export const STACK_LIMIT = 3;

const EVENTS_API = "https://api.github.com/users";

interface PushEvent {
	payload?: { commits?: unknown[] };
	repo?: { name: string };
	type: string;
}

async function fetchRepos(login: string): Promise<RepoContribution[]> {
	const res = await fetch(`${EVENTS_API}/${login}/events/public?per_page=100`);
	if (!res.ok) {
		return [];
	}

	const events: PushEvent[] = await res.json();
	const counts = new Map<string, number>();

	for (const event of events) {
		if (event.type !== "PushEvent" || !event.repo) {
			continue;
		}
		const commits = event.payload?.commits?.length ?? 1;
		counts.set(event.repo.name, (counts.get(event.repo.name) ?? 0) + commits);
	}

	return [...counts.entries()]
		.sort(([, a], [, b]) => b - a)
		.slice(0, STACK_LIMIT)
		.map(([fullName, count]) => {
			const separator = fullName.indexOf("/");
			const owner = separator >= 0 ? fullName.slice(0, separator) : "";
			const name = separator >= 0 ? fullName.slice(separator + 1) : fullName;
			return {
				name,
				count,
				href: `https://github.com/${fullName}`,
				// github has no repo logo, only an owner avatar, so own repos use the initial
				logo:
					owner.toLowerCase() === login.toLowerCase() ? undefined : (
						// eslint-disable-next-line @next/next/no-img-element
						<img alt="" src={`https://github.com/${owner}.png?size=64`} />
					),
			};
		});
}

export function useGitHubUser(login?: string) {
	const [data, setData] = React.useState<{
		contributions: Contribution[];
		repos: RepoContribution[];
	}>();

	React.useEffect(() => {
		if (!login) {
			return;
		}
		let active = true;

		Promise.all([fetchCalendar(login), fetchRepos(login)])
			.then(([contributions, repos]) => {
				if (active && contributions) {
					setData({ contributions, repos });
				}
			})
			.catch(() => {});

		return () => {
			active = false;
		};
	}, [login]);

	return data;
}

export const Avatar = ({
	repo,
	layoutId,
	transition,
	className,
}: {
	repo: RepoContribution;
	layoutId: string;
	transition: Transition;
	className?: string;
}) => (
	<motion.span
		className={cn(
			"type-caption grid size-7 shrink-0 place-items-center overflow-hidden rounded-full bg-muted font-medium text-muted-foreground uppercase",
			"[&_img]:size-full [&_img]:object-cover [&_svg]:size-full",
			className
		)}
		layoutId={layoutId}
		transition={transition}
	>
		{repo.logo ?? repo.name.charAt(0)}
	</motion.span>
);

export const RepoRow = ({
	repo,
	layoutId,
	transition,
}: {
	repo: RepoContribution;
	layoutId: string;
	transition: Transition;
}) => {
	const safeHref = safeHttpUrl(repo.href);
	const className =
		"flex items-center gap-3 rounded-xl mx-2 px-2 py-2 transition-colors hover:bg-foreground/5";

	const content = (
		<>
			<Avatar layoutId={layoutId} repo={repo} transition={transition} />
			<span className="flex-1 truncate text-foreground text-sm">
				{repo.name}
			</span>
			<span className="text-foreground/70 text-sm tabular-nums">
				{formatNumber(repo.count)}
			</span>
		</>
	);

	return safeHref ? (
		<a
			className={className}
			href={safeHref}
			rel="noopener noreferrer"
			target="_blank"
		>
			{content}
		</a>
	) : (
		<div className={className}>{content}</div>
	);
};

export const Chevron = ({
	open,
	transition,
}: {
	open: boolean;
	transition: Transition;
}) => (
	<motion.svg
		animate={{ rotate: open ? 180 : 0 }}
		aria-hidden
		className="size-7 text-muted-foreground"
		fill="none"
		initial={false}
		stroke="currentColor"
		strokeLinecap="round"
		strokeLinejoin="round"
		strokeWidth="1.5"
		transition={transition}
		viewBox="0 0 24 24"
	>
		<circle cx="12" cy="12" r="10" />
		<path d="m16 10-4 4-4-4" />
	</motion.svg>
);
