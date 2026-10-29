import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ryu/ui/components/tooltip.tsx";
import { cn } from "@ryu/ui/lib/utils";
import type {
	InterfaceAgent,
	InterfaceEvent,
} from "@ryuhq/protocol/interfaces";
import type { CSSProperties, ReactNode } from "react";
import {
	MARKING_LABELS,
	MARKING_MEANINGS,
	MARKING_ORDER,
	mrzLines,
	type Passport,
	type PassportCountry,
	type PassportPage,
	type PassportStamp,
	placeStamps,
	plural,
	type StampPlacement,
	type StampShape,
	stampDate,
	stampDayMonth,
	stampLabel,
	stampTime,
	UNASSIGNED_CODE,
	UNASSIGNED_LABEL,
	UNASSIGNED_STYLE,
} from "./passport-model.ts";
import {
	EMBOSS,
	GUTTER_LEFT,
	GUTTER_RIGHT,
	stampInk,
} from "./passport-palette.ts";
import {
	CountryEmblem,
	EntryStamp,
	STAMP_HEIGHT,
	STAMP_WIDTH,
	usePassportArtId,
} from "./passport-stamp.tsx";

/** Page size in booklet pixels; the booklet scales as a whole to fit. */
export const PAGE_WIDTH = 400;
export const PAGE_HEIGHT = 564;

export type PageSide = "left" | "right" | "single";

/** Shared label style: small official capitals. */
const CAPTION =
	"font-mono text-[9px] text-(--pp-ink-muted) uppercase leading-3 tracking-[0.18em]";

/** A sheet of visa paper: cream, a guilloche ground, and the fold shading. */
function Paper({
	children,
	header,
	number,
	side,
	watermark = false,
}: {
	children: ReactNode;
	header: string;
	number: number;
	side: PageSide;
	/** Visa pages carry the emblem as a faint watermark, like the real thing. */
	watermark?: boolean;
}) {
	const prefix = usePassportArtId();
	const outer = side === "left" ? "text-start" : "text-end";
	return (
		<div
			className="relative flex size-full flex-col overflow-hidden bg-(--pp-paper) px-7 pt-6 pb-5 text-(--pp-ink)"
			style={{
				backgroundImage:
					side === "left"
						? GUTTER_LEFT
						: side === "right"
							? GUTTER_RIGHT
							: undefined,
			}}
		>
			<svg
				aria-hidden="true"
				className="pointer-events-none absolute inset-0 size-full"
				focusable="false"
			>
				<rect fill={`url(#${prefix}-guilloche)`} height="100%" width="100%" />
			</svg>
			{watermark ? (
				<GlobeMark className="pointer-events-none absolute top-[58%] left-1/2 size-56 -translate-x-1/2 -translate-y-1/2 text-(--pp-watermark)" />
			) : null}
			<div
				className={cn(
					"relative flex h-4 items-center justify-between",
					side === "right" && "flex-row-reverse"
				)}
			>
				<span className={CAPTION}>{header}</span>
				<span className={cn(CAPTION, "tracking-[0.3em]")}>RYU</span>
			</div>
			<div className="relative mt-4 flex min-h-0 flex-1 flex-col">
				{children}
			</div>
			<p
				className={cn(
					"relative mt-3 font-mono text-(--pp-ink-muted) text-[11px] tabular-nums leading-4",
					outer
				)}
			>
				{number}
			</p>
		</div>
	);
}

/** The issuing emblem: a globe in a dotted ring with compass points. */
function GlobeMark({
	className,
	style,
}: {
	className: string;
	style?: CSSProperties;
}) {
	return (
		<svg
			aria-hidden="true"
			className={className}
			fill="none"
			focusable="false"
			stroke="currentColor"
			style={style}
			viewBox="0 0 120 120"
		>
			<circle cx="60" cy="60" r="56" strokeWidth="1.6" />
			<circle cx="60" cy="60" r="51" strokeDasharray="1 3.2" strokeWidth="2" />
			<circle cx="60" cy="60" r="36" strokeWidth="1.4" />
			<ellipse cx="60" cy="60" rx="15" ry="36" strokeWidth="1.1" />
			<path
				d="M24 60 H96 M27.5 45 H92.5 M27.5 75 H92.5 M60 24 V96"
				strokeWidth="1.1"
			/>
			<path
				d="M60 4 L63 13 L60 11 L57 13 Z M60 116 L63 107 L60 109 L57 107 Z M4 60 L13 57 L11 60 L13 63 Z M116 60 L107 57 L109 60 L107 63 Z"
				fill="currentColor"
				stroke="none"
			/>
		</svg>
	);
}

