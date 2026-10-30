import type {
	InterfacePort,
	InterfaceSnapshot,
	InterfaceThread,
} from "@ryuhq/protocol/interfaces";
import type { Dispatch, ReactNode, SetStateAction } from "react";
import {
	FlowOverviewPanel,
	type FlowPanelSubject,
	FlowThreadPanel,
} from "./flow-panel.tsx";

/** The details panel's body: the node overview, or the host's open thread. */
export function FlowDetailsBody({
	activeThread,
	now,
	port,
	selectedId,
	setMenuFor,
	setSelectedId,
	snapshot,
	subject,
	threadView,
}: {
	activeThread: InterfaceThread | undefined;
	now: number;
	port: InterfacePort;
	selectedId: string | null;
	setMenuFor: Dispatch<SetStateAction<string | null>>;
	setSelectedId: Dispatch<SetStateAction<string | null>>;
	snapshot: InterfaceSnapshot;
	subject: FlowPanelSubject | null;
	threadView: ReactNode | null;
}) {
	return threadView === null ? (
		subject ? (
			<FlowOverviewPanel
				now={now}
				onClose={() => setSelectedId(null)}
				onNew={
					subject.scope.kind === "all"
						? null
						: () => {
								const owner = selectedId;
								if (owner) {
									setMenuFor(owner);
								}
							}
				}
				onOpenThread={(threadId) => {
					setSelectedId(null);
					port.openThread(threadId);
				}}
				snapshot={snapshot}
				subject={subject}
			/>
		) : null
	) : (
		<FlowThreadPanel
			onClose={() => port.closeThread()}
			thread={activeThread}
			threadView={threadView}
		/>
	);
}
