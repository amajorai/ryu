import { cn } from "@ryu/ui/lib/utils";
import type { InterfaceAgent } from "@ryuhq/protocol/interfaces";
import { type Ref, useContext, useId } from "react";
import { OrderItemsComposer } from "./warehouse-composer.tsx";
import { aisleLabel, warehouseCount } from "./warehouse-model.ts";
import { PanelHeader } from "./warehouse-order.tsx";
import { FulfillerAvatar, WarehouseActsContext } from "./warehouse-parts.tsx";

/**
 * Create order: pick who fulfils it, describe the items, submit. Submitting
 * is the user's explicit send, so the host may start the thread at once.
 */
export function CreateOrder({
	agentId,
	agents,
	headingRef,
	loadByAgent,
	onBack,
	onPick,
	onSubmit,
}: {
	/** The chosen fulfiller (the root owns it, so the floor can mark them). */
	agentId: string | undefined;
	agents: readonly InterfaceAgent[];
	headingRef: Ref<HTMLHeadingElement>;
	loadByAgent: ReadonlyMap<string, number>;
	onBack: () => void;
	onPick: (agentId: string) => void;
	onSubmit: (input: { agentId?: string; prompt: string }) => void;
}) {
	const acts = useContext(WarehouseActsContext);
	const groupId = useId();
	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<PanelHeader
				backLabel="Back to orders"
				headingRef={headingRef}
				onBack={onBack}
			>
				Create order
			</PanelHeader>
			<div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-4 py-5">
				{agents.length > 0 ? (
					<fieldset className="flex flex-col gap-2">
						<legend className="mb-2 text-muted-foreground text-xs" id={groupId}>
							Fulfiller
						</legend>
						<div className="flex flex-col divide-y divide-border rounded-lg border border-border">
							{agents.map((agent) => {
								const checked = agent.id === agentId;
								const load = loadByAgent.get(agent.id) ?? 0;
								return (
									<label
										className={cn(
											"flex cursor-pointer items-center gap-3 px-3 py-2.5 transition-colors first:rounded-t-lg last:rounded-b-lg has-focus-visible:ring-2 has-focus-visible:ring-ring has-focus-visible:ring-inset",
											checked ? "bg-muted" : "hover:bg-muted/50"
										)}
										key={agent.id}
									>
										<input
											checked={checked}
											className="sr-only"
											name={groupId}
											onChange={() => onPick(agent.id)}
											type="radio"
											value={agent.id}
										/>
										<FulfillerAvatar
											agent={agent}
											className="size-7 [&_[data-slot=avatar-fallback]]:text-xs"
										/>
										<span className="flex min-w-0 flex-1 flex-col">
											<span
												className="truncate font-medium text-foreground text-sm"
												data-ryu-i18n="off"
											>
												{agent.name}
											</span>
											<span className="truncate text-muted-foreground text-xs">
												{acts ? null : <>{aisleLabel(agent.id, agents)} · </>}
												{load === 0
													? "No open orders"
													: warehouseCount(load, "open order")}
											</span>
										</span>
										<span
											aria-hidden="true"
											className={cn(
												"flex size-4 shrink-0 items-center justify-center rounded-full border",
												checked
													? "border-primary bg-primary"
													: "border-muted-foreground/50"
											)}
										>
											{checked ? (
												<span className="size-1.5 rounded-full bg-primary-foreground" />
											) : null}
										</span>
									</label>
								);
							})}
						</div>
					</fieldset>
				) : null}
				<OrderItemsComposer
					fulfillerName={agents.find((agent) => agent.id === agentId)?.name}
					onSubmit={(prompt) => onSubmit({ agentId, prompt })}
				/>
			</div>
		</div>
	);
}
