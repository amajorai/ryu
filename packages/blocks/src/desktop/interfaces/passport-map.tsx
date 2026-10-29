import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { cn } from "@ryu/ui/lib/utils";
import { Plus } from "lucide-react";
import { type ReactNode, useId } from "react";
import {
	MARKING_LABELS,
	type Passport,
	type PassportCountry,
	type PassportStamp,
	plural,
	type StampMarking,
	stampDate,
	UNASSIGNED_CODE,
	UNASSIGNED_LABEL,
	UNASSIGNED_STYLE,
} from "./passport-model.ts";
import { CountryEmblem } from "./passport-stamp.tsx";

/** Every row cell: hover and selection paint here so the row reads rounded. */
const CELL =
	"h-10 px-3 align-middle transition-colors first:rounded-s-md last:rounded-e-md group-hover/row:bg-muted/50 group-aria-[current=true]/row:bg-muted motion-reduce:transition-none";
const DATE_CELL =
	"whitespace-nowrap font-mono text-muted-foreground text-xs tabular-nums max-sm:hidden";
const HEAD_CELL = "h-8 border-border border-b px-3 text-start font-normal";

/**
 * A small box that echoes the stamp's outline: dashed while processing,
 * filled for your turn, struck through when refused.
 */
const MARKING_GLYPH: Record<StampMarking, string> = {
	applied: "border border-muted-foreground/70",
	arrived: "border border-foreground bg-foreground",
	denied:
		"border border-destructive bg-[linear-gradient(to_top_right,transparent_calc(50%-0.75px),var(--destructive)_calc(50%-0.75px),var(--destructive)_calc(50%+0.75px),transparent_calc(50%+0.75px))]",
	exited: "border border-muted-foreground bg-muted-foreground/30",
	processing: "border border-foreground border-dashed",
};

const MARKING_TEXT: Record<StampMarking, string> = {
	applied: "text-muted-foreground",
	arrived: "font-medium text-foreground",
	denied: "text-destructive",
	exited: "text-muted-foreground",
	processing: "text-foreground",
};

/** The same markings cut to fit a phone-width column. */
const MARKING_SHORT: Record<StampMarking, string> = {
	applied: "Applied",
	arrived: "Awaiting entry",
	denied: "Entry denied",
	exited: "Exited",
	processing: "Processing",
};

/** "ARRIVED – AWAITING ENTRY" as "Arrived – awaiting entry". */
export function sentenceCase(label: string): string {
	return `${label.slice(0, 1)}${label.slice(1).toLowerCase()}`;
}

function StampRow({
	active,
	onOpen,
	stamp,
}: {
	active: boolean;
	onOpen: (threadId: string) => void;
	stamp: PassportStamp;
}) {
	return (
		<tr
			aria-current={active ? "true" : undefined}
			className="group/row relative"
		>
			<th className={cn(CELL, "text-start font-normal")} scope="row">
				<button
					aria-current={active ? "true" : undefined}
					className="block w-full min-w-0 cursor-pointer truncate text-start text-foreground text-sm outline-none after:absolute after:inset-0 after:rounded-md after:content-[''] focus-visible:after:ring-2 focus-visible:after:ring-ring"
					data-thread-id={stamp.thread.id}
					onClick={() => onOpen(stamp.thread.id)}
					type="button"
				>
					{stamp.thread.title || "Untitled conversation"}
				</button>
			</th>
			<td className={cn(CELL, "whitespace-nowrap text-sm")}>
				<span className="flex min-w-0 items-center gap-2">
					<span
						aria-hidden="true"
						className={cn(
							"size-2.5 shrink-0 rounded-[2px]",
							MARKING_GLYPH[stamp.marking]
						)}
					/>
					<span className={cn("truncate", MARKING_TEXT[stamp.marking])}>
						<span className="max-sm:hidden">
							{sentenceCase(MARKING_LABELS[stamp.marking])}
						</span>
						<span className="sm:hidden">{MARKING_SHORT[stamp.marking]}</span>
					</span>
				</span>
			</td>
			<td className={cn(CELL, DATE_CELL)}>{stampDate(stamp.entryAt)}</td>
			<td className={cn(CELL, DATE_CELL)}>{stampDate(stamp.latestAt)}</td>
		</tr>
	);
}

/**
 * A country's heading row: one cell across the whole table, so nothing in
 * it sits under a column header it does not belong to.
 */
function GroupHeading({
	action,
	code,
	count,
	emblem,
	headingId,
	name,
}: {
	action?: ReactNode;
	code: string;
	count: number;
	emblem: ReactNode;
	headingId: string;
	name: string;
}) {
	return (
		<tr>
			<th
				className="h-14 px-3 pt-4 pb-1 text-start font-normal"
				colSpan={4}
				id={headingId}
				scope="rowgroup"
			>
				<span className="flex min-w-0 items-center gap-3">
					{emblem}
					<span className="flex min-w-0 items-baseline gap-2">
						<span className="truncate font-medium text-foreground text-sm">
							{name}
						</span>
						<span className="shrink-0 text-muted-foreground text-xs tabular-nums">
							{code} · {plural(count, "stamp", "stamps")}
						</span>
					</span>
					{action ? <span className="ms-auto shrink-0">{action}</span> : null}
				</span>
			</th>
		</tr>
	);
}

