import { cn } from "@ryu/ui/lib/utils";
import { WindowFrame } from "./mockups.tsx";

const NAV = ["Models", "Runs", "Audit"] as const;
const ACTIVE_NAV: (typeof NAV)[number] = "Runs";

interface ConsoleRun {
	status: "Done" | "Needs approval" | "Running";
	task: string;
}

// Illustrative rows: a task and its status, as Agent lists each run.
const RUNS: readonly ConsoleRun[] = [
	{ task: "Weekly report", status: "Done" },
	{ task: "Invoice follow-up", status: "Needs approval" },
	{ task: "Inbox triage", status: "Running" },
];

function StatusLabel({ status }: { status: ConsoleRun["status"] }) {
	return (
		<span
			className={cn(
				"inline-flex items-center gap-1.5 text-xs",
				status === "Needs approval"
					? "text-foreground"
					: "text-muted-foreground"
			)}
		>
			<span
				aria-hidden="true"
				className={cn(
					"size-1.5 rounded-full",
					status === "Done" && "bg-foreground/30",
					status === "Running" && "bg-foreground/60",
					status === "Needs approval" && "bg-foreground"
				)}
			/>
			{status}
		</span>
	);
}

/** A static Agent window: a short section list on the left, recent runs and their status on the right. */
export function ConsoleWorkflowVisual() {
	return (
		<WindowFrame
			className="w-full min-w-0"
			contentClassName="p-0"
			title="Agent"
		>
			<div
				className="grid min-w-0 grid-cols-1 sm:grid-cols-[9rem_minmax(0,1fr)]"
				data-testid="console-workflow-visual"
			>
				<nav
					aria-label="Agent sections"
					className="hidden border-border border-r p-3 sm:block"
				>
					<ul className="space-y-0.5">
						{NAV.map((item) => (
							<li
								className={cn(
									"rounded-md px-2 py-1.5 text-xs sm:text-sm",
									item === ACTIVE_NAV
										? "bg-muted font-medium text-foreground"
										: "text-muted-foreground"
								)}
								key={item}
							>
								{item}
							</li>
						))}
					</ul>
				</nav>
				<div className="min-w-0 p-3 sm:p-4">
					<p className="font-medium text-foreground text-sm">Recent runs</p>
					<table className="mt-3 w-full table-fixed text-left text-xs sm:text-sm">
						<thead>
							<tr className="text-muted-foreground">
								<th className="pb-2 font-normal">Task</th>
								<th className="w-[40%] pb-2 font-normal">Status</th>
							</tr>
						</thead>
						<tbody>
							{RUNS.map((run) => (
								<tr key={run.task}>
									<td className="truncate py-2.5 pr-2 text-foreground">
										{run.task}
									</td>
									<td className="py-2.5">
										<StatusLabel status={run.status} />
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			</div>
		</WindowFrame>
	);
}
