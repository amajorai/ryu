import { cn } from "@ryu/ui/lib/utils";
import type { InterfaceAgent } from "@ryuhq/protocol/interfaces";
import type { ReactNode } from "react";
import {
	type CoverSpec,
	coverSpec,
	type LibraryBookKind,
} from "./library-model.ts";
import { COVER_BINDING, type CoverInks, coverInks } from "./library-palette.ts";

/** Title size steps with length, so a short name fills the board. */
function titleSize(title: string): string {
	const longest = Math.max(...title.split(/\s+/).map((word) => word.length));
	if (title.length <= 6) {
		return "text-[17cqw]";
	}
	if (longest <= 9 && title.length <= 12) {
		return "text-[13cqw]";
	}
	return "text-[10.5cqw]";
}

const KIND_MARK: Record<LibraryBookKind, string> = {
	agent: "Agent",
	project: "Project",
	team: "Team",
	unassigned: "Unfiled",
};

interface Face {
	byline: string | null;
	inks: CoverInks;
	mark: string;
	spec: CoverSpec;
	subtitle: string;
	title: string;
}

/** The publisher's colophon: the book's initial in a stamped ring. */
function Colophon({ inks, letter }: { inks: CoverInks; letter: string }) {
	return (
		<span
			className="flex size-[15cqw] items-center justify-center rounded-full border-[0.8cqw] font-serif text-[8cqw] leading-none"
			style={{ borderColor: inks.foil, color: inks.foil }}
		>
			{letter}
		</span>
	);
}

/** Agents: cloth with a cream band carrying the title, like a classics series. */
function BandFace({ inks, mark, spec, subtitle, title }: Face) {
	return (
		<div className="absolute inset-0 flex flex-col items-center text-center">
			<p
				className="mt-[11cqw] font-medium text-[4.6cqw] uppercase tracking-[0.24em]"
				style={{ color: inks.foil }}
			>
				{mark}
			</p>
			<div
				className="mt-[9cqw] flex w-full flex-col items-center border-y-[1.4cqw] px-[8cqw] py-[7cqw]"
				style={{
					background: inks.paper,
					borderColor: inks.foil,
					color: inks.ink,
				}}
			>
				<p
					className={cn(
						"line-clamp-2 font-serif leading-[0.95]",
						titleSize(title)
					)}
				>
					{title}
				</p>
				<span
					className="my-[3.5cqw] h-px w-[16cqw]"
					style={{ background: inks.ink }}
				/>
				<p className="line-clamp-2 font-serif text-[5cqw] italic leading-snug">
					{subtitle}
				</p>
			</div>
			<div className="mt-auto mb-[10cqw]">
				<Colophon inks={inks} letter={spec.monogram} />
			</div>
		</div>
	);
}

/** Projects: a stamped double frame around a centred serif title. */
function FramedFace({ byline, inks, mark, subtitle, title }: Face) {
	return (
		<div
			className="absolute inset-[6cqw] flex flex-col items-center border-[0.8cqw] p-[2cqw] text-center"
			style={{ borderColor: inks.foil, color: inks.foil }}
		>
			<div
				className="flex size-full flex-col items-center border px-[5cqw] pt-[8cqw] pb-[7cqw]"
				style={{ borderColor: inks.foil }}
			>
				<p className="font-medium text-[4.4cqw] uppercase tracking-[0.24em]">
					{mark}
				</p>
				<p
					className={cn(
						"mt-auto line-clamp-3 font-serif leading-[0.98]",
						titleSize(title)
					)}
				>
					{title}
				</p>
				<span aria-hidden="true" className="my-[4cqw] text-[5cqw] leading-none">
					◆
				</span>
				<p className="line-clamp-2 font-serif text-[4.8cqw] italic leading-snug opacity-90">
					{subtitle}
				</p>
				{byline ? (
					<p className="mt-auto truncate pt-[4cqw] text-[4.2cqw] uppercase tracking-[0.16em] opacity-85">
						{byline}
					</p>
				) : null}
			</div>
		</div>
	);
}

