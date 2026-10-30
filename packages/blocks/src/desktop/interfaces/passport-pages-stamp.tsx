import { useLiteralMessages } from "@ryu/i18n/react";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ryu/ui/components/tooltip.tsx";
import {
	MARKING_LABELS,
	type PassportCountry,
	type PassportStamp,
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
import { EntryStamp, STAMP_HEIGHT, STAMP_WIDTH } from "./passport-stamp.tsx";

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
	const tl = useLiteralMessages();
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
				{tl("Entered {entered} · Last {last}", {
					entered: stampDate(stamp.entryAt),
					last,
				})}
			</span>
		</span>
	);
}

/** One stamp, placed on the page with its rotation and nudge. */
export function StampButton({
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
