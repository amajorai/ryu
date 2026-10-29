import { useLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils";
import type {
	InterfaceAgent,
	InterfaceEvent,
} from "@ryuhq/protocol/interfaces";
import type { ReactNode } from "react";
import {
	MARKING_LABELS,
	MARKING_ORDER,
	mrzLines,
	type Passport,
	type PassportCountry,
	type PassportPage,
	type PassportStamp,
	plural,
	stampDate,
	stampDayMonth,
	stampLabel,
	stampTime,
	UNASSIGNED_CODE,
	UNASSIGNED_LABEL,
	UNASSIGNED_STYLE,
} from "./passport-model.ts";
import { PAGE_HEIGHT, PAGE_WIDTH } from "./passport-pages.tsx";
import { DESK_FACE_VARS, PASSPORT_VARS, stampInk } from "./passport-palette.ts";
import {
	CountryEmblem,
	EntryStamp,
	PassportArtProvider,
	STAMP_HEIGHT,
	STAMP_WIDTH,
} from "./passport-stamp.tsx";

/**
 * What the desk's booklet prints on a page: the page's face, laid flat on
 * the 3D paper (passport-desk.tsx). It is the 2D booklet's page reset in
 * larger, heavier type and darker inks (DESK_FACE_VARS), its stamps at full
 * ink with their date and destination enlarged, since the camera looks at
 * it from a low angle and at a small size; and with no
 * paper of its own: the toon-lit page under it is the paper, and the photo
 * frame is left empty for the agent's villager, who stands in it.
 */

/** A face is drawn at the 2D page's size; the desk scales it to the page. */
export const FACE_WIDTH = PAGE_WIDTH;
export const FACE_HEIGHT = PAGE_HEIGHT;

/** The photo frame on a visa page's first page, in face px. */
export const PHOTO_FRAME = { height: 168, left: 24, top: 56, width: 132 };
/** Where the villager's feet stand in the frame, in face px. */
export const PHOTO_FEET = {
	x: PHOTO_FRAME.left + PHOTO_FRAME.width / 2,
	y: PHOTO_FRAME.top + PHOTO_FRAME.height - 22,
};

const CAPTION =
	"font-mono font-semibold text-(--pp-ink-muted) text-[18px] uppercase leading-5 tracking-[0.12em]";

function Face({
	children,
	header,
	number,
}: {
	children: ReactNode;
	header: string;
	number: number | null;
}) {
	return (
		<PassportArtProvider>
			<div
				className="relative flex flex-col px-6 pt-5 pb-4 text-(--pp-ink)"
				data-passport-face=""
				style={{ ...DESK_FACE_VARS, height: FACE_HEIGHT, width: FACE_WIDTH }}
			>
				<div className="flex h-7 items-center justify-between">
					<span className={CAPTION}>{header}</span>
					<span className={cn(CAPTION, "tracking-[0.3em]")}>RYU</span>
				</div>
				<div className="relative mt-2 flex min-h-0 flex-1 flex-col">
					{children}
				</div>
				{number === null ? null : (
					<p className="mt-2 text-end font-mono font-semibold text-(--pp-ink-muted) text-[18px] tabular-nums leading-5">
						{number}
					</p>
				)}
			</div>
		</PassportArtProvider>
	);
}

/** One stamp on the face: a button that opens its conversation. */
function FaceStamp({
	active,
	country,
	onOpen,
	stamp,
}: {
	active: boolean;
	country: PassportCountry | null;
	onOpen: (threadId: string) => void;
	stamp: PassportStamp;
}) {
	return (
		<li
			className="grid place-items-center"
			style={{ height: STAMP_HEIGHT, width: STAMP_WIDTH }}
		>
			<button
				aria-current={active ? "true" : undefined}
				aria-label={stampLabel(stamp, country?.agent.name ?? null)}
				className="group/stamp pointer-events-auto block cursor-pointer outline-none"
				data-thread-id={stamp.thread.id}
				onClick={() => onOpen(stamp.thread.id)}
				style={{ rotate: `${stamp.rotation}deg` }}
				type="button"
			>
				<EntryStamp
					code={country?.code ?? UNASSIGNED_CODE}
					large
					name={country?.agent.name ?? UNASSIGNED_LABEL}
					selected={active}
					stamp={stamp}
					style={country?.style ?? UNASSIGNED_STYLE}
				/>
			</button>
		</li>
	);
}

/** A visa page's face: photo, name, emblem and status, then the stamps. */
export function VisaFace({
	activeThreadId,
	country,
	onOpen,
	page,
	status,
}: {
	activeThreadId: string | null;
	country: PassportCountry | null;
	onOpen: (threadId: string) => void;
	page: Extract<PassportPage, { kind: "visa" }>;
	/** The agent's status line ("Waiting for your signature"). */
	status: string | null;
}) {
	const tl = useLiteralMessages();
	const code = country?.code ?? UNASSIGNED_CODE;
	const name = country?.agent.name ?? UNASSIGNED_LABEL;
	return (
		<Face
			header={`Visas · ${code}${page.first ? "" : " (cont.)"}`}
			number={page.number}
		>
			{page.first ? (
				<div className="flex h-[168px] gap-4">
					{/* The frame stays empty: the agent's villager stands in it. */}
					<div
						aria-hidden="true"
						className="relative shrink-0 rounded-[3px] border-(--pp-rule) border-2"
						style={{
							height: PHOTO_FRAME.height,
							width: PHOTO_FRAME.width,
						}}
					>
						<span className="absolute inset-x-0 bottom-1 text-center font-mono text-(--pp-ink-muted) text-[10px] tracking-[0.2em]">
							PHOTO
						</span>
					</div>
					<div className="flex min-w-0 flex-1 flex-col gap-1.5">
						<h2 className="truncate font-bold font-serif text-[50px] leading-[52px]">
							{name}
						</h2>
						<div className="flex items-center gap-3">
							<CountryEmblem
								code={code}
								neutral={country === null}
								size={52}
								style={country?.style ?? UNASSIGNED_STYLE}
								textured
							/>
							<span className="font-bold font-mono text-[24px] tracking-[0.16em]">
								{code}
							</span>
						</div>
						{status ? (
							<p
								className="line-clamp-2 font-bold font-mono text-[20px] uppercase leading-6 tracking-[0.06em]"
								data-visa-status=""
								style={{
									color: country ? stampInk(country.style.ink) : undefined,
								}}
							>
								{status}
							</p>
						) : null}
					</div>
				</div>
			) : null}
			{page.stamps.length > 0 ? (
				<ol
					aria-label={tl("{name} entries", { name })}
					className="mt-3 grid grid-cols-2 justify-items-center gap-x-2 gap-y-1"
				>
					{page.stamps.map((stamp) => (
						<FaceStamp
							active={stamp.thread.id === activeThreadId}
							country={country}
							key={stamp.thread.id}
							onOpen={onOpen}
							stamp={stamp}
						/>
					))}
				</ol>
			) : (
				<p className="mt-8 text-center font-bold font-mono text-[18px] uppercase tracking-[0.16em]">
					No entries recorded
				</p>
			)}
		</Face>
	);
}

/** The identity page's face: the holder, the totals and the summary line. */
export function IdentityFace({
	number,
	passport,
	summary,
}: {
	number: number;
	passport: Passport;
	/** The HUD's summary line ("3 need you · 2 working"), or the totals. */
	summary: string;
}) {
	const [first, second] = mrzLines(passport);
	const totals = [
		{ label: "Countries", value: passport.totals.countries },
		{ label: "Stamps", value: passport.totals.stamps },
		{ label: "Days", value: passport.totals.travelDays },
	];
	return (
		<Face header="Passport · Type P" number={number}>
			<dl className="grid grid-cols-2 gap-x-4 gap-y-3">
				<div className="col-span-2 flex flex-col">
					<dt className={CAPTION}>Holder</dt>
					<dd className="font-semibold font-serif text-[40px] leading-[46px]">
						You
					</dd>
				</div>
				<div className="flex flex-col">
					<dt className={CAPTION}>Passport no.</dt>
					<dd className="font-mono font-semibold text-[18px] leading-6">
						{passport.number}
					</dd>
				</div>
				<div className="flex flex-col">
					<dt className={CAPTION}>Issued</dt>
					<dd className="font-mono font-semibold text-[18px] leading-6">
						{passport.issuedAt === null ? "—" : stampDate(passport.issuedAt)}
					</dd>
				</div>
			</dl>
			<dl className="mt-5 grid grid-cols-3 border-(--pp-rule) border-y-2">
				{totals.map((total) => (
					<div className="flex flex-col py-3" key={total.label}>
						<dt className={CAPTION}>{total.label}</dt>
						<dd className="font-semibold font-serif text-[46px] tabular-nums leading-[52px]">
							{total.value}
						</dd>
					</div>
				))}
			</dl>
			<p
				className="mt-5 font-bold text-[24px] leading-8"
				data-identity-summary=""
			>
				{summary}
			</p>
			<div
				aria-label="Machine-readable zone"
				className="mt-auto flex flex-col gap-1 font-mono text-[12px] leading-4 tracking-[0.02em]"
				role="img"
			>
				<span className="whitespace-pre">{first}</span>
				<span className="whitespace-pre">{second}</span>
			</div>
		</Face>
	);
}

/** Inside the front cover: the markings and the scheduled travel. */
export function NotesFace({
	agents,
	number,
	upcoming,
}: {
	agents: readonly InterfaceAgent[];
	number: number;
	upcoming: readonly InterfaceEvent[];
}) {
	return (
		<Face header="Notes" number={number}>
			<h2 className="font-semibold font-serif text-[30px] leading-9">
				Markings
			</h2>
			<ul className="mt-2 flex flex-wrap gap-2">
				{MARKING_ORDER.map((marking) => (
					<li
						className={cn(
							"rounded-[4px] border-2 border-current px-2 py-0.5 font-mono font-semibold text-[15px] uppercase tracking-[0.08em]",
							marking === "denied" && "text-(--pp-denied)",
							marking === "processing" && "border-dashed",
							marking === "applied" && "opacity-70"
						)}
						key={marking}
					>
						{MARKING_LABELS[marking]}
					</li>
				))}
			</ul>
			<h2 className="mt-6 font-semibold font-serif text-[30px] leading-9">
				Scheduled travel
			</h2>
			{upcoming.length > 0 ? (
				<ol className="mt-2 flex flex-col gap-2">
					{upcoming.map((event) => {
						const start = Date.parse(event.start);
						const agent = agents.find((item) => item.id === event.agentId);
						return (
							<li className="flex flex-col" key={event.id}>
								<span className="font-mono text-[14px] tabular-nums">
									{stampDayMonth(start)} {stampTime(start)}
									{agent ? ` · ${agent.name}` : ""}
								</span>
								<span className="truncate font-medium text-[18px] leading-6">
									{event.title}
								</span>
							</li>
						);
					})}
				</ol>
			) : (
				<p className="mt-2 text-(--pp-ink-muted) text-[18px]">
					Nothing scheduled.
				</p>
			)}
		</Face>
	);
}

/** A page with nothing on it yet; with no countries at all, it says why. */
export function BlankFace({
	empty,
	number,
}: {
	empty: boolean;
	number: number;
}) {
	return (
		<Face header="Visas" number={number}>
			{empty ? (
				<div className="flex flex-1 flex-col items-center justify-center gap-2 text-center">
					<p className="font-mono font-semibold text-[16px] uppercase tracking-[0.2em]">
						No visas issued
					</p>
					<p className="text-(--pp-ink-muted) text-[17px] leading-6">
						Each agent gets a visa page here, and each conversation with it a
						stamp.
					</p>
				</div>
			) : null}
		</Face>
	);
}

/** The closed booklet's front board, in foil. */
export function CoverFace({ stamps }: { stamps: number }) {
	return (
		<div
			className="flex flex-col items-center justify-between px-8 pt-16 pb-14 text-(--pp-foil)"
			data-passport-face=""
			style={{ ...PASSPORT_VARS, height: FACE_HEIGHT, width: FACE_WIDTH }}
		>
			<span className="font-serif text-[20px] uppercase tracking-[0.42em]">
				Ryu Workspace
			</span>
			<span className="font-semibold font-serif text-[46px] uppercase leading-none tracking-[0.3em]">
				Passport
			</span>
			<span className="font-mono text-[15px] uppercase tracking-[0.3em]">
				{plural(stamps, "stamp", "stamps")}
			</span>
		</div>
	);
}