/** The front board: emblem, PASSPORT, the issuing workspace, the chip mark. */
export function CoverPage({ onOpen }: { onOpen: () => void }) {
	return (
		<button
			aria-label="Open passport"
			className="group relative flex size-full cursor-pointer flex-col items-center justify-between bg-(--pp-cover) px-10 pt-16 pb-14 text-(--pp-foil) outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
			onClick={onOpen}
			type="button"
		>
			<span
				className="font-serif text-[15px] uppercase tracking-[0.42em]"
				style={{ textShadow: EMBOSS }}
			>
				Ryu Workspace
			</span>
			<GlobeMark
				className="size-36"
				style={{ filter: "drop-shadow(0 -1px 0 var(--pp-cover-ink))" }}
			/>
			<span className="flex flex-col items-center gap-3">
				<span
					className="font-semibold font-serif text-[34px] uppercase leading-none tracking-[0.3em]"
					style={{ textShadow: EMBOSS }}
				>
					Passport
				</span>
				<svg
					aria-hidden="true"
					className="mt-6 h-6 w-10"
					fill="none"
					focusable="false"
					stroke="currentColor"
					viewBox="0 0 40 24"
				>
					<rect height="22" rx="1.5" strokeWidth="1.5" width="38" x="1" y="1" />
					<path d="M1 12 H11 M29 12 H39" strokeWidth="1.5" />
					<circle cx="20" cy="12" r="6" strokeWidth="1.5" />
				</svg>
			</span>
			<span
				aria-hidden="true"
				className="absolute inset-x-0 bottom-6 font-mono text-[10px] uppercase tracking-[0.3em] opacity-70 transition-opacity duration-200 group-hover:opacity-100 group-focus-visible:opacity-100 motion-reduce:transition-none"
			>
				Open passport
			</span>
		</button>
	);
}

function MarkingSample({
	marking,
}: {
	marking: (typeof MARKING_ORDER)[number];
}) {
	return (
		<span
			className={cn(
				"inline-flex h-5 shrink-0 items-center rounded-[3px] border-[1.5px] border-current px-1.5 font-mono text-[9px] uppercase leading-none tracking-[0.08em]",
				marking === "denied" && "border-(--pp-denied) text-(--pp-denied)",
				marking === "arrived" && "border-2 font-extrabold",
				marking === "processing" && "border-dashed",
				marking === "applied" && "border opacity-70",
				marking === "exited" && "opacity-80"
			)}
		>
			{MARKING_LABELS[marking]}
		</span>
	);
}

/** Inside the front cover: what the markings mean and what is scheduled. */
export function NotesPage({
	agents,
	number,
	side,
	upcoming,
}: {
	agents: InterfaceAgent[];
	number: number;
	side: PageSide;
	upcoming: InterfaceEvent[];
}) {
	return (
		<Paper header="Notes" number={number} side={side}>
			<h2 className="font-semibold font-serif text-xl leading-7">Markings</h2>
			<p className="mt-1 text-(--pp-ink-muted) text-xs leading-5">
				Every conversation is an entry stamp on its agent’s visa pages.
			</p>
			<dl className="mt-4 flex flex-col">
				{MARKING_ORDER.map((marking) => (
					<div
						className="grid grid-cols-[176px_1fr] items-center gap-3 border-(--pp-rule) border-t py-1.5 last:border-b"
						key={marking}
					>
						<dt className="flex">
							<MarkingSample marking={marking} />
						</dt>
						<dd className="text-(--pp-ink-muted) text-xs leading-4">
							{MARKING_MEANINGS[marking]}
						</dd>
					</div>
				))}
			</dl>
			<h2 className="mt-6 font-semibold font-serif text-xl leading-7">
				Scheduled travel
			</h2>
			{upcoming.length > 0 ? (
				<ol className="mt-3 flex flex-col">
					{upcoming.map((event) => {
						const agent = agents.find((item) => item.id === event.agentId);
						const start = Date.parse(event.start);
						return (
							<li
								className="grid grid-cols-[88px_1fr] items-baseline gap-3 border-(--pp-rule) border-t py-2 last:border-b"
								key={event.id}
							>
								<span className="font-mono text-[10px] tabular-nums leading-4">
									{stampDayMonth(start)} {stampTime(start)}
								</span>
								<span className="min-w-0">
									<span className="block truncate font-medium text-[13px] leading-4">
										{event.title}
									</span>
									<span className="block truncate text-(--pp-ink-muted) text-[11px] leading-4">
										{[agent?.name, event.label].filter(Boolean).join(" · ")}
									</span>
								</span>
							</li>
						);
					})}
				</ol>
			) : (
				<p className="mt-2 text-(--pp-ink-muted) text-xs leading-5">
					Nothing scheduled.
				</p>
			)}
		</Paper>
	);
}

