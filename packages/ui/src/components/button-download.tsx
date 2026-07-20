"use client";

import { Button } from "@ryu/ui/components/button.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import { CheckCircle2, Download, Loader2 } from "lucide-react";

interface DownloadButtonProps {
	className?: string;
	downloadStatus: "idle" | "downloading" | "downloaded" | "complete";
	onClick: () => void;
	progress: number;
}

export default function DownloadButton({
	downloadStatus,
	progress,
	onClick,
	className,
}: DownloadButtonProps) {
	// While downloading, the button *is* the progress bar — its background fills
	// from the start edge to `progress` via the shared `progress` Button variant.
	if (downloadStatus === "downloading") {
		return (
			<Button
				aria-disabled
				className={cn("pointer-events-none w-40 rounded-xl", className)}
				progress={progress}
				variant="progress"
			>
				<Loader2 className="h-4 w-4 animate-spin" />
				{progress}%
			</Button>
		);
	}

	return (
		<Button
			className={cn(
				"w-40 rounded-xl",
				downloadStatus !== "idle" && "pointer-events-none",
				className
			)}
			onClick={onClick}
		>
			{downloadStatus === "idle" && (
				<>
					<Download className="h-4 w-4" />
					Download
				</>
			)}
			{downloadStatus === "downloaded" && (
				<>
					<CheckCircle2 className="h-4 w-4" />
					Downloaded
				</>
			)}
			{downloadStatus === "complete" && (
				<span className="text-primary">Download</span>
			)}
		</Button>
	);
}
