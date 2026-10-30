import { useLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils";
import {
	type PassportCountry,
	stampDate,
	UNASSIGNED_CODE,
	UNASSIGNED_LABEL,
} from "./passport-model.ts";
import { CAPTION } from "./passport-pages-paper.tsx";
import { stampInk } from "./passport-palette.ts";
import { CountryEmblem } from "./passport-stamp.tsx";

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
export function VisaBlock({
	country,
	onApply,
}: {
	country: PassportCountry;
	onApply: (agentId: string) => void;
}) {
	const tl = useLiteralMessages();
	const working = country.agent.status === "working";
	const microprint = `VISA ${country.code} RYU `;
	return (
		<section
			aria-label={tl("{name} visa", { name: country.agent.name })}
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
					aria-label={tl("Apply for a visa to {name}", {
						name: country.agent.name,
					})}
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

export function UnassignedBlock({ count }: { count: number }) {
	const tl = useLiteralMessages();
	return (
		<section
			aria-label={tl("{name} visa", { name: UNASSIGNED_LABEL })}
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
				{tl(
					"{count, plural, one {{countText} conversation} other {{countText} conversations}} with no agent, under the workspace stamp.",
					{ count, countText: String(count) }
				)}
			</p>
		</section>
	);
}
