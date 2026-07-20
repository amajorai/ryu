"use client";

import { buttonVariants } from "@ryu/ui/components/button";
import {
	DropdownMenu,
	DropdownMenuTrigger,
} from "@ryu/ui/components/dropdown-menu";
import { cn } from "@ryu/ui/lib/utils";
import { ChevronDown } from "lucide-react";
import { DownloadDropdownContent } from "./download-dropdown-content.tsx";

export function DownloadMenu({
	className,
	contentAlign = "start",
	label = "Download",
	showChevron = true,
	size = "default",
	variant = "default",
}: {
	className?: string;
	contentAlign?: "center" | "end" | "start";
	label?: string;
	showChevron?: boolean;
	size?: "default" | "lg" | "sm";
	variant?: "default" | "ghost" | "outline";
}) {
	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				className={cn(buttonVariants({ variant, size }), "gap-1.5", className)}
			>
				{label}
				{showChevron ? <ChevronDown className="size-4 opacity-70" /> : null}
			</DropdownMenuTrigger>
			<DownloadDropdownContent align={contentAlign} />
		</DropdownMenu>
	);
}

// biome-ignore lint/performance/noBarrelFile: re-export for consumers that import from download-menu
export { DownloadDropdownContent } from "./download-dropdown-content.tsx";
