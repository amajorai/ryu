import { useLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils";
import type { InterfaceAgent } from "@ryuhq/protocol/interfaces";
import { chaseStyle, legibleSize } from "./arcade-cabinet-lamps.tsx";
import { ARCADE_FOCUS } from "./arcade-focus.ts";
import {
	type Machine,
	meterDigits,
	sharedWith,
	threadTitle,
} from "./arcade-model.ts";
import { type ArcadePalette, bulbGlow } from "./arcade-palette.ts";

const TRAY_TICKETS = 2;
/** Below this floor zoom a ticket drops its barcode to give the title room. */
const TICKET_BARCODE_ZOOM = 0.85;

export function Meter({
	acted = false,
	blink,
	machine,
	palette,
	zoom,
}: {
	/** The act layer is on: only the credits; no legacy WIN or TILT. */
	acted?: boolean;
	blink: boolean;
	machine: Machine;
	palette: ArcadePalette;
	zoom: number;
}) {
	const tl = useLiteralMessages();
	const wins = machine.jackpots.length;
	const labelSize = legibleSize(11, zoom, 10);
	// Enlarged labels give up their tracking so the row still fits.
	const labelTracking = labelSize > 11 ? "0.02em" : "0.12em";
	return (
		<div
			aria-hidden="true"
			className="flex h-7 items-center justify-between rounded-[4px] px-2 font-mono tabular-nums"
			style={{ background: palette.ledBackground }}
			title={
				acted
					? tl(
							"Credit: {count, plural, one {{credits} message} other {{credits} messages}} in conversations {name} leads.",
							{
								count: machine.credits,
								credits: String(machine.credits),
								name: machine.name,
							}
						)
					: tl(
							"Credit: {count, plural, one {{credits} message} other {{credits} messages}} in conversations {name} leads. Win: {wins, plural, one {{winsText} reply} other {{winsText} replys}} waiting on you.",
							{
								count: machine.credits,
								credits: String(machine.credits),
								name: machine.name,
								wins,
								winsText: String(wins),
							}
						)
			}
		>
			<span className="flex items-baseline gap-1.5">
				<span
					className="leading-none"
					style={{
						color: palette.ledLabel,
						fontSize: labelSize,
						letterSpacing: labelTracking,
					}}
				>
					CREDIT
				</span>
				<span
					className="font-semibold text-[16px] leading-none"
					style={{ color: palette.ledLit }}
				>
					{meterDigits(machine.credits)}
				</span>
			</span>
			{acted ? null : machine.tilt ? (
				<span
					className="font-bold text-[14px] leading-none tracking-[0.2em]"
					style={{
						...chaseStyle(blink, "arcade-blink", "0.9s", "steps(1, end)"),
						color: palette.ledTilt,
						textShadow: bulbGlow(palette.mode, palette.ledTilt),
					}}
				>
					TILT
				</span>
			) : (
				<span className="flex items-baseline gap-1.5">
					<span
						className="leading-none"
						style={{
							color: palette.ledLabel,
							fontSize: labelSize,
							letterSpacing: labelTracking,
						}}
					>
						WIN
					</span>
					<span
						className="font-semibold text-[16px] leading-none"
						// No win reads as an unlit meter, still legible: label colour.
						style={{ color: wins > 0 ? palette.ledLit : palette.ledLabel }}
					>
						{meterDigits(wins, 2)}
					</span>
				</span>
			)}
		</div>
	);
}
/** A few coins lying on the tray's ledge. */
function Coins({ palette }: { palette: ArcadePalette }) {
	const coins = [6, 15, 24];
	return (
		<svg
			aria-hidden="true"
			className="shrink-0"
			height={10}
			viewBox="0 0 32 10"
			width={32}
		>
			{coins.map((cx) => (
				<g key={cx}>
					<ellipse cx={cx} cy={5.5} fill={palette.coinEdge} rx={5.5} ry={3} />
					<ellipse
						cx={cx}
						cy={4.5}
						fill={palette.coin}
						rx={5.5}
						ry={3}
						stroke={palette.coinEdge}
						strokeWidth={0.75}
					/>
				</g>
			))}
		</svg>
	);
}
function Ticket({
	active,
	id,
	onOpen,
	palette,
	shared,
	tall,
	title,
	zoom,
}: {
	active: boolean;
	id: string;
	onOpen: () => void;
	palette: ArcadePalette;
	/** Other agents on this conversation (it has a ticket in their trays too). */
	shared: string[];
	/** The only ticket in the tray: room for two lines of title. */
	tall: boolean;
	title: string;
	zoom: number;
}) {
	const tl = useLiteralMessages();
	const barcode = zoom >= TICKET_BARCODE_ZOOM;
	const withOthers =
		shared.length > 0 ? `${title}, with ${shared.join(", ")}` : title;
	return (
		<button
			aria-current={active ? "true" : undefined}
			aria-label={tl("Cash ticket: open {withOthers}", { withOthers })}
			className={cn(
				"flex w-full items-center gap-2 rounded-[2px] pr-2 text-left transition-transform duration-100 hover:-translate-y-px",
				barcode ? "pl-1.5" : "pl-2",
				tall ? "h-12" : "h-[22px]",
				ARCADE_FOCUS
			)}
			data-arcade-stop={`ticket-${id}`}
			data-arcade-ticket={active ? "open" : undefined}
			onClick={onOpen}
			style={{
				background: palette.ticket,
				// The ticket being redeemed is lit along its edge, like its reel.
				boxShadow: active ? `inset 0 0 0 2px ${palette.selected}` : undefined,
				color: palette.ticketInk,
			}}
			title={withOthers}
			type="button"
		>
			{barcode ? (
				<span
					aria-hidden="true"
					className={cn("w-3 shrink-0", tall ? "h-8" : "h-3")}
					style={{ background: palette.ticketStripes }}
				/>
			) : null}
			<span
				className={cn(
					"min-w-0 flex-1 font-medium",
					tall ? "line-clamp-2" : "truncate"
				)}
				style={{
					fontSize: legibleSize(12, zoom, 11),
					lineHeight: tall ? 1.3 : 1.2,
				}}
			>
				{title}
			</span>
		</button>
	);
}
export function Tray({
	activeThreadId,
	agents,
	machine,
	onOpen,
	palette,
	zoom,
}: {
	activeThreadId: string | null;
	agents: readonly InterfaceAgent[];
	machine: Machine;
	onOpen: (threadId: string) => void;
	palette: ArcadePalette;
	zoom: number;
}) {
	const tl = useLiteralMessages();
	const shown = machine.jackpots.slice(0, TRAY_TICKETS);
	const extra = machine.jackpots.length - shown.length;
	const style = {
		background: palette.tray,
		boxShadow: `inset 0 4px 8px ${palette.floorShadow}`,
	};
	if (shown.length === 0) {
		return (
			<div
				className="flex h-[72px] items-center justify-center rounded-[6px]"
				style={style}
			>
				<span
					aria-hidden="true"
					className="font-bold font-mono text-[11px] tracking-[0.32em]"
					style={{ color: palette.trayText }}
				>
					PAYOUT
				</span>
			</div>
		);
	}
	return (
		<div
			className="flex h-[72px] flex-col gap-1 rounded-[6px] px-2 pt-2"
			style={style}
		>
			<ul
				aria-label={tl(
					"Payout tray: {count, plural, one {{countText} reply} other {{countText} replys}} waiting on you",
					{
						count: machine.jackpots.length,
						countText: String(machine.jackpots.length),
					}
				)}
				className="flex h-12 flex-col justify-start gap-1"
			>
				{shown.map((thread) => (
					<li key={thread.id}>
						<Ticket
							active={thread.id === activeThreadId}
							id={thread.id}
							onOpen={() => onOpen(thread.id)}
							palette={palette}
							shared={sharedWith(thread, machine, agents)}
							tall={shown.length === 1}
							title={threadTitle(thread)}
							zoom={zoom}
						/>
					</li>
				))}
			</ul>
			<span aria-hidden="true" className="flex h-3 items-center gap-1.5">
				<Coins palette={palette} />
				{extra > 0 ? (
					<span
						className="font-bold font-mono text-[11px] leading-3"
						style={{ color: palette.coin }}
					>
						+{extra}
					</span>
				) : null}
			</span>
		</div>
	);
}
