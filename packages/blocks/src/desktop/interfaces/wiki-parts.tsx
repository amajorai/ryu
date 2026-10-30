import { useLiteralMessages } from "@ryu/i18n/react";
import {
	DitherAvatar,
	ditherAvatarSeed,
} from "@ryu/ui/components/dither-kit/avatar.tsx";
import { cn } from "@ryu/ui/lib/utils";
import type { InterfaceAgent } from "@ryuhq/protocol/interfaces";
import { AnimatePresence, motion } from "motion/react";
import {
	createContext,
	type MouseEvent,
	type ReactNode,
	useContext,
	useState,
} from "react";
import { useReducedMotion } from "./reduced-motion.ts";
import type { WikiRoute, WikiSection, WikiSegment } from "./wiki-model.ts";
import { markMatches, sameRoute } from "./wiki-model.ts";

export {
	Infobox,
	InfoboxHeader,
	InfoboxRow,
} from "./wiki-parts-infobox.tsx";
export { WikiSkeleton } from "./wiki-parts-skeleton.tsx";

// ---------------------------------------------------------------------------
// Navigation context: every wiki link reaches the shell through this
// ---------------------------------------------------------------------------

export interface WikiNav {
	current: WikiRoute;
	go: (route: WikiRoute) => void;
	/** Prefix for in-page anchors, unique per mounted wiki. */
	idPrefix: string;
}

const NavContext = createContext<WikiNav | null>(null);

export const WikiNavProvider = NavContext.Provider;

export function useWikiNav(): WikiNav {
	const nav = useContext(NavContext);
	if (!nav) {
		throw new Error("Wiki parts must render inside WikiNavProvider");
	}
	return nav;
}

/** A stable in-app href, so links read and behave as links. */
export function routeHref(route: WikiRoute): string {
	switch (route.kind) {
		case "agent":
		case "group":
		case "thread":
			return `#wiki/${route.kind}/${encodeURIComponent(route.id)}`;
		case "index":
			return `#wiki/category/${route.index}`;
		case "search":
			return `#wiki/search/${encodeURIComponent(route.query)}`;
		default:
			return `#wiki/${route.kind}`;
	}
}

export const LINK =
	"rounded-[2px] text-primary decoration-1 underline-offset-2 outline-none hover:underline focus-visible:underline focus-visible:ring-2 focus-visible:ring-ring";

/** An internal wiki link: a real anchor that navigates inside the wiki. */
export function WikiLink({
	bold,
	children,
	className,
	keepLinkStyle,
	route,
}: {
	bold?: boolean;
	children: ReactNode;
	className?: string;
	/** Style as a link even when it points at the page being read (a history row). */
	keepLinkStyle?: boolean;
	route: WikiRoute;
}) {
	const nav = useWikiNav();
	const current = !keepLinkStyle && sameRoute(nav.current, route);
	const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
		event.preventDefault();
		nav.go(route);
	};
	return (
		<a
			aria-current={current ? "page" : undefined}
			className={cn(
				LINK,
				bold && "font-semibold",
				current && "text-foreground",
				className
			)}
			href={routeHref(route)}
			onClick={onClick}
		>
			{children}
		</a>
	);
}

/** A link-styled button for actions that do not navigate (Talk, hide). */
export function WikiAction({
	children,
	className,
	label,
	onClick,
}: {
	children: ReactNode;
	className?: string;
	label?: string;
	onClick: () => void;
}) {
	return (
		<button
			aria-label={label}
			className={cn(LINK, "cursor-pointer", className)}
			onClick={onClick}
			type="button"
		>
			{children}
		</button>
	);
}

/** Render prose segments with real links. */
export function WikiText({ segments }: { segments: WikiSegment[] }) {
	return (
		<>
			{segments.map((segment, index) => {
				const key = `${index}-${segment.text}`;
				if (segment.kind === "link") {
					return (
						<WikiLink bold={segment.bold} key={key} route={segment.route}>
							{segment.text}
						</WikiLink>
					);
				}
				if (segment.kind === "bold") {
					return (
						<b className="font-semibold" key={key}>
							{segment.text}
						</b>
					);
				}
				return <span key={key}>{segment.text}</span>;
			})}
		</>
	);
}

/** Text with the query's words highlighted, for search and suggestions. */
export function Marked({ query, value }: { query: string; value: string }) {
	return (
		<>
			{markMatches(value, query).map((mark, index) =>
				mark.match ? (
					<mark
						className="rounded-[2px] bg-primary/15 text-foreground"
						key={`${index}-${mark.text}`}
					>
						{mark.text}
					</mark>
				) : (
					<span key={`${index}-${mark.text}`}>{mark.text}</span>
				)
			)}
		</>
	);
}

// ---------------------------------------------------------------------------
// Logo
// ---------------------------------------------------------------------------

/** The wiki's mark: a ruled globe drawn in the theme's foreground. */
export function WikiMark({ className }: { className?: string }) {
	return (
		<svg
			aria-hidden="true"
			className={className}
			fill="none"
			stroke="currentColor"
			strokeWidth={1.25}
			viewBox="0 0 32 32"
		>
			<circle cx="16" cy="16" r="13.5" />
			<ellipse cx="16" cy="16" rx="6" ry="13.5" />
			<path d="M2.5 16h27M4.5 9h23M4.5 23h23M16 2.5v27" />
		</svg>
	);
}

