import { useLiteralMessages } from "@ryu/i18n/react";
import type { InterfaceThread } from "@ryuhq/protocol/interfaces";
import { threadStatus } from "@ryuhq/protocol/interfaces";
import type { ReactNode, Ref } from "react";
import { GameSheet } from "./game-shell.tsx";
import {
	type KitchenStation,
	TICKET_LABELS,
	TICKET_STATE,
} from "./kitchen-model.ts";
import { ChefLeading } from "./kitchen-panel-chef.tsx";
import { StateMark } from "./kitchen-parts.tsx";

export function ThreadPane({
	headingRef,
	onBack,
	onClose,
	station,
	thread,
	threadView,
}: {
	headingRef: Ref<HTMLHeadingElement>;
	onBack: (() => void) | undefined;
	onClose: () => void;
	station: KitchenStation | undefined;
	thread: InterfaceThread | undefined;
	threadView: ReactNode;
}) {
	const tl = useLiteralMessages();
	const state = thread ? TICKET_STATE[threadStatus(thread)] : null;
	const backLabel = station
		? tl("Back to {name}", { name: station.agent.name })
		: "Back to the kitchen";
	return (
		<GameSheet
			backLabel={backLabel}
			closeLabel="Close order"
			data-kitchen-panel=""
			headingRef={headingRef}
			label={tl("Order: {title}", { title: thread?.title ?? "Conversation" })}
			leading={
				station && !onBack ? (
					<ChefLeading agentId={station.agent.id} />
				) : undefined
			}
			onBack={onBack}
			onClose={onClose}
			sheetKey={`thread:${thread?.id ?? ""}`}
			subtitle={
				<>
					{state ? <StateMark state={state} /> : null}
					<span>{state ? TICKET_LABELS[state] : "Starting"}</span>
					{station ? <span>· {station.agent.name}</span> : null}
				</>
			}
			title={thread?.title.trim() || "New order"}
		>
			<div className="min-h-0 flex-1">{threadView}</div>
		</GameSheet>
	);
}