/**
 * The holder's photo frame. The workspace has no portrait of its holder to
 * print, so the frame carries only the engraved security rosette.
 */
function HolderPhoto() {
	const prefix = usePassportArtId();
	return (
		<svg
			aria-hidden="true"
			className="h-[136px] w-[106px] shrink-0 text-(--pp-ink)"
			focusable="false"
			viewBox="0 0 106 136"
		>
			<rect fill={`url(#${prefix}-guilloche)`} height="136" width="106" />
			<rect
				fill="none"
				height="135"
				stroke="var(--pp-rule)"
				width="105"
				x="0.5"
				y="0.5"
			/>
			<g fill="none" opacity="0.3" stroke="currentColor" strokeWidth="0.6">
				{[0, 15, 30, 45, 60, 75, 90, 105, 120, 135, 150, 165].map((angle) => (
					<ellipse
						cx="53"
						cy="62"
						key={angle}
						rx="40"
						ry="15"
						transform={`rotate(${angle} 53 62)`}
					/>
				))}
				<circle cx="53" cy="62" r="40" />
				<circle cx="53" cy="62" r="30" strokeDasharray="1 2.4" />
			</g>
			<circle
				cx="53"
				cy="62"
				fill="none"
				opacity="0.45"
				r="8"
				stroke="currentColor"
				strokeWidth="0.8"
			/>
			<text
				className="font-mono"
				fill="var(--pp-ink-muted)"
				fontSize="7"
				letterSpacing="1.6"
				textAnchor="middle"
				x="53"
				y="124"
			>
				HOLDER
			</text>
		</svg>
	);
}

function IdentityField({
	label,
	children,
}: {
	children: ReactNode;
	label: string;
}) {
	return (
		<div className="flex min-w-0 flex-col gap-0.5">
			<dt className={CAPTION}>{label}</dt>
			<dd className="truncate font-mono font-semibold text-[13px] uppercase leading-5">
				{children}
			</dd>
		</div>
	);
}

/** The data page: the holder, the passport's dates, and the travel totals. */
export function IdentityPage({
	number,
	passport,
	side,
}: {
	number: number;
	passport: Passport;
	side: PageSide;
}) {
	const [first, second] = mrzLines(passport);
	const totals = [
		{ label: "Countries", value: passport.totals.countries },
		{ label: "Stamps", value: passport.totals.stamps },
		{ label: "Travel days", value: passport.totals.travelDays },
	];
	return (
		<Paper header="Passport · Type P" number={number} side={side}>
			<div className="flex gap-5">
				<HolderPhoto />
				<dl className="grid min-w-0 flex-1 grid-cols-2 gap-x-4 gap-y-3">
					<IdentityField label="Code">RYU</IdentityField>
					<IdentityField label="Passport no.">{passport.number}</IdentityField>
					<div className="col-span-2">
						<IdentityField label="Holder">You</IdentityField>
					</div>
					<IdentityField label="Date of issue">
						{passport.issuedAt === null ? "—" : stampDate(passport.issuedAt)}
					</IdentityField>
					<IdentityField label="Last entry">
						{passport.latestAt === null ? "—" : stampDate(passport.latestAt)}
					</IdentityField>
					<div className="col-span-2">
						<IdentityField label="Authority">Ryu workspace</IdentityField>
					</div>
				</dl>
			</div>
			<dl className="mt-7 grid grid-cols-3 border-(--pp-rule) border-y">
				{totals.map((total, index) => (
					<div
						className={cn(
							"flex flex-col justify-between gap-1 py-4",
							index > 0 && "border-(--pp-rule) border-s ps-4"
						)}
						key={total.label}
					>
						<dt className={CAPTION}>{total.label}</dt>
						<dd className="font-semibold font-serif text-[34px] tabular-nums leading-10">
							{total.value}
						</dd>
					</div>
				))}
			</dl>
			<dl className="mt-5 flex min-w-0 flex-col gap-1">
				<dt className={CAPTION}>Visas held</dt>
				<dd className="flex min-h-5 flex-wrap gap-x-2 font-mono font-semibold text-[13px] leading-5">
					{passport.countries.length > 0 ? (
						passport.countries.map((country) => (
							<span
								key={country.id}
								style={{ color: stampInk(country.style.ink) }}
							>
								{country.code}
							</span>
						))
					) : (
						<span>—</span>
					)}
				</dd>
			</dl>
			{/* Left blank, as issued: the holder signs on paper, not here. */}
			<div className="mt-5 flex flex-col gap-1">
				<p className={CAPTION}>Holder’s signature</p>
				<div aria-hidden="true" className="h-8 border-(--pp-rule) border-b" />
			</div>
			<div
				aria-label="Machine-readable zone"
				className="mt-auto flex flex-col gap-1 bg-(--pp-wash) px-3 py-2.5 font-mono text-[11px] leading-4 tracking-[0.04em]"
				role="img"
			>
				<span className="whitespace-pre">{first}</span>
				<span className="whitespace-pre">{second}</span>
			</div>
		</Paper>
	);
}

