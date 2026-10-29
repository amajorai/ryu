"use client";

import { safeMediaUrl } from "@ryu/ui/lib/safe-media-url.ts";
import { cn } from "@ryu/ui/lib/utils.ts";
import type { Route } from "next";
import Image from "next/image";
import Link from "next/link";
import { useState } from "react";
import { formatPublicationDate } from "./publication-date.ts";

/**
 * One item in a featured tier: a blog post, a changelog release, or anything
 * else with a page, a date, and a card image. `image` is the item's own banner
 * when it has one; `fallbackImage` (the page's generated social card) takes
 * over when there is no banner or the banner fails to load.
 */
export interface FeaturedUpdateData {
	date: string;
	fallbackImage?: string;
	href: string;
	image?: string;
	key: string;
	/** Short collection name shown before the date ("Blog", "Changelog"). */
	label?: string;
	title: string;
}

/** OG cards are 1200x630, so the frame matches them and banners crop lightly. */
const IMAGE_FRAME_CLASS =
	"aspect-[1200/630] w-full overflow-hidden rounded-md bg-muted";

/**
 * The card image with a broken-image guard: a failed banner falls back to the
 * generated card, and if that fails too the frame stays as a muted block.
 */
function FeaturedUpdateImage({
	alt,
	fallbackImage,
	image,
}: {
	alt: string;
	fallbackImage?: string;
	image?: string;
}) {
	const sources = [safeMediaUrl(image), safeMediaUrl(fallbackImage)].filter(
		(source): source is string => Boolean(source)
	);
	const [failedCount, setFailedCount] = useState(0);
	const src = sources[failedCount];

	return (
		<div className={IMAGE_FRAME_CLASS}>
			{src ? (
				<Image
					alt={alt}
					className="h-full w-full object-cover transition-transform duration-200 motion-safe:group-hover:scale-105"
					height={630}
					key={src}
					onError={() => setFailedCount((count) => count + 1)}
					src={src}
					unoptimized
					width={1200}
				/>
			) : null}
		</div>
	);
}

function FeaturedUpdateMeta({ item }: { item: FeaturedUpdateData }) {
	return (
		<p className="flex items-center gap-2 text-muted-foreground text-sm">
			{item.label ? (
				<>
					<span>{item.label}</span>
					<span aria-hidden="true">&bull;</span>
				</>
			) : null}
			<time className="tabular-nums" dateTime={item.date}>
				{formatPublicationDate(item.date, "short")}
			</time>
		</p>
	);
}

/** Which row of the featured tier a card sits in. */
type FeaturedTier = "lead" | "pair" | "trio";

/**
 * The tier of the item at `index`: the first leads, the next two pair up, and
 * every later one sits in rows of three.
 */
export function featuredTierAt(index: number): FeaturedTier {
	if (index === 0) {
		return "lead";
	}
	return index < 3 ? "pair" : "trio";
}

/** The grid is six columns from `md`, so pairs span three and trios two. */
const TIER_CELL_CLASS: Record<FeaturedTier, string> = {
	lead: "md:col-span-6",
	pair: "md:col-span-3",
	trio: "md:col-span-2",
};

const TIER_TITLE_CLASS: Record<FeaturedTier, string> = {
	lead: "text-2xl leading-[1.2] tracking-[-0.03em] md:text-[1.75rem] lg:text-4xl",
	pair: "text-xl leading-[1.25]",
	trio: "text-lg leading-[1.3]",
};

/** One card: the image, then the label and date, then the title. */
function FeaturedUpdateCard({
	item,
	tier,
	titleAs: Title,
}: {
	item: FeaturedUpdateData;
	tier: FeaturedTier;
	titleAs: "h2" | "h3";
}) {
	return (
		<Link
			className={cn(
				"group grid gap-5",
				tier === "lead" &&
					"lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] lg:items-end lg:gap-10"
			)}
			href={
				/* SAFETY: callers build `href` from their own route families (/blog/<slug>, /changelog/<slug>); Next documents this cast for nonliteral hrefs. */ item.href as Route
			}
		>
			<FeaturedUpdateImage
				alt={item.title}
				fallbackImage={item.fallbackImage}
				image={item.image}
			/>
			<div className="flex flex-col gap-3">
				<FeaturedUpdateMeta item={item} />
				<Title
					className={cn(
						"text-balance font-heading font-medium text-foreground underline-offset-4 group-hover:underline",
						TIER_TITLE_CLASS[tier]
					)}
				>
					{item.title}
				</Title>
			</div>
		</Link>
	);
}

/**
 * The featured tier of an index, shared by the blog index and the home page
 * "Latest updates": the first item large, the next two side by side, then
 * rows of three, each with its image. One column on phones, the full layout
 * from tablet width. Callers render whatever follows (a compact list)
 * themselves, so this only lays out the cards it is given.
 */
export function FeaturedUpdates({
	className,
	items,
	titleAs = "h3",
}: {
	className?: string;
	items: readonly FeaturedUpdateData[];
	/** The card title's heading level under the page's own headings. */
	titleAs?: "h2" | "h3";
}) {
	if (items.length === 0) {
		return null;
	}
	return (
		<ul
			className={cn("grid gap-x-8 gap-y-12 md:grid-cols-6", className)}
			data-slot="featured-updates"
		>
			{items.map((item, index) => {
				const tier = featuredTierAt(index);
				return (
					<li className={TIER_CELL_CLASS[tier]} data-tier={tier} key={item.key}>
						<FeaturedUpdateCard item={item} tier={tier} titleAs={titleAs} />
					</li>
				);
			})}
		</ul>
	);
}
