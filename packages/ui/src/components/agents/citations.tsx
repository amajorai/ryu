"use client";

import { AgentDisclosure } from "@ryu/ui/components/agents/agent-disclosure";
import { EASE_OUT, SPRING_LAYOUT, SPRING_SWAP } from "@ryu/ui/lib/ease";
import { getFaviconUrl } from "@ryu/ui/lib/favicon";
import { cn } from "@ryu/ui/lib/utils";
import { BookOpenText, ChevronDown, ExternalLink, Globe2 } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { type ReactNode, useCallback, useId, useState } from "react";

export interface CitationItem {
	domain?: ReactNode;
	id: string;
	title: ReactNode;
	url?: string;
}

export interface CitationsProps {
	citations: CitationItem[];
	className?: string;
	defaultOpen?: boolean;
	idPrefix?: string;
	onOpenChange?: (open: boolean) => void;
	open?: boolean;
	title?: ReactNode;
}

export interface CitationProps {
	citationId: string;
	className?: string;
	/** Must match the related Citations idPrefix. */
	idPrefix: string;
	index: number;
}

export interface CitationListProps {
	citations: CitationItem[];
	className?: string;
	idPrefix?: string;
}

export interface CitationStackProps {
	citations: CitationItem[];
	className?: string;
	limit?: number;
}

function citationTargetId(prefix: string, citationId: string) {
	return `${prefix}-${citationId.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
}

export function Citation({
	citationId,
	index,
	idPrefix,
	className,
}: CitationProps) {
	return (
		<a
			aria-label={`View citation ${index}`}
			className={cn(
				"mx-0.5 inline-flex min-w-4 -translate-y-0.5 items-center justify-center rounded-md bg-muted/60 px-1 py-0.5 font-medium text-[10px] text-muted-foreground leading-none no-underline outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
				className
			)}
			href={`#${citationTargetId(idPrefix, citationId)}`}
		>
			{index}
		</a>
	);
}

export function CitationFavicon({
	url,
	className,
}: {
	url?: string;
	className?: string;
}) {
	const favicon = url ? getFaviconUrl(url) : null;
	const [failedUrl, setFailedUrl] = useState<string | null>(null);

	return (
		<span
			aria-hidden="true"
			className={cn(
				"grid size-5 shrink-0 place-items-center text-muted-foreground",
				className
			)}
		>
			{favicon && failedUrl !== favicon ? (
				// biome-ignore lint/performance/noImgElement: Dynamic cross-site favicons keep this framework-agnostic registry component portable.
				<img
					alt=""
					className="size-4 rounded-sm object-contain"
					height={16}
					onError={() => setFailedUrl(favicon)}
					referrerPolicy="no-referrer"
					src={favicon}
					width={16}
				/>
			) : (
				<Globe2 className="size-3.5" />
			)}
		</span>
	);
}

export function CitationStack({
	citations,
	limit = 3,
	className,
}: CitationStackProps) {
	return (
		<span aria-hidden="true" className={cn("flex -space-x-1.5", className)}>
			{citations.slice(0, limit).map((citation) => (
				<CitationFavicon
					className="size-6 rounded-full bg-background ring-2 ring-background"
					key={citation.id}
					url={citation.url}
				/>
			))}
		</span>
	);
}

function CitationRow({
	citation,
	index,
	idPrefix,
}: {
	citation: CitationItem;
	index: number;
	idPrefix: string;
}) {
	const content = (
		<>
			<CitationFavicon url={citation.url} />
			<span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2 gap-y-0.5">
				<span className="truncate font-medium text-foreground/80 text-sm transition-colors group-hover/citation:text-foreground">
					{citation.title}
				</span>
				{citation.domain ? (
					<span className="min-w-0 truncate text-muted-foreground/60 text-xs">
						{citation.domain}
					</span>
				) : null}
			</span>
			<span className="flex shrink-0 items-center gap-1.5">
				<span className="grid size-5 place-items-center rounded-md bg-foreground/[0.05] font-medium text-[10px] text-muted-foreground tabular-nums">
					{index}
				</span>
				{citation.url ? (
					<ExternalLink className="size-3.5 text-muted-foreground/40 transition-colors group-hover/citation:text-muted-foreground" />
				) : null}
			</span>
		</>
	);
	const className =
		"group/citation flex items-center gap-2 rounded-md px-1.5 py-1 outline-none focus-visible:ring-2 focus-visible:ring-ring";
	const id = citationTargetId(idPrefix, citation.id);

	return citation.url ? (
		<a
			className={className}
			href={citation.url}
			id={id}
			rel="noreferrer noopener"
			target="_blank"
		>
			{content}
		</a>
	) : (
		<div className={className} id={id}>
			{content}
		</div>
	);
}

export function CitationList({
	citations,
	idPrefix,
	className,
}: CitationListProps) {
	const reduce = useReducedMotion() ?? false;
	const baseId = useId();
	const resolvedPrefix =
		idPrefix ?? `citation-list-${baseId.replace(/:/g, "")}`;

	return (
		<div className={cn("grid gap-0.5", className)}>
			<AnimatePresence mode="popLayout">
				{citations.map((citation, index) => (
					<motion.div
						animate={{ opacity: 1, y: 0 }}
						exit={reduce ? { opacity: 0 } : { opacity: 0, y: -3 }}
						initial={reduce ? { opacity: 1 } : { opacity: 0, y: 6 }}
						key={citation.id}
						layout="position"
						transition={
							reduce
								? { duration: 0 }
								: {
										opacity: { duration: 0.18, ease: EASE_OUT },
										y: SPRING_LAYOUT,
										layout: SPRING_LAYOUT,
									}
						}
					>
						<CitationRow
							citation={citation}
							idPrefix={resolvedPrefix}
							index={index + 1}
						/>
					</motion.div>
				))}
			</AnimatePresence>
		</div>
	);
}

export function Citations({
	citations,
	title = "Sources",
	open,
	defaultOpen = false,
	onOpenChange,
	idPrefix,
	className,
}: CitationsProps) {
	const reduce = useReducedMotion() ?? false;
	const baseId = useId();
	const contentId = `${baseId}-content`;
	const resolvedPrefix = idPrefix ?? `citation-${baseId.replace(/:/g, "")}`;
	const [internalOpen, setInternalOpen] = useState(defaultOpen);
	const currentOpen = open ?? internalOpen;
	const setOpen = useCallback(
		(next: boolean) => {
			if (open === undefined) {
				setInternalOpen(next);
			}
			onOpenChange?.(next);
		},
		[onOpenChange, open]
	);

	return (
		<div className={cn("w-full text-sm", className)}>
			<button
				aria-controls={contentId}
				aria-expanded={currentOpen}
				className="group -ml-1 flex min-h-8 items-center gap-2 rounded-lg px-1 text-left text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
				onClick={() => setOpen(!currentOpen)}
				type="button"
			>
				<BookOpenText className="size-4" />
				<span className="font-medium">{title}</span>
				<span className="rounded-full bg-muted px-1.5 py-0.5 font-medium text-[10px] tabular-nums">
					{citations.length}
				</span>
				<motion.span
					animate={{ rotate: currentOpen ? 180 : 0 }}
					aria-hidden="true"
					className="text-muted-foreground/60"
					transition={reduce ? { duration: 0 } : SPRING_SWAP}
				>
					<ChevronDown className="size-3.5" />
				</motion.span>
			</button>

			<AgentDisclosure id={contentId} open={currentOpen}>
				<CitationList
					citations={citations}
					className="mt-1"
					idPrefix={resolvedPrefix}
				/>
			</AgentDisclosure>
		</div>
	);
}
