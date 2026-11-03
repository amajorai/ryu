"use client";

import { useLiteralMessages, useOptionalI18n } from "@ryu/i18n/react";
import { Badge } from "@ryu/ui/components/badge";
import { safeMediaUrl } from "@ryu/ui/lib/safe-media-url.ts";
import type { Route } from "next";
import Link from "next/link";
import { RELEASES_PAGE } from "../download-assets.ts";
import { formatPublicationDate } from "../publication-date.ts";
import { ThemedImage } from "../themed-image.tsx";
import {
	type ChangelogFeedEntry,
	versionLabel,
} from "./changelog-feed-model.ts";

/**
 * One release in the dated feed. On wide screens the date and version chip
 * sit in a sticky left rail, and the release hangs off a vertical timeline
 * line with a dot at its date; on phones the rail folds into one line above
 * the title.
 */
export function ChangelogFeedItem({ entry }: { entry: ChangelogFeedEntry }) {
	const tl = useLiteralMessages();
	const locale = useOptionalI18n()?.locale;
	// SAFETY: the host app serves /changelog/[slug]; this shared block cannot see that app's generated typedRoutes list.
	const href = `/changelog/${entry.slug}` as Route;
	const version = versionLabel(entry.version);
	const banner = safeMediaUrl(entry.banner);
	const titleId = `release-${entry.slug}`;

	return (
		<article
			aria-labelledby={titleId}
			className="grid gap-4 md:grid-cols-[12rem_1fr] md:gap-10"
			data-release-slug={entry.slug}
			id={entry.slug}
		>
			<div className="flex flex-wrap items-center gap-3 md:sticky md:top-24 md:flex-col md:items-start md:gap-2 md:self-start md:pt-1">
				<time
					className="font-medium text-foreground text-sm tabular-nums"
					dateTime={entry.date}
				>
					{formatPublicationDate(entry.date, "long", locale)}
				</time>
				{version ? (
					<Badge
						data-slot="version-chip"
						render={
							<a
								aria-label={tl("{version} release on GitHub", { version })}
								href={`${RELEASES_PAGE}/tag/${version}`}
								rel="noopener noreferrer"
								target="_blank"
							/>
						}
						typography="numeric"
						variant="outline"
					>
						{version}
					</Badge>
				) : null}
			</div>

			{/* `data-slot` keeps the timeline line: public pages strip borders
			    from unnamed content groups. */}
			<div
				className="relative flex min-w-0 flex-col gap-4 pb-16 md:border-border md:border-s md:ps-10"
				data-slot="release-timeline"
			>
				<span
					aria-hidden="true"
					className="absolute -start-1.25 top-2 hidden size-2.5 rounded-full border-2 border-background bg-foreground md:block"
				/>
				{entry.type ? (
					<Badge
						casing="capitalized"
						className="self-start"
						data-slot="type-chip"
						variant="secondary"
					>
						{entry.type}
					</Badge>
				) : null}
				<h2
					className="text-balance font-heading font-medium text-2xl text-foreground tracking-tight md:text-3xl"
					id={titleId}
				>
					<Link className="underline-offset-4 hover:underline" href={href}>
						{entry.title}
					</Link>
				</h2>
				{entry.summary ? (
					<p className="mt-0 max-w-2xl text-pretty text-muted-foreground leading-relaxed">
						{entry.summary}
					</p>
				) : null}
				{banner ? (
					<Link
						aria-hidden="true"
						className="group mt-2 block aspect-[1200/630] w-full overflow-hidden rounded-lg bg-muted md:max-w-2xl"
						href={href}
						tabIndex={-1}
					>
						<ThemedImage
							alt=""
							className="h-full w-full object-cover transition-transform duration-300 motion-safe:group-hover:scale-[1.03]"
							darkSrc={safeMediaUrl(entry.bannerDark)}
							height={630}
							src={banner}
							unoptimized
							width={1200}
						/>
					</Link>
				) : null}
			</div>
		</article>
	);
}
