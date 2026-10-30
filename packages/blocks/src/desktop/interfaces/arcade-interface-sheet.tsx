import type { ComponentProps, ReactNode, Ref } from "react";
import type { Machine } from "./arcade-model.ts";
import { ArcadePanel, MachineSheet } from "./arcade-panel.tsx";

/** The sheet over the floor: the open ticket's thread, or a picked machine. */
export function ArcadeSheet({
	acts,
	cabinet,
	close,
	openMachine,
	openThread,
	panelHeadingRef,
	selectedMachine,
	setSelectedId,
	threadOpen,
	threadView,
	withActs,
}: {
	acts: ReadonlyMap<string, { ariaLabel?: string }>;
	cabinet: (machine: Machine, zoom: number) => ReactNode;
	close: () => void;
	openMachine: Machine | undefined;
	openThread: ComponentProps<typeof ArcadePanel>["thread"];
	panelHeadingRef: Ref<HTMLHeadingElement>;
	selectedMachine: Machine | undefined;
	setSelectedId: (id: string | null) => void;
	threadOpen: boolean;
	threadView: ReactNode;
	withActs: boolean;
}): ReactNode {
	let sheet: ReactNode = null;
	if (threadOpen) {
		sheet = (
			<ArcadePanel
				headingRef={panelHeadingRef}
				machine={openMachine}
				onClose={close}
				showAge={!withActs}
				thread={openThread}
				threadView={threadView}
			/>
		);
	} else if (selectedMachine) {
		sheet = (
			<MachineSheet
				headingRef={panelHeadingRef}
				machine={selectedMachine}
				onClose={() => setSelectedId(null)}
				summary={
					withActs ? acts.get(selectedMachine.agent.id)?.ariaLabel : undefined
				}
			>
				{cabinet(selectedMachine, 1)}
			</MachineSheet>
		);
	}
	return sheet;
}