/** Groups after the first open with a rule across the table. */
const GROUP_RULE =
	"[&:not(:first-of-type)>tr:first-child>th]:border-border [&:not(:first-of-type)>tr:first-child>th]:border-t";

function CountrySection({
	activeThreadId,
	country,
	idPrefix,
	onApply,
	onOpen,
}: {
	activeThreadId: string | null;
	country: PassportCountry;
	idPrefix: string;
	onApply: (agentId: string) => void;
	onOpen: (threadId: string) => void;
}) {
	const tl = useLiteralMessages();
	const headingId = `${idPrefix}-${country.id.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
	return (
		<tbody aria-labelledby={headingId} className={GROUP_RULE}>
			<GroupHeading
				action={
					<Button
						aria-label={tl("Apply for a visa to {name}", {
							name: country.agent.name,
						})}
						className="-me-2"
						onClick={() => onApply(country.id)}
						size="xs"
						variant="ghost"
					>
						<Plus aria-hidden="true" data-icon="inline-start" />
						<span className="max-sm:hidden">Apply for a visa</span>
						<span className="sm:hidden">Apply</span>
					</Button>
				}
				code={country.code}
				count={country.stamps.length}
				emblem={
					<CountryEmblem
						code={country.code}
						size={22}
						style={country.style}
						surface="chrome"
					/>
				}
				headingId={headingId}
				name={country.agent.name}
			/>
			{country.stamps.length > 0 ? (
				[...country.stamps]
					.reverse()
					.map((stamp) => (
						<StampRow
							active={stamp.thread.id === activeThreadId}
							key={stamp.thread.id}
							onOpen={onOpen}
							stamp={stamp}
						/>
					))
			) : (
				<tr>
					<td className="h-10 px-3 text-muted-foreground text-sm" colSpan={4}>
						No entries yet.
					</td>
				</tr>
			)}
		</tbody>
	);
}

/**
 * Map of travels: every country and its stamps as one table, newest entry
 * first. It is the booklet's accessible equivalent and the quick way to scan.
 */
export function TravelMap({
	activeThreadId,
	onApply,
	onOpen,
	passport,
}: {
	activeThreadId: string | null;
	onApply: (agentId: string) => void;
	onOpen: (threadId: string) => void;
	passport: Passport;
}) {
	const idPrefix = `passport-map${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
	const empty =
		passport.countries.length === 0 && passport.unassigned.length === 0;
	if (empty) {
		return (
			<div className="flex flex-1 flex-col items-center justify-center gap-1 px-6 text-center">
				<p className="font-medium text-foreground text-sm">No travels yet</p>
				<p className="max-w-80 text-muted-foreground text-sm">
					Each agent you add becomes a country here, and each conversation with
					it an entry.
				</p>
			</div>
		);
	}
	const unassignedId = `${idPrefix}-unassigned`;
	return (
		<div className="min-h-0 flex-1 overflow-y-auto">
			<div className="mx-auto w-full max-w-4xl px-4 py-4 sm:px-6">
				<table className="w-full table-fixed border-separate border-spacing-0">
					<caption className="sr-only">Map of travels</caption>
					<colgroup>
						<col />
						<col className="w-40 sm:w-56" />
						<col className="w-32 max-sm:w-0" />
						<col className="w-32 max-sm:w-0" />
					</colgroup>
					<thead>
						<tr className="text-muted-foreground text-xs">
							<th className={HEAD_CELL} scope="col">
								Destination
							</th>
							<th className={HEAD_CELL} scope="col">
								Marking
							</th>
							<th className={cn(HEAD_CELL, "max-sm:hidden")} scope="col">
								Entered
							</th>
							<th className={cn(HEAD_CELL, "max-sm:hidden")} scope="col">
								Latest
							</th>
						</tr>
					</thead>
					{passport.countries.map((country) => (
						<CountrySection
							activeThreadId={activeThreadId}
							country={country}
							idPrefix={idPrefix}
							key={country.id}
							onApply={onApply}
							onOpen={onOpen}
						/>
					))}
					{passport.unassigned.length > 0 ? (
						<tbody aria-labelledby={unassignedId} className={GROUP_RULE}>
							<GroupHeading
								code={UNASSIGNED_CODE}
								count={passport.unassigned.length}
								emblem={
									<CountryEmblem
										code={UNASSIGNED_CODE}
										neutral
										size={22}
										style={UNASSIGNED_STYLE}
										surface="chrome"
									/>
								}
								headingId={unassignedId}
								name={UNASSIGNED_LABEL}
							/>
							{[...passport.unassigned].reverse().map((stamp) => (
								<StampRow
									active={stamp.thread.id === activeThreadId}
									key={stamp.thread.id}
									onOpen={onOpen}
									stamp={stamp}
								/>
							))}
						</tbody>
					) : null}
				</table>
			</div>
		</div>
	);
}
