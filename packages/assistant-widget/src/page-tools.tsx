"use client";

import { Wrench01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Popover,
	PopoverContent,
	PopoverDescription,
	PopoverHeader,
	PopoverTitle,
	PopoverTrigger,
} from "@ryu/ui/components/popover.tsx";
import { useState } from "react";
import { PageToolForm } from "./page-tools-form.tsx";
import { displayTitle, toolCategory } from "./page-tools-schema.ts";
import { ASSISTANT_POPUP_LAYER } from "./skin.ts";
import type { WebMcpPageTool } from "./webmcp.ts";
import type { WebMcpRecord } from "./webmcp-contract.ts";

export interface PageToolsPopoverProps {
	onExecute: (tool: WebMcpPageTool, input: WebMcpRecord) => Promise<string>;
	onResult: (tool: WebMcpPageTool, result: string) => void;
	tools: readonly WebMcpPageTool[];
}

/** Small, explicit affordance for the current page's WebMCP tools. */
export function PageToolsPopover({
	onExecute,
	onResult,
	tools,
}: PageToolsPopoverProps) {
	const [open, setOpen] = useState(false);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	if (tools.length === 0) {
		return null;
	}
	const selected = selectedId
		? tools.find((tool) => tool.id === selectedId)
		: undefined;
	return (
		<Popover
			onOpenChange={(nextOpen) => {
				setOpen(nextOpen);
				if (!nextOpen) {
					setSelectedId(null);
				}
			}}
			open={open}
		>
			<PopoverTrigger
				render={
					<Button
						aria-label={`Page tools (${tools.length})`}
						size="icon-sm"
						title="Page tools"
						variant="ghost-muted"
					>
						<HugeiconsIcon className="size-4" icon={Wrench01Icon} />
					</Button>
				}
			/>
			<PopoverContent
				align="end"
				className="max-h-[calc(100svh-6rem)] w-80 overflow-y-auto"
				data-lenis-prevent=""
				data-ryu-assistant-widget="true"
				onMouseDown={(event) => event.stopPropagation()}
				positionerClassName={ASSISTANT_POPUP_LAYER}
			>
				{selected ? (
					<PageToolForm
						onBack={() => setSelectedId(null)}
						onExecute={onExecute}
						onResult={onResult}
						tool={selected}
					/>
				) : (
					<>
						<PopoverHeader>
							<PopoverTitle>Page tools</PopoverTitle>
							<PopoverDescription>
								Registered by this page. Results are untrusted, and tools that
								change things ask before they run.
							</PopoverDescription>
						</PopoverHeader>
						<div className="mt-2 flex flex-col">
							{tools.map((tool) => (
								<button
									className="flex min-w-0 flex-col rounded-lg px-2 py-1.5 text-left outline-none transition-colors duration-(--duration-fast) hover:bg-foreground/10 focus-visible:bg-foreground/10"
									key={tool.id}
									onClick={() => setSelectedId(tool.id)}
									title={tool.name}
									type="button"
								>
									<span className="truncate font-medium text-sm">
										{displayTitle(tool)}
									</span>
									<span className="truncate text-detail text-muted-foreground">
										{toolCategory(tool)} · {tool.origin ?? "Current page"}
									</span>
								</button>
							))}
						</div>
					</>
				)}
			</PopoverContent>
		</Popover>
	);
}
