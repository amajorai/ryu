import { useLiteralMessages } from "@ryu/i18n/react";
import type { InterfaceAgent } from "@ryuhq/protocol/interfaces";
import { Warehouse } from "lucide-react";
import type { ReactNode, Ref } from "react";
import { BoardAvatar } from "./board-avatar.tsx";
import {
	cropTitle,
	type FarmCrop,
	type FarmPlot,
	plural,
} from "./farm-model.ts";
import { BarnBody, PlotBody } from "./farm-panel-bodies.tsx";
import { FarmActMode, Ledger } from "./farm-panel-rows.tsx";
import { PlantGlyph } from "./farm-plants.tsx";
import { GameSheet } from "./game-shell.tsx";

export type FarmPanelView =
	| { crop: FarmCrop | undefined; kind: "thread"; plot: FarmPlot | undefined }
	| { kind: "plot"; plot: FarmPlot | null }
	| { kind: "barn" };

/**
 * The side panel: an open conversation under its ledger line (the host's
 * own thread view), a plot with its seed bag and crops, or the barn's list
 * of every crop.
 */
export function FarmPanel(
	props: Parameters<typeof FarmPanelBody>[0] & {
		/** With acts, crop rows drop the legacy status and ages. */
		actMode?: boolean;
	}
) {
	const { actMode = false, ...rest } = props;
	return (
		<FarmActMode.Provider value={actMode}>
			<FarmPanelBody {...rest} />
		</FarmActMode.Provider>
	);
}

function FarmPanelBody({
	activeThreadId,
	agents,
	crops,
	headingRef,
	onClose,
	onOpen,
	onPlant,
	onSelectPlot,
	plotName,
	plots,
	threadView,
	view,
}: {
	activeThreadId: string | null;
	agents: InterfaceAgent[];
	crops: FarmCrop[];
	headingRef: Ref<HTMLHeadingElement>;
	onClose: () => void;
	onOpen: (threadId: string) => void;
	onPlant: (input: { agentId?: string; prompt: string }) => void;
	onSelectPlot: (plotId: string) => void;
	plotName: (crop: FarmCrop) => string;
	plots: FarmPlot[];
	threadView: ReactNode;
	view: FarmPanelView;
}) {
	const tl = useLiteralMessages();
	let label = "Barn";
	if (view.kind === "thread") {
		label = `Conversation: ${cropTitle(view.crop?.thread)}`;
	} else if (view.kind === "plot") {
		label = view.plot
			? tl("{name}'s plot", { name: view.plot.name })
			: "Plant a seed";
	}
	if (view.kind === "thread") {
		return (
			<GameSheet
				closeLabel="Close conversation"
				data-testid="farm-panel"
				data-view="thread"
				headingRef={headingRef}
				label={label}
				leading={
					view.crop ? (
						<span className="grid size-11 place-items-center rounded-full border-(--gk-edge) border-2 bg-(--gk-plate-sunk)">
							<PlantGlyph
								className="size-8"
								fruit={view.crop.fruit}
								stage={view.crop.stage}
							/>
						</span>
					) : undefined
				}
				onClose={onClose}
				sheetKey={`thread:${view.crop?.thread.id ?? ""}`}
				subtitle={
					view.plot ? tl("{name}'s plot", { name: view.plot.name }) : undefined
				}
				title={view.crop ? cropTitle(view.crop.thread) : "New conversation"}
			>
				{view.crop ? <Ledger crop={view.crop} plot={view.plot} /> : null}
				<div className="flex min-h-0 flex-1 flex-col">{threadView}</div>
			</GameSheet>
		);
	}
	if (view.kind === "plot") {
		return (
			<GameSheet
				closeLabel="Close plot"
				data-testid="farm-panel"
				data-view="plot"
				headingRef={headingRef}
				label={label}
				leading={
					view.plot?.agent ? (
						<span className="grid size-10 place-items-center rounded-full border-(--gk-edge) border-2 bg-(--gk-plate-sunk)">
							<BoardAvatar
								agent={view.plot.agent}
								name={view.plot.agent.name}
								size={28}
							/>
						</span>
					) : undefined
				}
				onClose={onClose}
				sheetKey="plot"
				subtitle={
					view.plot
						? `${plural(view.plot.crops.length, "crop")}${view.plot.agent?.status === "working" ? " · Working" : ""}`
						: "Pick a plot, then describe the task"
				}
				title={
					view.plot
						? tl("{name}'s plot", { name: view.plot.name })
						: "Plant a seed"
				}
			>
				<PlotBody
					activeThreadId={activeThreadId}
					agents={agents}
					onOpen={onOpen}
					onPlant={onPlant}
					onSelectPlot={onSelectPlot}
					plot={view.plot}
					plots={plots}
				/>
			</GameSheet>
		);
	}
	return (
		<GameSheet
			closeLabel="Close barn"
			data-testid="farm-panel"
			data-view="barn"
			headingRef={headingRef}
			label={label}
			leading={
				<span className="grid size-10 place-items-center rounded-xl border-(--gk-edge) border-2 bg-(--gk-accent) text-(--gk-accent-ink)">
					<Warehouse aria-hidden="true" className="size-5" strokeWidth={2.25} />
				</span>
			}
			onClose={onClose}
			sheetKey="barn"
			subtitle={tl("{crops} by status", {
				crops: plural(crops.length, "crop"),
			})}
			title="Barn"
		>
			<BarnBody
				activeThreadId={activeThreadId}
				crops={crops}
				onOpen={onOpen}
				plotName={plotName}
			/>
		</GameSheet>
	);
}
