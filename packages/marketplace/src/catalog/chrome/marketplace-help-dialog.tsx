"use client";

import {
	HelpCircleIcon,
	Package01Icon,
	PlugSocketIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { AnnouncementVisual } from "@ryu/ui/components/announcement-visual.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@ryu/ui/components/dialog.tsx";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ryu/ui/components/tooltip.tsx";
import { useState } from "react";

const APP_PLUGIN_VISUAL_COLORS = ["#253b80", "#6d4aff", "#da6bff", "#101828"];

/** A compact, plain-language guide for the two easily-confused catalog types. */
export default function MarketplaceHelpDialog() {
	const [open, setOpen] = useState(false);

	return (
		<>
			<Tooltip>
				<TooltipTrigger
					render={
						<Button
							aria-label="About apps and plugins"
							data-testid="marketplace-help-trigger"
							onClick={() => setOpen(true)}
							size="icon-sm"
							variant="ghost"
						>
							<HugeiconsIcon
								aria-hidden
								className="size-4"
								icon={HelpCircleIcon}
							/>
						</Button>
					}
				/>
				<TooltipContent>About apps and plugins</TooltipContent>
			</Tooltip>

			<Dialog onOpenChange={setOpen} open={open}>
				<DialogContent
					className="max-h-[min(90vh,42rem)] max-w-xl overflow-y-auto p-0 sm:max-w-xl"
					data-testid="marketplace-help-dialog"
					overlayClassName="bg-black/55 backdrop-blur-sm"
				>
					<AnnouncementVisual
						accent="#6d4aff"
						backgroundColors={APP_PLUGIN_VISUAL_COLORS}
						className="min-h-[13rem] rounded-none sm:min-h-[16rem] sm:rounded-t-4xl"
						iconContent={<AppsAndPluginsVisual />}
						seed="marketplace-apps-and-plugins"
					/>
					<div className="flex flex-col gap-5 p-6 sm:p-8">
						<DialogHeader className="gap-2 pr-8">
							<p className="font-medium text-[10px] text-muted-foreground uppercase tracking-[0.18em]">
								Marketplace guide
							</p>
							<DialogTitle className="font-medium text-2xl tracking-tight sm:text-3xl">
								Apps &amp; plugins
							</DialogTitle>
							<DialogDescription className="max-w-xl text-sm leading-6">
								Apps are complete experiences you use inside Ryu, like Checks or
								Learning. Plugins add capabilities to Ryu, such as tools,
								skills, agents, and workflows.
							</DialogDescription>
						</DialogHeader>

						<div className="grid gap-3 sm:grid-cols-2">
							<DefinitionCard
								icon={Package01Icon}
								label="Apps"
								question="What do you want to use Ryu for?"
							/>
							<DefinitionCard
								icon={PlugSocketIcon}
								label="Plugins"
								question="What do you want Ryu to do?"
							/>
						</div>
					</div>
				</DialogContent>
			</Dialog>
		</>
	);
}

function AppsAndPluginsVisual() {
	return (
		<div
			aria-hidden="true"
			className="flex items-center gap-3 sm:gap-4"
			data-slot="marketplace-help-visual"
		>
			<VisualIcon icon={Package01Icon} />
			<span className="font-medium text-white/80 text-xl">&amp;</span>
			<VisualIcon icon={PlugSocketIcon} />
		</div>
	);
}

function VisualIcon({ icon }: { icon: IconSvgElement }) {
	return (
		<span className="grid size-20 place-items-center rounded-[1.5rem] border border-white/35 bg-black/15 shadow-2xl ring-1 ring-black/15 backdrop-blur-sm sm:size-24">
			<HugeiconsIcon className="size-10 text-white sm:size-12" icon={icon} />
		</span>
	);
}

function DefinitionCard({
	icon,
	label,
	question,
}: {
	icon: IconSvgElement;
	label: string;
	question: string;
}) {
	return (
		<div className="rounded-2xl border border-border/70 bg-muted/45 p-4">
			<div className="mb-3 flex items-center gap-2">
				<HugeiconsIcon
					aria-hidden
					className="size-4 text-muted-foreground"
					icon={icon}
				/>
				<h3 className="font-medium text-sm">{label}</h3>
			</div>
			<p className="text-muted-foreground text-sm leading-5">{question}</p>
		</div>
	);
}
