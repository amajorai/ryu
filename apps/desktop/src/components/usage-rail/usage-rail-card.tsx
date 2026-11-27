"use client";

// The hover card of a usage ring: every account of the source with its limit
// windows, what each has left and when it resets. It only reads; the Usage
// page, which a click on the ring opens, has the refresh and the history.

import { useLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils.ts";
import { type CSSProperties, useEffect, useState } from "react";
import { formatReset } from "@/components/agent-elements/input/usage-bar-helpers.tsx";
import type { UsageBarMode } from "@/src/hooks/useUsageBarPrefs.ts";
import type {
	RailAccount,
	RailWindow,
	UsageRailSource,
} from "@/src/lib/usage-rail/usage-rail-sources.ts";
import { RailLogoMark } from "./usage-rail-logo.tsx";
import {
	accountStateText,
	limitedText,
	shownPercent,
	sourceKindText,
	windowLine,
} from "./usage-rail-text.ts";
import { usageToneClasses } from "./usage-rail-tone.ts";

/** The reset countdown shows minutes, so a half-minute tick keeps it current. */
const RESET_CLOCK_MS = 30_000;

interface FillStyle extends CSSProperties {
	"--usage-rail-fill": string;
}

/** The clock of an open card. It stops when the card closes. */
function useCardClock(): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const timer = window.setInterval(() => setNow(Date.now()), RESET_CLOCK_MS);
		return () => window.clearInterval(timer);
	}, []);
	return now;
}

function WindowRow({
	mode,
	now,
	window: usageWindow,
}: {
	mode: UsageBarMode;
	now: number;
	window: RailWindow;
}) {
	const tl = useLiteralMessages();
	const shown = shownPercent(usageWindow.usedPercent, mode);
	const tone = usageToneClasses(usageWindow.usedPercent);
	const fill: FillStyle = { "--usage-rail-fill": `${shown}%` };
	const reset = formatReset(usageWindow.resetsAt, tl, now);
	return (
		<span className="grid grid-cols-[minmax(0,1fr)_6rem] items-center gap-x-2 text-xs">
			{/* One whole sentence per mode ("5h: 38% left"), so a language can
			    order the label and the number its own way. */}
			<span className="truncate tabular-nums">
				{windowLine(usageWindow, mode, tl)}
			</span>
			<span
				aria-hidden="true"
				className={cn("h-1 overflow-hidden rounded-full", tone.track)}
			>
				<span
					className={cn(
						"block h-full w-(--usage-rail-fill) rounded-full",
						tone.fill
					)}
					style={fill}
				/>
			</span>
			{reset ? (
				<span className="col-span-2 text-muted-foreground/80">{reset}</span>
			) : null}
		</span>
	);
}

function AccountRows({
	account,
	mode,
	named,
	now,
}: {
	account: RailAccount;
	mode: UsageBarMode;
	/** A source with one unnamed sign-in shows its windows with no account line. */
	named: boolean;
	now: number;
}) {
	const tl = useLiteralMessages();
	return (
		<li
			className="flex flex-col gap-1"
			data-limited={account.limited ? "" : undefined}
			data-testid="usage-rail-account"
		>
			{named ? (
				<span className="flex min-w-0 items-baseline gap-2 text-xs">
					{/* The label is the user's own data (often an email address). */}
					<span className="min-w-0 truncate font-medium" data-ryu-i18n="off">
						{account.label ?? tl("Saved account")}
					</span>
					{account.active ? (
						<span className="shrink-0 text-muted-foreground">
							{tl("active")}
						</span>
					) : null}
				</span>
			) : null}
			{account.limited ? (
				<span className="text-status-destructive text-xs">
					{limitedText(account, tl)}
				</span>
			) : null}
			{account.windows.length > 0 ? (
				account.windows.map((usageWindow) => (
					<WindowRow
						key={usageWindow.key}
						mode={mode}
						now={now}
						window={usageWindow}
					/>
				))
			) : (
				<span className="text-muted-foreground text-xs">
					{accountStateText(account.state, tl)}
				</span>
			)}
		</li>
	);
}

/**
 * One section per source. A ring's own card shows one source; the card of the
 * "+N" ring shows every source behind it and scrolls when they are many.
 */
export function UsageRailCard({
	mode,
	sources,
}: {
	mode: UsageBarMode;
	sources: readonly UsageRailSource[];
}) {
	const tl = useLiteralMessages();
	const now = useCardClock();
	return (
		<div
			className="flex max-h-[min(26rem,70vh)] flex-col gap-3 overflow-y-auto overscroll-contain"
			data-testid="usage-rail-card"
		>
			{sources.map((source) => {
				const named =
					source.accounts.length > 1 ||
					source.accounts.some((account) => account.label !== null);
				return (
					<section className="flex flex-col gap-2" key={source.id}>
						<header className="flex min-w-0 items-center gap-2">
							<RailLogoMark logo={source.logo} size={16} />
							<span className="flex min-w-0 flex-1 flex-col">
								<span
									className="truncate font-medium text-sm"
									data-ryu-i18n="off"
								>
									{source.name}
								</span>
								<span className="truncate text-muted-foreground text-xs">
									{sourceKindText(source, tl)}
								</span>
							</span>
						</header>
						<ul className="flex flex-col gap-2">
							{source.accounts.map((account) => (
								<AccountRows
									account={account}
									key={account.id}
									mode={mode}
									named={named}
									now={now}
								/>
							))}
						</ul>
					</section>
				);
			})}
			<p className="text-muted-foreground/80 text-xs">
				{tl("Select the ring to open the Usage page.")}
			</p>
		</div>
	);
}
