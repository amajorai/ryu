import { Button } from "@ryu/ui/components/button.tsx";
import { cn } from "@ryu/ui/lib/utils";
import { ArrowLeft } from "lucide-react";
import type { ReactNode } from "react";
import { JobDetailEmpty } from "./jobs-detail.tsx";

/** The quiet detail pane beside a search that matched nothing. */
export function JobsDetailBlank() {
	return (
		<JobDetailEmpty>
			<p
				className="text-muted-foreground text-sm"
				data-testid="jobs-detail-blank"
			>
				No job to preview
			</p>
		</JobDetailEmpty>
	);
}

/** The detail pane before any job is picked (or posted). */
export function JobsDetailPlaceholder({ jobCount }: { jobCount: number }) {
	return (
		<JobDetailEmpty>
			<h2 className="font-sans font-semibold! text-base text-foreground">
				{jobCount === 0 ? "Your jobs show up here" : "No job selected"}
			</h2>
			<p className="max-w-xs text-muted-foreground text-sm">
				{jobCount === 0
					? "Post a job and its details, deliverable, and message thread appear in this pane."
					: "Pick a job from the list to see its details and messages."}
			</p>
		</JobDetailEmpty>
	);
}

/** The Freelancers detail pane before any freelancer is picked. */
export function FreelancerDetailPlaceholder() {
	return (
		<JobDetailEmpty>
			<h2 className="font-sans font-semibold! text-base text-foreground">
				No freelancer selected
			</h2>
			<p className="max-w-xs text-muted-foreground text-sm">
				Freelancers are your agents. Pick one to see their record and hire them
				for a job.
			</p>
		</JobDetailEmpty>
	);
}

/** Stacked widths: the picked freelancer's pane under a back button. */
export function JobsStackedDetail({
	detail,
	setStackedDetail,
}: {
	detail: ReactNode;
	setStackedDetail: (next: boolean) => void;
}) {
	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<div className="flex h-11 shrink-0 items-center border-border border-b px-2">
				<Button
					onClick={() => setStackedDetail(false)}
					size="sm"
					type="button"
					variant="ghost"
				>
					<ArrowLeft aria-hidden="true" data-icon="inline-start" />
					Freelancers
				</Button>
			</div>
			{detail}
		</div>
	);
}

/** Wide widths: the list and the detail side by side. */
export function JobsSplitPanes({
	detail,
	middle,
	railMode,
}: {
	detail: ReactNode;
	middle: ReactNode;
	railMode: boolean;
}) {
	return (
		<>
			<div
				className={cn(
					"flex min-h-0 shrink-0 border-border border-r",
					railMode ? "w-[400px]" : "w-[360px]"
				)}
			>
				{middle}
			</div>
			<div className="flex min-h-0 min-w-0 flex-1">{detail}</div>
		</>
	);
}
