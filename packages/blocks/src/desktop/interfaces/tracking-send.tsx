import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { cn } from "@ryu/ui/lib/utils";
import type { InterfaceAgent } from "@ryuhq/protocol/interfaces";
import { ArrowLeft, Check } from "lucide-react";
import { useId, useState } from "react";
import { BoardAvatar } from "./board-avatar.tsx";
import { InterfaceComposer } from "./interface-composer.tsx";

/**
 * "Send a parcel": pick a courier the way a checkout picks a delivery
 * service, then write the message. Submitting is the explicit user action
 * that lets the host send (`InterfacePort.startThread`).
 */
export function TrackingSend({
	agents,
	onCancel,
	onSubmit,
}: {
	agents: InterfaceAgent[];
	onCancel: (() => void) | null;
	onSubmit: (input: { agentId?: string; prompt: string }) => void;
}) {
	const tl = useLiteralMessages();
	const groupName = useId();
	const headingId = useId();
	const [pickedId, setPickedId] = useState<string | undefined>();
	const courierId =
		pickedId && agents.some((agent) => agent.id === pickedId)
			? pickedId
			: agents[0]?.id;
	const courier = agents.find((agent) => agent.id === courierId);

	return (
		<section
			aria-labelledby={headingId}
			className="@container mx-auto flex w-full max-w-4xl flex-col px-6 py-6 md:px-10 md:py-8"
			data-testid="tracking-send"
		>
			<div className="flex w-full max-w-2xl flex-col gap-8">
				<header className="flex flex-col gap-1">
					{onCancel ? (
						<Button
							className="mb-3 -ml-2 self-start"
							onClick={onCancel}
							size="sm"
							type="button"
							variant="ghost-muted"
						>
							<ArrowLeft aria-hidden="true" data-icon="inline-start" />
							Back to tracking
						</Button>
					) : null}
					<h1
						className="font-semibold text-2xl text-foreground tracking-tight"
						id={headingId}
					>
						Send a parcel
					</h1>
					<p className="text-muted-foreground text-sm">
						Choose a courier and write what you need. It is sent as soon as you
						submit, and you can track it from My deliveries.
					</p>
				</header>

				{agents.length === 0 ? (
					<div className="flex flex-col gap-1 border-border border-t pt-6">
						<h2 className="font-semibold text-foreground text-sm">
							No couriers yet
						</h2>
						<p className="text-muted-foreground text-sm">
							Parcels are carried by agents. Add an agent, then come back here
							to send one.
						</p>
					</div>
				) : (
					<>
						<fieldset className="flex flex-col">
							<legend className="mb-3 font-semibold text-foreground text-sm">
								Courier
							</legend>
							<div className="grid @lg:grid-cols-2 gap-2">
								{agents.map((agent) => {
									const checked = agent.id === courierId;
									return (
										<label
											className={cn(
												"flex h-14 cursor-pointer items-center gap-3 rounded-md border px-3 transition-colors",
												"has-focus-visible:ring-2 has-focus-visible:ring-ring/50",
												checked
													? "border-primary bg-primary/5"
													: "border-border hover:bg-muted/40"
											)}
											key={agent.id}
										>
											<input
												checked={checked}
												className="sr-only"
												name={groupName}
												onChange={() => setPickedId(agent.id)}
												type="radio"
												value={agent.id}
											/>
											<BoardAvatar agent={agent} name={agent.name} size={28} />
											<span className="flex min-w-0 flex-1 flex-col">
												<span className="flex items-baseline gap-2">
													<span className="truncate font-medium text-foreground text-sm leading-5">
														{agent.name}
													</span>
													{agent.status === "working" ? (
														<span className="shrink-0 text-muted-foreground text-xs leading-5">
															On a run
														</span>
													) : null}
												</span>
												<span className="truncate text-muted-foreground text-xs leading-4">
													{agent.description || "No description"}
												</span>
											</span>
											{checked ? (
												<Check
													aria-hidden="true"
													className="size-4 shrink-0 text-primary"
												/>
											) : null}
										</label>
									);
								})}
							</div>
						</fieldset>
						<div className="flex flex-col gap-3">
							<h2 className="font-semibold text-foreground text-sm">Message</h2>
							<InterfaceComposer
								defaultAgentId={courierId}
								label={
									courier
										? tl("Message for {name}", { name: courier.name })
										: "Message"
								}
								onSubmit={onSubmit}
								placeholder={
									courier
										? tl("What should {name} deliver?", { name: courier.name })
										: "What do you need?"
								}
								submitLabel="Send parcel"
							/>
						</div>
					</>
				)}
			</div>
		</section>
	);
}
