import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Kbd } from "@ryu/ui/components/kbd.tsx";
import { Textarea } from "@ryu/ui/components/textarea.tsx";
import { cn } from "@ryu/ui/lib/utils";
import {
	type FormEvent,
	type KeyboardEvent,
	type ReactNode,
	useEffect,
	useId,
	useRef,
	useState,
} from "react";
import { GameSheet } from "./game-shell.tsx";
import {
	MARKING_LABELS,
	type PassportCountry,
	type PassportStamp,
	plural,
	recordNumber,
	type StampMarking,
	stampDate,
	stampDayMonth,
	stampTime,
	UNASSIGNED_CODE,
	UNASSIGNED_LABEL,
	UNASSIGNED_STYLE,
} from "./passport-model.ts";
import { CountryEmblem } from "./passport-stamp.tsx";

const MAX_PROMPT_LENGTH = 8000;

/** Field labels on the record: small tracked capitals, like the paper's. */
const RECORD_CAPTION =
	"font-mono text-[12px] text-muted-foreground uppercase leading-4 tracking-[0.14em]";

/** Theme colour for a marking where it appears in the app's own chrome. */
export const MARKING_TONE: Record<StampMarking, string> = {
	applied: "text-muted-foreground",
	arrived: "font-semibold text-foreground",
	denied: "text-destructive",
	exited: "text-muted-foreground",
	processing: "text-foreground",
};

/** "ARRIVED – AWAITING ENTRY" as "Arrived – awaiting entry". */
function sentenceCase(label: string): string {
	return `${label.slice(0, 1)}${label.slice(1).toLowerCase()}`;
}

function RecordField({
	children,
	label,
}: {
	children: ReactNode;
	label: string;
}) {
	return (
		<div className="flex min-w-0 flex-col gap-1">
			<dt className={RECORD_CAPTION}>{label}</dt>
			<dd className="flex min-w-0 items-baseline gap-1.5 font-medium text-foreground text-sm leading-5">
				{children}
			</dd>
		</div>
	);
}

function CountryValue({ country }: { country: PassportCountry | null }) {
	return (
		<>
			<span className="truncate">
				{country ? country.agent.name : UNASSIGNED_LABEL}
			</span>
			<span className="font-mono font-normal text-[13px] text-muted-foreground">
				{country ? country.code : UNASSIGNED_CODE}
			</span>
		</>
	);
}

/** A record value printed in mono: dates and codes only. */
const MONO_VALUE = "font-mono text-[13px] tabular-nums";

/**
 * The open conversation, filed as an immigration record: the entry's facts
 * on top, and the host's own conversation surface below it.
 */
export function ImmigrationRecord({
	country,
	onClose,
	stamp,
	threadView,
}: {
	country: PassportCountry | null;
	onClose: () => void;
	stamp: PassportStamp | null;
	threadView: ReactNode;
}) {
	const tl = useLiteralMessages();
	const number = stamp
		? recordNumber(country?.code ?? UNASSIGNED_CODE, stamp.thread.id)
		: null;
	const title = stamp?.thread.title || "New entry";
	return (
		<GameSheet
			closeLabel="Close record"
			data-passport-panel=""
			eyebrow={
				number
					? tl("Immigration record · {number}", { number })
					: "Immigration record"
			}
			label="Immigration record"
			leading={
				<CountryEmblem
					code={country?.code ?? UNASSIGNED_CODE}
					neutral={!country}
					size={40}
					style={country?.style ?? UNASSIGNED_STYLE}
					surface="chrome"
				/>
			}
			onClose={onClose}
			sheetKey={stamp?.thread.id ?? "new"}
			title={title}
		>
			<dl className="grid shrink-0 grid-cols-2 gap-x-4 gap-y-3 border-border border-b px-4 pt-3 pb-4">
				<RecordField label="Country">
					<CountryValue country={country} />
				</RecordField>
				<RecordField label="Marking">
					{stamp ? (
						<span className={cn("truncate", MARKING_TONE[stamp.marking])}>
							{sentenceCase(MARKING_LABELS[stamp.marking])}
						</span>
					) : (
						<span className="text-muted-foreground">Pending</span>
					)}
				</RecordField>
				<RecordField label="Entered">
					<span className={MONO_VALUE}>
						{stamp ? stampDate(stamp.entryAt) : "—"}
					</span>
				</RecordField>
				<RecordField label="Latest">
					<span className={MONO_VALUE}>
						{stamp
							? `${stampDayMonth(stamp.latestAt)} · ${stampTime(stamp.latestAt)}`
							: "—"}
					</span>
				</RecordField>
			</dl>
			<div className="flex min-h-0 flex-1 flex-col" data-passport-thread="">
				{threadView}
			</div>
		</GameSheet>
	);
}

/** How many earlier entries the application lists under the form. */
const PREVIOUS_ENTRIES = 3;

