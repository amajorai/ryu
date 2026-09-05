import {
	HoverCard,
	HoverCardContent,
	HoverCardTrigger,
} from "@ryu/ui/components/hover-card";
import { cn } from "@ryu/ui/lib/utils";
import { ArrowUpRight } from "lucide-react";
import type React from "react";

/**
 * A source cited by an assistant turn, mirroring the AI SDK "InlineCitation"
 * data model. Produced from the turn's web tool parts (WebFetch `input.url`,
 * WebSearch results) — see `utils/citations.ts`.
 */
export interface Citation {
	description?: string;
	number: number;
	quote?: string;
	title: string;
	url: string;
}

function hostnameOf(url: string): string {
	try {
		return new URL(url).hostname.replace(/^www\./, "");
	} catch {
		return url;
	}
}

/** AICSS-style numbered chip used inline and in the sources footer. */
export function CitationMark({
	className,
	...props
}: React.ComponentProps<"span">) {
	return (
		<span
			className={cn(
				"inline-flex h-3 min-w-3 flex-none items-center justify-center rounded bg-muted px-0.5 align-[5.5px] font-medium text-[9px] text-muted-foreground leading-none",
				className
			)}
			{...props}
		/>
	);
}

export function InlineCitation({
	className,
	...props
}: React.ComponentProps<"span">) {
	return (
		<span className={cn("inline items-center gap-0.5", className)} {...props} />
	);
}

export function InlineCitationCard(
	props: React.ComponentProps<typeof HoverCard>
) {
	// Delays moved to InlineCitationCardTrigger: Base UI carries them on the
	// trigger, and passing them here did nothing but widen the props object.
	return <HoverCard {...props} />;
}

export interface InlineCitationCardTriggerProps {
	className?: string;
	label?: string;
	sources: string[];
}

export function InlineCitationCardTrigger({
	sources,
	label,
	className,
}: InlineCitationCardTriggerProps) {
	const primary = sources[0] ? hostnameOf(sources[0]) : "source";
	const extra = sources.length > 1 ? ` +${sources.length - 1}` : "";
	return (
		<HoverCardTrigger
			className={cn(
				"inline-flex cursor-default items-center gap-1 rounded-full border border-border bg-muted/60 px-1.5 py-0.5 align-middle font-medium text-[11px] text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground",
				className
			)}
			closeDelay={100}
			delay={120}
		>
			{label ? <span className="text-primary">{label}</span> : null}
			<span className="max-w-[140px] truncate">{primary}</span>
			{extra ? <span className="text-muted-foreground/70">{extra}</span> : null}
		</HoverCardTrigger>
	);
}

export function InlineCitationCardBody({
	className,
	...props
}: React.ComponentProps<typeof HoverCardContent>) {
	return (
		<HoverCardContent
			className={cn("w-80 max-w-[min(90vw,20rem)] p-0 text-sm", className)}
			{...props}
		/>
	);
}

export function InlineCitationSource({
	title,
	url,
	description,
	className,
}: {
	className?: string;
	description?: string;
	title: string;
	url: string;
}) {
	return (
		<div className={cn("flex flex-col gap-1 p-3", className)}>
			<a
				className="line-clamp-2 font-medium text-foreground text-sm underline-offset-2 hover:underline"
				href={url}
				rel="noopener noreferrer"
				target="_blank"
			>
				{title}
			</a>
			<span className="truncate text-muted-foreground text-xs">
				{hostnameOf(url)}
			</span>
			{description ? (
				<p className="line-clamp-3 text-muted-foreground text-xs leading-relaxed">
					{description}
				</p>
			) : null}
		</div>
	);
}

export function InlineCitationQuote({
	children,
	className,
	...props
}: React.ComponentProps<"blockquote">) {
	return (
		<blockquote
			className={cn(
				"border-border border-t px-3 py-2 text-muted-foreground text-xs italic",
				className
			)}
			{...props}
		>
			{children}
		</blockquote>
	);
}

/**
 * Inline `[n]` chip: numbered mark linking to the source, with a hover card for
 * title / host / snippet (AICSS inline-citations pattern).
 */
export function CitationMarkLink({ citation }: { citation: Citation }) {
	return (
		<InlineCitation className="mx-0.5">
			<InlineCitationCard>
				<HoverCardTrigger
					className="inline-flex h-3 min-w-3 cursor-pointer items-center justify-center rounded bg-muted px-0.5 align-[5.5px] font-medium text-[9px] text-muted-foreground leading-none no-underline transition-colors hover:bg-muted/80 hover:text-foreground"
					href={citation.url}
					rel="noopener noreferrer"
					target="_blank"
				>
					{citation.number}
				</HoverCardTrigger>
				<InlineCitationCardBody>
					<InlineCitationSource
						description={citation.description}
						title={citation.title}
						url={citation.url}
					/>
					{citation.quote ? (
						<InlineCitationQuote>{citation.quote}</InlineCitationQuote>
					) : null}
				</InlineCitationCardBody>
			</InlineCitationCard>
		</InlineCitation>
	);
}

/** Hover pill with hostname — used when a compact labeled trigger is preferred. */
export function CitationPill({ citation }: { citation: Citation }) {
	return (
		<InlineCitation>
			<InlineCitationCard>
				<InlineCitationCardTrigger
					label={String(citation.number)}
					sources={[citation.url]}
				/>
				<InlineCitationCardBody>
					<InlineCitationSource
						description={citation.description}
						title={citation.title}
						url={citation.url}
					/>
					{citation.quote ? (
						<InlineCitationQuote>{citation.quote}</InlineCitationQuote>
					) : null}
				</InlineCitationCardBody>
			</InlineCitationCard>
		</InlineCitation>
	);
}

/**
 * AICSS-style sources footer under an assistant turn that consulted the web.
 * Each row is `n · title · host ↗`. Empty when the turn used no web tools.
 */
export function CitationSources({ citations }: { citations: Citation[] }) {
	if (citations.length === 0) {
		return null;
	}
	return (
		<div className="mt-3 flex flex-col gap-1.5 border-border border-t pt-2.5">
			{citations.map((citation) => {
				const host = hostnameOf(citation.url);
				return (
					<a
						className="group/cite-ref flex min-w-0 items-center gap-1.5 text-muted-foreground text-xs leading-[18px] no-underline transition-colors hover:text-foreground"
						href={citation.url}
						key={`${citation.number}-${citation.url}`}
						rel="noopener noreferrer"
						target="_blank"
					>
						<CitationMark>{citation.number}</CitationMark>
						<span className="min-w-0 truncate font-medium text-foreground">
							{citation.title}
						</span>
						<span aria-hidden className="flex-none text-muted-foreground/70">
							·
						</span>
						<span className="flex-none whitespace-nowrap transition-colors group-hover/cite-ref:text-foreground">
							{host}
						</span>
						<span
							aria-hidden
							className="ml-[-2px] inline-flex flex-none text-muted-foreground/70 opacity-0 transition-opacity group-hover/cite-ref:opacity-100"
						>
							<ArrowUpRight className="size-2.5" />
						</span>
					</a>
				);
			})}
		</div>
	);
}
