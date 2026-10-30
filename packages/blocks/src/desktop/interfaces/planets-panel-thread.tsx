import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { cn } from "@ryu/ui/lib/utils";
import {
	type InterfaceThread,
	THREAD_STATUS_LABELS,
	threadStatus,
} from "@ryuhq/protocol/interfaces";
import { ArrowLeft } from "lucide-react";
import type { ReactNode, Ref } from "react";
import type { Planet, PlanetSystem } from "./planets-model.ts";
import { planetLookIn } from "./planets-palette.ts";
import { CloseButton, HEADING } from "./planets-panel-parts.tsx";
import {
	PlanetSwatch,
	PlanetsStatusDot,
	STATUS_TONE,
	threadTitle,
} from "./planets-parts.tsx";

export function ThreadPane({
	headingRef,
	onBack,
	onClose,
	planet,
	system,
	thread,
	threadView,
}: {
	headingRef: Ref<HTMLHeadingElement>;
	onBack: () => void;
	onClose: () => void;
	planet: Planet | undefined;
	system: PlanetSystem;
	thread: InterfaceThread | undefined;
	threadView: ReactNode;
}) {
	const tl = useLiteralMessages();
	const title = threadTitle(thread);
	const status = thread ? threadStatus(thread) : null;
	const backLabel = planet
		? tl("Back to {name}", { name: planet.name })
		: "Back to the system";
	return (
		<>
			<header className="flex h-14 shrink-0 items-center gap-2 border-border border-b ps-2 pe-3">
				<Button
					aria-label={backLabel}
					onClick={onBack}
					size="icon-sm"
					title={backLabel}
					type="button"
					variant="ghost"
				>
					<ArrowLeft aria-hidden="true" />
				</Button>
				{planet ? (
					<PlanetSwatch
						className="size-7"
						look={planetLookIn(system, planet.id)}
						planet={planet}
					/>
				) : null}
				<div className="flex min-w-0 flex-1 flex-col ps-1">
					<h2
						className={cn(HEADING, "font-medium text-sm")}
						ref={headingRef}
						tabIndex={-1}
					>
						{title}
					</h2>
					<p className="flex min-w-0 items-center gap-1.5 truncate text-muted-foreground text-xs leading-tight">
						<span className="truncate">
							{planet ? planet.name : "No agent"}
						</span>
						{status ? (
							<>
								<span aria-hidden="true">·</span>
								<span
									className={cn(
										"inline-flex shrink-0 items-center gap-1.5",
										STATUS_TONE[status]
									)}
								>
									<PlanetsStatusDot className="size-1.5" status={status} />
									{THREAD_STATUS_LABELS[status]}
								</span>
							</>
						) : null}
					</p>
				</div>
				<CloseButton label="Close thread" onClose={onClose} />
			</header>
			<div className="min-h-0 flex-1">{threadView}</div>
		</>
	);
}