// ---------------------------------------------------------------------------
// Avatars
// ---------------------------------------------------------------------------

/** A square agent portrait for infoboxes and the featured article. */
export function WikiPortrait({
	agent,
	className,
	size,
}: {
	agent: InterfaceAgent;
	className?: string;
	size: number;
}) {
	const style = { height: size, width: size };
	if (agent.avatarUrl) {
		return (
			<img
				alt=""
				className={cn("block object-cover", className)}
				height={size}
				src={agent.avatarUrl}
				style={style}
				width={size}
			/>
		);
	}
	return (
		<span
			aria-hidden="true"
			className={cn("block overflow-hidden bg-muted", className)}
			style={style}
		>
			<DitherAvatar
				animate={false}
				className="size-full"
				name={ditherAvatarSeed({ id: agent.id, name: agent.name })}
			/>
		</span>
	);
}

// ---------------------------------------------------------------------------
// Sections and table of contents
// ---------------------------------------------------------------------------

export function sectionAnchor(prefix: string, id: string): string {
	return `${prefix}-${id}`;
}

export function WikiSectionHeading({
	children,
	id,
}: {
	children: ReactNode;
	id: string;
}) {
	const nav = useWikiNav();
	return (
		<h2
			className="mt-6 mb-2 scroll-mt-4 overflow-hidden border-border border-b pb-1 font-normal font-serif text-[22px] text-foreground leading-8"
			id={sectionAnchor(nav.idPrefix, id)}
		>
			{children}
		</h2>
	);
}

/** Scroll a section into view inside the wiki's own scroller. */
export function scrollToSection(prefix: string, id: string, smooth: boolean) {
	const target = document.getElementById(sectionAnchor(prefix, id));
	target?.scrollIntoView({
		behavior: smooth ? "smooth" : "auto",
		block: "start",
	});
}

/** The collapsible "Contents" box that sits under the lead. */
export function WikiToc({ sections }: { sections: WikiSection[] }) {
	const nav = useWikiNav();
	const reduceMotion = useReducedMotion();
	const [open, setOpen] = useState(true);
	const listId = `${nav.idPrefix}-toc`;
	if (sections.length < 2) {
		return null;
	}
	return (
		<nav
			aria-label="Contents"
			className="mt-4 inline-block min-w-56 border border-border bg-muted/40 px-3 py-2 text-sm"
		>
			<div className="flex items-baseline justify-center gap-2">
				<h2 className="font-semibold text-sm">Contents</h2>
				<span className="text-[13px] text-muted-foreground">
					[
					<WikiAction
						className="text-[13px]"
						label={open ? "Hide contents" : "Show contents"}
						onClick={() => setOpen((value) => !value)}
					>
						{open ? "hide" : "show"}
					</WikiAction>
					]
				</span>
			</div>
			<AnimatePresence initial={false}>
				{open ? (
					<motion.ol
						animate={{ height: "auto", opacity: 1 }}
						className="overflow-hidden"
						exit={{ height: 0, opacity: 0 }}
						id={listId}
						initial={{ height: 0, opacity: 0 }}
						transition={
							reduceMotion
								? { duration: 0 }
								: { duration: 0.16, ease: "easeOut" }
						}
					>
						{sections.map((section, index) => (
							<li className="flex gap-2 pt-1 first:pt-2" key={section.id}>
								<span className="w-3 text-muted-foreground tabular-nums">
									{index + 1}
								</span>
								<a
									className={LINK}
									href={`#${sectionAnchor(nav.idPrefix, section.id)}`}
									onClick={(event) => {
										event.preventDefault();
										scrollToSection(nav.idPrefix, section.id, !reduceMotion);
									}}
								>
									{section.label}
								</a>
							</li>
						))}
					</motion.ol>
				) : null}
			</AnimatePresence>
		</nav>
	);
}

/** The categories box at the foot of an article. */
export function CatLinks({ segments }: { segments: WikiSegment[] }) {
	if (segments.length === 0) {
		return null;
	}
	return (
		<div className="clear-both mt-8 border border-border bg-muted/40 px-2 py-1.5 text-[13px] leading-5">
			<span className="font-semibold">Categories:</span>{" "}
			<ul className="inline">
				{segments.map((segment, index) => (
					<li
						className="inline after:px-1.5 after:text-muted-foreground after:content-['|'] last:after:content-none"
						key={`${index}-${segment.text}`}
					>
						<WikiText segments={[segment]} />
					</li>
				))}
			</ul>
		</div>
	);
}

/** "This page was last edited on ..." */
export function WikiFooter({ edited }: { edited: string | null }) {
	const tl = useLiteralMessages();
	return (
		<footer className="clear-both mt-6 border-border border-t pt-3 pb-8 text-muted-foreground text-xs leading-5">
			{edited ? (
				<p>
					{tl(
						"This page was last edited on {edited}. Text is generated from the workspace’s live agents and threads.",
						{ edited }
					)}
				</p>
			) : (
				<p>
					Text is generated from the workspace&rsquo;s live agents and threads.
				</p>
			)}
		</footer>
	);
}

/** Plain paragraph spacing used through article bodies. */
export const PROSE = "text-sm leading-6 text-foreground";
