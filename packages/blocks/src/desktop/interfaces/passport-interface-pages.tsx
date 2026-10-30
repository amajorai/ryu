import { formatMessage } from "@ryu/i18n/core";
import type { LiteralMessage } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils";
import type { InterfaceAgentAct } from "@ryuhq/protocol/interfaces";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { GAME_FOCUS, GAME_PLATE, GameIconButton } from "./game-hud.tsx";
import { deniedOf } from "./passport-acts.tsx";
import {
	countryPage,
	type Passport,
	type PassportCountry,
	type PassportSpread,
	UNASSIGNED_CODE,
	UNASSIGNED_LABEL,
} from "./passport-model.ts";
import { chromeInk } from "./passport-palette.ts";

/** English formatting for callers outside a React tree (tests, plain code). */
const englishLiteral: LiteralMessage = (source, values) =>
	formatMessage(source, values);

/** "Cover", "Page 3 of 12" or "Pages 3–4 of 12". */
export function spreadCaption(
	spread: PassportSpread | undefined,
	pageCount: number,
	tl: LiteralMessage = englishLiteral
): string {
	if (!spread || spread.right === 0) {
		return "Cover";
	}
	const last = pageCount - 1;
	const pages = [spread.left, spread.right].filter(
		(page): page is number => page !== null
	);
	return pages.length > 1
		? tl("Pages {first}–{second} of {last}", {
				first: String(pages[0]),
				last: String(last),
				second: String(pages[1]),
			})
		: tl("Page {first} of {last}", {
				first: String(pages[0]),
				last: String(last),
			});
}

/**
 * A visa page's status line from its agent's act: where the agent stands,
 * in the passport's words. Without the act layer, only a running agent
 * says anything ("In session now").
 */
export function visaStatus(
	country: PassportCountry | null,
	act: InterfaceAgentAct | undefined
): string | null {
	if (!country) {
		return null;
	}
	if (!act) {
		return country.agent.status === "working" ? "In session now" : null;
	}
	switch (act.act) {
		case "asking":
			return "Waiting for your signature";
		case "blocked":
			return deniedOf(act) ? "Entry denied" : "Stopped";
		case "limited":
			return "Border closed";
		case "working":
			return act.stalled ? "May have stopped" : "Processing";
		case "delivering":
			return "Answer ready";
		case "waiting":
			return "Waiting to start";
		default:
			return "Cleared";
	}
}

/** One page tab in the HUD: the identity page, or a country's visa pages. */
export interface PageTab {
	active: boolean;
	code: string;
	/** The country's stamp ink index (null: the passport's own pages). */
	ink: number | null;
	label: string;
	page: number;
}

/** The page tabs, in page order: identity, every country, unassigned. */
export function pageTabs(
	passport: Passport,
	spread: PassportSpread | undefined,
	tl: LiteralMessage = englishLiteral
): PageTab[] {
	const onSpread = (page: number) =>
		page >= 0 && (spread?.left === page || spread?.right === page);
	const identity = passport.pages.findIndex((page) => page.kind === "identity");
	const tabs: PageTab[] = [
		{
			active: onSpread(identity),
			code: "ID",
			ink: null,
			label: "Identity page",
			page: identity,
		},
	];
	for (const country of passport.countries) {
		const pages = passport.pages.flatMap((page, index) =>
			page.kind === "visa" && page.countryId === country.id ? [index] : []
		);
		tabs.push({
			active: pages.some(onSpread),
			code: country.code,
			ink: country.style.ink,
			label: tl("{name} visa pages", { name: country.agent.name }),
			page: countryPage(passport.pages, country.id),
		});
	}
	const unassigned = countryPage(passport.pages, null);
	if (unassigned > 0) {
		tabs.push({
			active: onSpread(unassigned),
			code: UNASSIGNED_CODE,
			ink: null,
			label: tl("{name} visa pages", { name: UNASSIGNED_LABEL }),
			page: unassigned,
		});
	}
	return tabs;
}

/**
 * The booklet's page controls in the HUD: previous and next page, where
 * the booklet is open, and a tab per page to turn straight to it (on a
 * phone the tabs scroll sideways under the arrows).
 */
export function PageNav({
	caption,
	compact,
	hasNext,
	hasPrevious,
	onNext,
	onPage,
	onPrevious,
	tabs,
}: {
	caption: string;
	compact: boolean;
	hasNext: boolean;
	hasPrevious: boolean;
	onNext: () => void;
	onPage: (page: number) => void;
	onPrevious: () => void;
	tabs: readonly PageTab[];
}) {
	return (
		<nav
			aria-label="Passport pages"
			className={cn(
				GAME_PLATE,
				"pointer-events-auto flex min-w-0 gap-2 p-1.5",
				compact ? "flex-col items-stretch" : "items-center"
			)}
			data-passport-pages=""
		>
			<div className="flex shrink-0 items-center justify-between gap-1">
				<GameIconButton
					disabled={!hasPrevious}
					label="Previous page"
					onClick={onPrevious}
					title="Previous page (Page Up)"
				>
					<ChevronLeft
						aria-hidden="true"
						className="size-5"
						strokeWidth={2.75}
					/>
				</GameIconButton>
				<p
					aria-live="polite"
					className="gk-display min-w-32 text-center text-[15px] tabular-nums"
					data-page-caption=""
				>
					{caption}
				</p>
				<GameIconButton
					disabled={!hasNext}
					label="Next page"
					onClick={onNext}
					title="Next page (Page Down)"
				>
					<ChevronRight
						aria-hidden="true"
						className="size-5"
						strokeWidth={2.75}
					/>
				</GameIconButton>
			</div>
			<ul
				aria-label="Page tabs"
				className="flex min-w-0 gap-1 overflow-x-auto p-0.5"
			>
				{tabs.map((tab) => (
					<li className="shrink-0" key={tab.code}>
						<button
							aria-current={tab.active ? "page" : undefined}
							aria-label={tab.label}
							className={cn(
								"gk-display grid h-9 min-w-11 place-items-center rounded-lg border-2 px-1.5 font-mono text-[12px] tracking-[0.04em] transition-colors hover:bg-(--gk-plate-sunk)",
								tab.active
									? "border-(--gk-edge) bg-(--gk-plate-sunk)"
									: "border-transparent",
								GAME_FOCUS
							)}
							data-page-tab={tab.code}
							onClick={() => onPage(tab.page)}
							style={
								tab.ink === null ? undefined : { color: chromeInk(tab.ink) }
							}
							title={tab.label}
							type="button"
						>
							{tab.code}
						</button>
					</li>
				))}
			</ul>
		</nav>
	);
}
