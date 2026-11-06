import { translate as tr } from "@ryu/i18n/lite";
import type { CSSProperties, ReactNode } from "react";
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
import { PassportPageNav } from "./passport-page-nav.tsx";
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
				eyebrow={tr("No. {number}", { number: passport.number })}
				footer={
					<PassportPageNav
						canNext={spread < spreads.length - 1}
						canPrevious={spread > 0}
						caption={caption}
						next={next}
						previous={previous}
					/>
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