/** A line of microprint: the security text that reads as a rule. */
function Microprint({ text }: { text: string }) {
	return (
		<p
			aria-hidden="true"
			className="overflow-hidden whitespace-nowrap px-4 font-mono text-(--pp-ink-muted) text-[5px] leading-[6px] tracking-[0.12em] opacity-45 group-data-[fine=false]/booklet:invisible"
		>
			{text.repeat(12)}
		</p>
	);
}

const STICKER_RULE = "color-mix(in oklab, var(--pp-ink) 34%, transparent)";

/**
 * The visa that heads a country's first page: a printed sticker with a
 * double rule, the country's emblem, and a microprint band.
 */
function VisaBlock({
	country,
	onApply,
}: {
	country: PassportCountry;
	onApply: (agentId: string) => void;
}) {
	const working = country.agent.status === "working";
	const microprint = `VISA ${country.code} RYU `;
	return (
		<section
			aria-label={`${country.agent.name} visa`}
			className="flex flex-col border-[3px] border-double bg-(--pp-wash)"
			style={{ borderColor: STICKER_RULE }}
		>
			<div className="flex gap-4 px-4 pt-3.5 pb-3">
				<CountryEmblem
					code={country.code}
					size={72}
					style={country.style}
					textured
				/>
				<div className="flex min-w-0 flex-1 flex-col">
					<div className="flex items-baseline justify-between gap-2">
						<h2 className="truncate font-semibold font-serif text-[22px] leading-7">
							{country.agent.name}
						</h2>
						<span className="font-mono font-semibold text-[11px] tracking-[0.2em]">
							{country.code}
						</span>
					</div>
					<p className="mt-0.5 truncate text-(--pp-ink-muted) text-xs leading-4">
						{country.agent.description || "No description."}
					</p>
					{/* Reserved when idle, so facing visa blocks keep their rows level. */}
					<p
						aria-hidden={working ? undefined : true}
						className={cn(
							"mt-1.5 font-mono font-semibold text-[9px] uppercase leading-3 tracking-[0.18em]",
							!working && "invisible"
						)}
						style={{ color: stampInk(country.style.ink) }}
					>
						In session now
					</p>
				</div>
			</div>
			<Microprint text={microprint} />
			<div className="flex items-end gap-5 px-4 pt-2 pb-3">
				<dl className="flex gap-5">
					<div className="flex flex-col gap-0.5">
						<dt className={CAPTION}>Entries</dt>
						<dd className="font-mono font-semibold text-[12px] tabular-nums leading-4">
							{country.stamps.length}
						</dd>
					</div>
					<div className="flex flex-col gap-0.5">
						<dt className={CAPTION}>Last entry</dt>
						<dd className="font-mono font-semibold text-[12px] tabular-nums leading-4">
							{country.lastEntryAt === null
								? "—"
								: stampDate(country.lastEntryAt)}
						</dd>
					</div>
				</dl>
				<button
					aria-label={`Apply for a visa to ${country.agent.name}`}
					className="ms-auto cursor-pointer font-semibold text-(--pp-ink) text-xs leading-4 underline decoration-(--pp-ink-muted) decoration-1 underline-offset-4 outline-none transition-colors hover:decoration-(--pp-ink) hover:decoration-2 focus-visible:rounded-[2px] focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-(--pp-paper) focus-visible:ring-offset-2"
					onClick={() => onApply(country.id)}
					type="button"
				>
					Apply for a visa
				</button>
			</div>
		</section>
	);
}

function UnassignedBlock({ count }: { count: number }) {
	return (
		<section
			aria-label={`${UNASSIGNED_LABEL} visa`}
			className="border-[3px] border-double p-4"
			style={{ borderColor: STICKER_RULE }}
		>
			<div className="flex items-baseline justify-between gap-2">
				<h2 className="font-semibold font-serif text-[22px] leading-7">
					{UNASSIGNED_LABEL}
				</h2>
				<span className="font-mono font-semibold text-[11px] tracking-[0.2em]">
					{UNASSIGNED_CODE}
				</span>
			</div>
			<p className="mt-0.5 text-(--pp-ink-muted) text-xs leading-4">
				{plural(count, "conversation", "conversations")} with no agent, under
				the workspace stamp.
			</p>
		</section>
	);
}

