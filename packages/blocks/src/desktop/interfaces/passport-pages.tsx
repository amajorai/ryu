import { useLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils";
import {
	type PassportCountry,
	type PassportPage,
	placeStamps,
	UNASSIGNED_CODE,
	UNASSIGNED_STYLE,
} from "./passport-model.ts";
import { PAGE_WIDTH, type PageSide, Paper } from "./passport-pages-paper.tsx";
import { StampButton } from "./passport-pages-stamp.tsx";
import { UnassignedBlock, VisaBlock } from "./passport-pages-visa.tsx";
import { STAMP_HEIGHT, STAMP_WIDTH } from "./passport-stamp.tsx";

export {
	CoverPage,
	IdentityPage,
	NotesPage,
} from "./passport-pages-front.tsx";
export {
	PAGE_HEIGHT,
	PAGE_WIDTH,
	type PageSide,
} from "./passport-pages-paper.tsx";

/** Width of the page's content column, inside the paper's side margins. */
const CONTENT_WIDTH = PAGE_WIDTH - 56;

/** A visa page: the country's block on its first page, then its stamps. */
export function VisaPage({
	activeThreadId,
	countries,
	onApply,
	onOpen,
	page,
	side,
	totalStamps,
}: {
	activeThreadId: string | null;
	countries: PassportCountry[];
	onApply: (agentId: string) => void;
	onOpen: (threadId: string) => void;
	page: Extract<PassportPage, { kind: "visa" }>;
	side: PageSide;
	totalStamps: number;
}) {
	const tl = useLiteralMessages();
	const country = countries.find((item) => item.id === page.countryId) ?? null;
	const header = country
		? `Visas · ${country.code}${page.first ? "" : " (cont.)"}`
		: `Visas · ${UNASSIGNED_CODE}`;
	const shape = (country?.style ?? UNASSIGNED_STYLE).shape;
	const placements = placeStamps(
		page.stamps,
		shape,
		CONTENT_WIDTH,
		page.first ? 2 : 3
	);
	return (
		<Paper header={header} number={page.number} side={side} watermark>
			{page.first && country ? (
				<VisaBlock country={country} onApply={onApply} />
			) : null}
			{page.first && !country ? <UnassignedBlock count={totalStamps} /> : null}
			{page.stamps.length > 0 ? (
				<ol
					aria-label={
						country
							? tl("{name} entries", { name: country.agent.name })
							: "Entries"
					}
					className={cn(
						"relative min-h-[280px] flex-1",
						page.first ? "mt-4" : "mt-0"
					)}
				>
					{page.stamps.map((stamp, index) => (
						<StampButton
							active={stamp.thread.id === activeThreadId}
							country={country}
							key={stamp.thread.id}
							onOpen={onOpen}
							placement={
								placements[index] ?? { centerX: 0, fraction: 0, nudgeY: 0 }
							}
							stamp={stamp}
						/>
					))}
				</ol>
			) : (
				<div className="flex flex-1 flex-col items-center justify-center gap-1 text-center">
					<p className="font-mono font-semibold text-[11px] uppercase tracking-[0.2em]">
						No entries recorded
					</p>
					<p className="text-(--pp-ink-muted) text-xs leading-5">
						Apply for a visa to start a conversation.
					</p>
				</div>
			)}
		</Paper>
	);
}

/** A page with nothing on it yet; with no countries at all, it says why. */
export function BlankPage({
	empty,
	number,
	side,
}: {
	empty: boolean;
	number: number;
	side: PageSide;
}) {
	return (
		<Paper header="Visas" number={number} side={side}>
			{empty ? (
				<div className="flex flex-1 flex-col items-center justify-center gap-1 text-center">
					<p className="font-mono font-semibold text-[11px] uppercase tracking-[0.2em]">
						No visas issued
					</p>
					<p className="max-w-60 text-(--pp-ink-muted) text-xs leading-5">
						Each agent you add gets visa pages here, and each conversation with
						it gets a stamp.
					</p>
				</div>
			) : null}
		</Paper>
	);
}

/** Stamp box size, for layout math elsewhere. */
export const STAMP_BOX = { height: STAMP_HEIGHT, width: STAMP_WIDTH };
