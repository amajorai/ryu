import { ChevronLeft, ChevronRight } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import { GameIconButton } from "./game-hud.tsx";
import { GameSheet } from "./game-shell.tsx";
import type { InterfaceRendererProps } from "./interface-renderer.ts";
import { Booklet, type BookTab } from "./passport-booklet.tsx";
import { TravelMap } from "./passport-map.tsx";
import type {
	Passport,
	PassportCountry,
	PassportSpread,
	PassportStamp,
} from "./passport-model.ts";
import type { PassportNavigation } from "./passport-navigation.ts";
import { ImmigrationRecord, VisaApplication } from "./passport-record.tsx";
import { PassportArtProvider } from "./passport-stamp.tsx";

export type PassportSheet = "booklet" | "map";

type RendererProps = InterfaceRendererProps<unknown>;

/**
 * The sheet beside the desk: the open immigration record, a visa
 * application, the booklet up close or the map of travels (or nothing).
 */
export function passportPanel({
	activeCountry,
	activeStamp,
	activeThreadId,
	apply,
	applying,
	bookletVars,
	caption,
	closePanel,
	finishTurn,
	next,
	openStamp,
	passport,
	port,
	previous,
	recordOpen,
	renderPage,
	scale,
	setApplyingTo,
	sheet,
	spread,
	spreads,
	stageRef,
	tabs,
	threadView,
	toggleSheet,
}: {
	activeCountry: PassportCountry | null;
	activeStamp: PassportStamp | null;
	activeThreadId: RendererProps["activeThreadId"];
	apply: (agentId: string) => void;
	applying: PassportCountry | null;
	bookletVars: CSSProperties;
	caption: string;
	closePanel: () => void;
	finishTurn: PassportNavigation["finishTurn"];
	next: PassportNavigation["next"];
	openStamp: (threadId: string) => void;
	passport: Passport;
	port: RendererProps["port"];
	previous: PassportNavigation["previous"];
	recordOpen: boolean;
	renderPage: (page: number, side: "left" | "right" | "single") => ReactNode;
	scale: number;
	setApplyingTo: (agentId: string | null) => void;
	sheet: PassportSheet | null;
	spread: number;
	spreads: readonly PassportSpread[];
	stageRef: { current: HTMLDivElement | null };
	tabs: BookTab[];
	threadView: RendererProps["threadView"];
	toggleSheet: (next: PassportSheet) => void;
}): ReactNode {
	let panel: ReactNode = null;
	if (recordOpen) {
		panel = (
			<ImmigrationRecord
				country={activeCountry}
				onClose={closePanel}
				stamp={activeStamp}
				threadView={threadView}
			/>
		);
	} else if (applying) {
		panel = (
			<VisaApplication
				country={applying}
				onCancel={() => setApplyingTo(null)}
				onOpen={openStamp}
				onSubmit={(prompt) => {
					setApplyingTo(null);
					port.startThread({ agentId: applying.id, prompt });
				}}
			/>
		);
	} else if (sheet === "booklet") {
		panel = (
			<GameSheet
				bleed
				closeLabel="Close passport"
				data-passport-booklet=""
				data-testid="passport-booklet"
				eyebrow={`No. ${passport.number}`}
				footer={
					<nav
						aria-label="Pages"
						className="flex items-center justify-between gap-2"
					>
						<GameIconButton
							disabled={spread <= 0}
							label="Previous page"
							onClick={previous}
							title="Previous page (←)"
						>
							<ChevronLeft
								aria-hidden="true"
								className="size-5"
								strokeWidth={2.75}
							/>
						</GameIconButton>
						<p
							aria-live="polite"
							className="gk-display min-w-36 text-center text-[16px] tabular-nums"
						>
							{caption}
						</p>
						<GameIconButton
							disabled={spread >= spreads.length - 1}
							label="Next page"
							onClick={next}
							title="Next page (→)"
						>
							<ChevronRight
								aria-hidden="true"
								className="size-5"
								strokeWidth={2.75}
							/>
						</GameIconButton>
					</nav>
				}
				label="Passport"
				onClose={() => toggleSheet("booklet")}
				title="Passport"
			>
				<div
					className="flex min-h-0 flex-1 justify-center overflow-y-auto overflow-x-hidden py-3"
					ref={stageRef}
					style={bookletVars}
				>
					<PassportArtProvider>
						<Booklet
							onTurnDone={finishTurn}
							renderPage={renderPage}
							scale={scale}
							single
							smooth={false}
							spreads={spreads}
							tabs={tabs}
							turn={null}
							view={spread}
						/>
					</PassportArtProvider>
				</div>
			</GameSheet>
		);
	} else if (sheet === "map") {
		panel = (
			<GameSheet
				closeLabel="Close the map"
				data-testid="passport-map"
				label="Map of travels"
				onClose={() => toggleSheet("map")}
				title="Map of travels"
			>
				<div
					className="flex min-h-0 flex-1 flex-col overflow-hidden"
					style={bookletVars}
				>
					<PassportArtProvider>
						<TravelMap
							activeThreadId={recordOpen ? activeThreadId : null}
							onApply={apply}
							onOpen={openStamp}
							passport={passport}
						/>
					</PassportArtProvider>
				</div>
			</GameSheet>
		);
	}
	return panel;
}