/** Teams: heavy stacked lettering under three printed bars. */
function StackFace({ byline, inks, mark, title }: Face) {
	return (
		<div
			className="absolute inset-0 flex flex-col px-[9cqw] pt-[10cqw] pb-[9cqw]"
			style={{ color: inks.foil }}
		>
			<div className="flex flex-col gap-[2cqw]">
				<span className="h-[2.4cqw] w-full" style={{ background: inks.foil }} />
				<span
					className="h-[2.4cqw] w-[70%]"
					style={{ background: inks.foil }}
				/>
				<span
					className="h-[2.4cqw] w-[40%]"
					style={{ background: inks.foil }}
				/>
			</div>
			<p className="mt-[6cqw] font-medium text-[4.4cqw] uppercase tracking-[0.24em] opacity-90">
				{mark}
			</p>
			<p className="mt-auto line-clamp-4 break-words font-black text-[15cqw] uppercase leading-[0.9] tracking-tight">
				{title}
			</p>
			{byline ? (
				<p className="mt-[5cqw] truncate text-[4.4cqw] uppercase tracking-[0.14em] opacity-85">
					{byline}
				</p>
			) : null}
		</div>
	);
}

/** Loose conversations: plain paper stock, set like a notebook's label. */
function PaperFace({ inks, mark, subtitle, title }: Face) {
	return (
		<div
			className="absolute inset-0 flex flex-col px-[10cqw] pt-[12cqw] pb-[10cqw]"
			style={{ background: inks.paper, color: inks.ink }}
		>
			<p className="font-medium text-[4.4cqw] uppercase tracking-[0.24em] opacity-70">
				{mark}
			</p>
			<span
				className="mt-[4cqw] h-px w-full"
				style={{ background: inks.ink }}
			/>
			<p
				className={cn(
					"mt-[8cqw] line-clamp-3 font-serif leading-[0.98]",
					titleSize(title)
				)}
			>
				{title}
			</p>
			<p className="mt-[4cqw] line-clamp-3 font-serif text-[5cqw] italic leading-snug opacity-80">
				{subtitle}
			</p>
			<span className="mt-auto h-px w-full" style={{ background: inks.ink }} />
		</div>
	);
}

const FACES: Record<CoverSpec["layout"], (face: Face) => ReactNode> = {
	band: BandFace,
	framed: FramedFace,
	paper: PaperFace,
	stack: StackFace,
};

/** Short author line for collection covers. */
function bylineFor(
	authors: readonly Pick<InterfaceAgent, "name">[]
): string | null {
	const [first, second] = authors;
	if (!first) {
		return null;
	}
	if (authors.length === 1) {
		return first.name;
	}
	if (authors.length === 2 && second) {
		return `${first.name} & ${second.name}`;
	}
	return `${first.name} & ${(authors.length - 1).toString()} more`;
}

/**
 * A book's cover, printed in its series (see `COVER_LAYOUTS`) and bound in
 * cloth of the book's colour: the agent's own for agent books. Realistic 2:3
 * proportions with a pressed spine crease; decorative, because the
 * surrounding control names it.
 */
export function BookCover({
	authors = [],
	bookId,
	className,
	kind,
	subtitle,
	title,
}: {
	/** The book's writers; the first colours an agent's book. */
	authors?: readonly Pick<InterfaceAgent, "id" | "name">[];
	bookId: string;
	className?: string;
	kind: LibraryBookKind;
	subtitle: string;
	title: string;
}) {
	const spec = coverSpec(bookId, kind, title, authors[0] ?? null);
	const inks = coverInks(spec);
	const Face = FACES[spec.layout];
	return (
		<div
			aria-hidden="true"
			className={cn(
				"@container/cover relative isolate aspect-[2/3] w-full select-none overflow-hidden rounded-[3px]",
				className
			)}
			data-cover-layout={spec.layout}
			style={{ background: inks.cloth }}
		>
			{spec.layout === "paper" ? null : (
				<div
					className="absolute inset-0"
					style={{ backgroundImage: inks.weave }}
				/>
			)}
			<Face
				byline={bylineFor(authors)}
				inks={inks}
				mark={KIND_MARK[kind]}
				spec={spec}
				subtitle={subtitle}
				title={title}
			/>
			{/* The binding: a shadow ramp into the spine and a pressed crease. */}
			<div
				className="pointer-events-none absolute inset-y-0 left-0 w-[9%]"
				style={{ background: COVER_BINDING.spine }}
			/>
			<div
				className="pointer-events-none absolute inset-y-0 left-[4%] w-px"
				style={{ background: COVER_BINDING.crease }}
			/>
			<div
				className="pointer-events-none absolute inset-0 rounded-[inherit]"
				style={{ boxShadow: COVER_BINDING.edge }}
			/>
		</div>
	);
}
