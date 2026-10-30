import { cn } from "@ryu/ui/lib/utils";
import type {
	InterfaceAgent,
	InterfaceEvent,
} from "@ryuhq/protocol/interfaces";
import type { ReactNode } from "react";
import {
	MARKING_LABELS,
	MARKING_MEANINGS,
	MARKING_ORDER,
	mrzLines,
	type Passport,
	stampDate,
	stampDayMonth,
	stampTime,
} from "./passport-model.ts";
import {
	CAPTION,
	GlobeMark,
	type PageSide,
	Paper,
} from "./passport-pages-paper.tsx";
import { EMBOSS, stampInk } from "./passport-palette.ts";
import { usePassportArtId } from "./passport-stamp.tsx";

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
