import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { cn } from "@ryu/ui/lib/utils";
import { Info, Play } from "lucide-react";
import { motion } from "motion/react";
import { CinemaArt } from "./cinema-art.tsx";
import {
	type CinemaTitle,
	type CinemaTitleType,
	cinemaAge,
	cinemaMessages,
	cinemaNames,
	cinemaStatusText,
} from "./cinema-model.ts";
import { CinemaKicker } from "./cinema-poster.tsx";
import { compactAge } from "./interface-renderer.ts";

/** The billboard title's type per title style, at each frame size. */
const HEADLINE: Record<
	CinemaTitleType,
	Record<"compact" | "medium" | "wide", string>
> = {
	caps: {
		compact: "font-bold text-2xl uppercase leading-8 tracking-[0.08em]",
		medium: "font-bold text-4xl uppercase leading-[44px] tracking-[0.08em]",
		wide: "font-bold text-5xl uppercase leading-[56px] tracking-[0.08em]",
	},
	display: {
		compact: "font-extrabold text-3xl leading-9 tracking-tight",
		medium: "font-extrabold text-5xl leading-[52px] tracking-tighter",
		wide: "font-extrabold text-6xl leading-[64px] tracking-tighter",
	},
	serif: {
		compact: "font-serif font-semibold text-3xl italic leading-9",
		medium: "font-serif font-semibold text-5xl italic leading-[52px]",
		wide: "font-serif font-semibold text-6xl italic leading-[64px]",
	},
};

/** The status chip that leads the billboard's facts. */
const STATUS_CHIP: Record<CinemaTitle["status"], string> = {
	attention: "bg-destructive text-foreground",
	quiet: "bg-foreground/15 text-foreground",
	waiting: "bg-foreground/15 text-foreground",
	working: "bg-background/70 text-foreground ring-1 ring-success/60",
	"your-turn": "bg-foreground text-background",
};

export interface CinemaBillboardProps {
	/** Space the first row takes back from the bottom of the art. */
	bottomInset: number;
	gutter: number;
	height: number;
	now: number;
	onMore: (threadId: string, opener: HTMLElement) => void;
	onOpen: (threadId: string) => void;
	reduceMotion: boolean;
	title: CinemaTitle;
	width: number;
}

/**
 * The featured title, full bleed: the lead agent's key art shaded into the
 * page, with the title set large, who and when, the
 * latest message as its synopsis, and Open / More info.
 */
export function CinemaBillboard({
	bottomInset,
	gutter,
	height,
	now,
	onMore,
	onOpen,
	reduceMotion,
	title,
	width,
}: CinemaBillboardProps) {
	const tl = useLiteralMessages();
	let size: "compact" | "medium" | "wide" = "wide";
	if (width < 640) {
		size = "compact";
	} else if (width < 1100) {
		size = "medium";
	}
	const thread = title.thread;
	const kicker =
		title.agents.length > 0 ? (title.group?.name ?? "Thread") : null;
	const facts = [
		title.agents.length > 1 ? cinemaNames(title.agents) : "",
		cinemaMessages(thread.messageCount),
		cinemaAge(compactAge(thread.updatedAt, now)),
	].filter(Boolean);
	const infoWidth = size === "compact" ? width - gutter * 2 : width * 0.42;
	return (
		<section
			aria-label={tl("Featured: {title}", { title: thread.title })}
			className="relative w-full overflow-hidden"
			data-testid="cinema-billboard"
			style={{ height }}
		>
			<motion.div
				animate={{ opacity: 1, scale: 1 }}
				aria-hidden="true"
				className="absolute inset-0"
				initial={reduceMotion ? false : { opacity: 0, scale: 1.04 }}
				key={thread.id}
				transition={{ duration: 1.2, ease: [0.22, 1, 0.36, 1] }}
			>
				<CinemaArt frame="hero" spec={title.art} text={thread.title} />
			</motion.div>
			<div
				aria-hidden="true"
				className="absolute inset-x-0 top-0 h-28 bg-linear-to-b from-background/70 to-transparent"
			/>
			<div
				aria-hidden="true"
				className="absolute inset-x-0 bottom-0 h-2/5 bg-linear-to-t from-background via-background/60 to-transparent"
			/>
			<div
				className="absolute flex flex-col items-start"
				style={{
					bottom: bottomInset + (size === "compact" ? 24 : 48),
					left: gutter,
					width: Math.max(280, infoWidth),
				}}
			>
				<p className="mb-4 flex items-center gap-3 font-semibold text-sm uppercase leading-5 tracking-[0.2em]">
					<CinemaKicker className="text-sm leading-5" title={title} />
					{kicker ? (
						<>
							<span aria-hidden="true" className="text-foreground/40">
								/
							</span>
							<span className="text-foreground/75">{kicker}</span>
						</>
					) : null}
				</p>
				<h1 className="text-foreground">
					{/* Weight lives on the span: the shared heading reset pins h1 at 500. */}
					<span
						className={cn(
							"line-clamp-3 text-balance",
							HEADLINE[title.art.type][size]
						)}
					>
						{thread.title}
					</span>
				</h1>
				<p className="mt-5 flex flex-wrap items-center gap-x-2 gap-y-1 font-medium text-base text-foreground/80 leading-6">
					<span
						className={cn(
							"mr-1 flex items-center gap-1.5 rounded-xs px-2 py-0.5 font-semibold text-sm leading-5",
							STATUS_CHIP[title.status]
						)}
					>
						{title.status === "working" ? (
							<span
								aria-hidden="true"
								className="size-1.5 rounded-full bg-success motion-safe:animate-pulse"
							/>
						) : null}
						{cinemaStatusText(title)}
					</span>
					{facts.map((fact, index) => (
						<span className="flex items-center gap-2" key={fact}>
							{index > 0 ? (
								<span aria-hidden="true" className="text-foreground/40">
									·
								</span>
							) : null}
							{fact}
						</span>
					))}
				</p>
				{thread.lastMessage && size !== "compact" ? (
					<p
						className={cn(
							"mt-3 line-clamp-3 text-foreground/90",
							size === "wide" ? "text-lg leading-7" : "text-base leading-6"
						)}
					>
						{thread.lastMessage}
					</p>
				) : null}
				<div className="mt-6 flex items-center gap-3">
					<Button
						className="h-11 gap-2 rounded-sm bg-foreground px-7 font-semibold text-background text-base hover:bg-foreground/80"
						onClick={() => onOpen(thread.id)}
						type="button"
					>
						<Play aria-hidden="true" className="size-5 fill-current" />
						Open
					</Button>
					<Button
						className="h-11 gap-2 rounded-sm bg-foreground/20 px-6 font-semibold text-base text-foreground hover:bg-foreground/25"
						onClick={(event) => onMore(thread.id, event.currentTarget)}
						type="button"
						variant="ghost"
					>
						<Info aria-hidden="true" className="size-5" />
						More info
					</Button>
				</div>
			</div>
		</section>
	);
}