/** The country's latest entries, each opening its conversation. */
function PreviousEntries({
	country,
	onOpen,
}: {
	country: PassportCountry;
	onOpen: (threadId: string) => void;
}) {
	const tl = useLiteralMessages();
	const headingId = useId();
	const latest = [...country.stamps]
		.sort((a, b) => b.latestAt - a.latestAt)
		.slice(0, PREVIOUS_ENTRIES);
	return (
		<section aria-labelledby={headingId} className="flex flex-col gap-2">
			<div className="flex items-baseline justify-between gap-2">
				<h3 className={RECORD_CAPTION} id={headingId}>
					Previous entries
				</h3>
				{country.stamps.length > 0 ? (
					<p className="text-[13px] text-muted-foreground tabular-nums">
						{country.stamps.length > PREVIOUS_ENTRIES
							? tl("Latest {shownCount} of {totalCount}", {
									shownCount: String(PREVIOUS_ENTRIES),
									totalCount: String(country.stamps.length),
								})
							: plural(country.stamps.length, "entry", "entries")}
					</p>
				) : null}
			</div>
			{latest.length > 0 ? (
				<ul className="-mx-2 flex flex-col">
					{latest.map((stamp) => (
						<li key={stamp.thread.id}>
							<button
								className="flex h-12 w-full cursor-pointer flex-col justify-center gap-0.5 rounded-md px-2 text-start outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
								onClick={() => onOpen(stamp.thread.id)}
								type="button"
							>
								<span className="flex w-full min-w-0 items-baseline gap-3">
									<span className="min-w-0 flex-1 truncate text-foreground text-sm leading-5">
										{stamp.thread.title || "Untitled conversation"}
									</span>
									<span className="shrink-0 font-mono text-[13px] text-muted-foreground tabular-nums leading-4">
										{stampDayMonth(stamp.latestAt)}
									</span>
								</span>
								<span
									className={cn(
										"truncate text-[13px] leading-4",
										MARKING_TONE[stamp.marking],
										"font-normal"
									)}
								>
									{sentenceCase(MARKING_LABELS[stamp.marking])}
								</span>
							</button>
						</li>
					))}
				</ul>
			) : (
				<p className="text-muted-foreground text-sm leading-5">
					No entries yet. This application starts the first.
				</p>
			)}
		</section>
	);
}

/**
 * A visa application: the first message to an agent. Submitting is the
 * user's explicit send, so it goes straight to `startThread`. Under the form,
 * the country's latest entries, to pick an earlier conversation up instead.
 */
export function VisaApplication({
	country,
	onCancel,
	onOpen,
	onSubmit,
}: {
	country: PassportCountry;
	onCancel: () => void;
	onOpen: (threadId: string) => void;
	onSubmit: (prompt: string) => void;
}) {
	const tl = useLiteralMessages();
	const fieldId = useId();
	const fieldRef = useRef<HTMLTextAreaElement>(null);
	const [prompt, setPrompt] = useState("");
	const [today] = useState(() => Date.now());
	const trimmed = prompt.trim();

	useEffect(() => {
		fieldRef.current?.focus();
	}, []);

	const submit = () => {
		if (trimmed) {
			onSubmit(trimmed);
			setPrompt("");
		}
	};
	const onFormSubmit = (event: FormEvent) => {
		event.preventDefault();
		submit();
	};
	const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
		if (
			event.key === "Enter" &&
			!event.shiftKey &&
			!event.nativeEvent.isComposing
		) {
			event.preventDefault();
			submit();
		} else if (event.key === "Escape") {
			event.preventDefault();
			onCancel();
		}
	};

	return (
		<GameSheet
			closeLabel="Cancel application"
			data-passport-panel=""
			eyebrow="Visa application"
			label="Visa application"
			leading={
				<CountryEmblem
					code={country.code}
					size={40}
					style={country.style}
					surface="chrome"
				/>
			}
			onClose={onCancel}
			sheetKey={`apply:${country.id}`}
			title={country.agent.name}
		>
			<div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
				<dl className="grid grid-cols-[minmax(0,1fr)_auto_auto] gap-x-4 px-4 pt-3 pb-3">
					<RecordField label="Country">
						<span className="truncate">{country.agent.name}</span>
					</RecordField>
					<RecordField label="Code">
						<span className={MONO_VALUE}>{country.code}</span>
					</RecordField>
					<RecordField label="Date">
						<span className={MONO_VALUE}>{stampDayMonth(today)}</span>
					</RecordField>
				</dl>
				<div aria-hidden="true" className="mx-4 border-border border-t" />
				<form
					aria-label={tl("Visa application to {name}", {
						name: country.agent.name,
					})}
					className="flex flex-col gap-3 px-4 pt-4 pb-6"
					onSubmit={onFormSubmit}
				>
					<label className={RECORD_CAPTION} htmlFor={fieldId}>
						Purpose of visit
					</label>
					<Textarea
						className="min-h-32 rounded-md bg-background"
						id={fieldId}
						maxLength={MAX_PROMPT_LENGTH}
						onChange={(event) => setPrompt(event.target.value)}
						onKeyDown={onKeyDown}
						placeholder={tl("What should {name} work on?", {
							name: country.agent.name,
						})}
						ref={fieldRef}
						value={prompt}
					/>
					<div className="flex items-center gap-2">
						<p className="flex items-center gap-1.5 whitespace-nowrap text-[13px] text-muted-foreground max-sm:hidden">
							<Kbd>Enter</Kbd>
							<span>to submit</span>
						</p>
						<Button
							className="ms-auto"
							onClick={onCancel}
							size="sm"
							type="button"
							variant="ghost"
						>
							Cancel
						</Button>
						<Button disabled={!trimmed} size="sm" type="submit">
							Submit application
						</Button>
					</div>
				</form>
				<div aria-hidden="true" className="mx-4 border-border border-t" />
				<div className="px-4 pt-4 pb-4">
					<PreviousEntries country={country} onOpen={onOpen} />
				</div>
			</div>
		</GameSheet>
	);
}