/**
 * Where the paper clip bites, per shape, in stamp units: on the top edge of
 * the ink (a triangle's right side, just under the apex).
 */
const CLIP_AT: Record<StampShape, { x: number; y: number }> = {
	circle: { x: 112, y: 0 },
	octagon: { x: 98, y: -9 },
	rectangle: { x: 132, y: 4 },
	triangle: { x: 99, y: 17 },
};

/** The paper clip that marks the entry whose record is open. */
function PaperClip({ shape }: { shape: StampShape }) {
	const at = CLIP_AT[shape];
	return (
		<svg
			aria-hidden="true"
			className="pointer-events-none absolute h-11 w-4 rotate-[8deg] text-(--pp-ink-muted)"
			fill="none"
			focusable="false"
			stroke="currentColor"
			strokeLinecap="round"
			strokeWidth="1.6"
			style={{ left: at.x - 8, top: at.y - 12 }}
			viewBox="0 0 16 44"
		>
			<path d="M11 14 V35 a3 3 0 0 1 -6 0 V8 a5 5 0 0 1 10 0 V31" />
		</svg>
	);
}

/** "Visa processing" for the tooltip, from the stamp's capitals. */
function sentenceCase(text: string): string {
	const lower = text.toLowerCase();
	return lower.charAt(0).toUpperCase() + lower.slice(1);
}

/** What a stamp says in full: hover or focus shows it beside the stamp. */
function StampDetails({
	countryName,
	stamp,
}: {
	countryName: string;
	stamp: PassportStamp;
}) {
	const sameDay = stampDate(stamp.entryAt) === stampDate(stamp.latestAt);
	const last = sameDay
		? stampTime(stamp.latestAt)
		: `${stampDayMonth(stamp.latestAt)} ${stampTime(stamp.latestAt)}`;
	return (
		<span className="flex min-w-0 flex-col items-start gap-0.5 text-start">
			<span className="font-medium text-foreground text-xs leading-4">
				{stamp.thread.title || "Untitled conversation"}
			</span>
			<span className="text-muted-foreground text-xs leading-4">
				{countryName} · {sentenceCase(MARKING_LABELS[stamp.marking])}
			</span>
			<span className="font-mono text-[11px] text-muted-foreground tabular-nums leading-4">
				Entered {stampDate(stamp.entryAt)} · Last {last}
			</span>
		</span>
	);
}

/** One stamp, placed on the page with its rotation and nudge. */
function StampButton({
	active,
	country,
	onOpen,
	placement,
	stamp,
}: {
	active: boolean;
	country: PassportCountry | null;
	onOpen: (threadId: string) => void;
	placement: StampPlacement;
	stamp: PassportStamp;
}) {
	const style = country?.style ?? UNASSIGNED_STYLE;
	return (
		<li
			className="absolute"
			style={{
				height: STAMP_HEIGHT,
				left: placement.centerX - STAMP_WIDTH / 2,
				top: `calc((100% - ${STAMP_HEIGHT}px) * ${placement.fraction} + ${placement.nudgeY}px)`,
				width: STAMP_WIDTH,
			}}
		>
			<div className="relative" style={{ rotate: `${stamp.rotation}deg` }}>
				<Tooltip>
					<TooltipTrigger
						delay={700}
						render={
							<button
								aria-current={active ? "true" : undefined}
								aria-label={stampLabel(stamp, country?.agent.name ?? null)}
								className="group/stamp block cursor-pointer mix-blend-multiply outline-none"
								data-thread-id={stamp.thread.id}
								onClick={() => onOpen(stamp.thread.id)}
								type="button"
							/>
						}
					>
						<EntryStamp
							code={country?.code ?? UNASSIGNED_CODE}
							name={country?.agent.name ?? UNASSIGNED_LABEL}
							selected={active}
							stamp={stamp}
							style={style}
						/>
					</TooltipTrigger>
					<TooltipContent
						className="max-w-72 flex-col items-start py-2"
						side="right"
						sideOffset={10}
					>
						<StampDetails
							countryName={country?.agent.name ?? UNASSIGNED_LABEL}
							stamp={stamp}
						/>
					</TooltipContent>
				</Tooltip>
				{active ? <PaperClip shape={style.shape} /> : null}
			</div>
		</li>
	);
}

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
					aria-label={country ? `${country.agent.name} entries` : "Entries"}
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
