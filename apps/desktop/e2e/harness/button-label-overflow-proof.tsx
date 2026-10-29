import { Folder03Icon, WorkflowCircle06Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button, ButtonLabel } from "@ryu/ui/components/button.tsx";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select.tsx";
import { StaggerReveal } from "@ryu/ui/components/stagger-reveal.tsx";
import { Toggle } from "@ryu/ui/components/toggle.tsx";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import "../../src/index.css";

const ACCOUNT_NAME = "Jiawei Zhang-Alexander Longname";
const FOLDER_NAME = "/Users/jiawei/Documents/Projects/very-long-project-folder";
const BRANCH_NAME = "feature/very-long-branch-name-for-overflow-proof";
const SELECT_ITEMS = [
	{ label: BRANCH_NAME, value: "branch" },
	{ label: "Project", value: "project" },
];

function TriggerCard({
	children,
	label,
	testId,
}: {
	children: ReactNode;
	label: string;
	testId: string;
}) {
	return (
		<section className="flex flex-col gap-2" data-testid={`${testId}-case`}>
			<div className="flex items-center justify-between gap-4">
				<h2 className="font-medium text-sm">{label}</h2>
				<code className="text-muted-foreground text-xs">packages/ui</code>
			</div>
			<div className="rounded-2xl border border-border/60 bg-muted/30 p-3">
				{children}
			</div>
		</section>
	);
}

function Story() {
	if (new URLSearchParams(location.search).has("many")) {
		const buttons = Array.from({ length: 200 }, (_, index) => (
			<Button key={index} variant="outline">{`Label ${index}`}</Button>
		));
		return (
			<main className="min-h-screen bg-background p-6 text-foreground">
				<h1 className="mb-4 text-xl">Shared button labels</h1>
				<div className="grid grid-cols-10 gap-2" data-testid="reveal-grid">
					{new URLSearchParams(location.search).has("reveal") ? (
						<StaggerReveal
							step={0}
							wrap={!new URLSearchParams(location.search).has("clone")}
						>
							{buttons}
						</StaggerReveal>
					) : (
						buttons
					)}
				</div>
			</main>
		);
	}
	return (
		<main className="min-h-screen bg-background p-6 text-foreground">
			<div className="mx-auto flex max-w-xl flex-col gap-6">
				<header className="flex flex-col gap-1">
					<p className="font-medium text-muted-foreground text-xs uppercase tracking-widest">
						Shared trigger proof
					</p>
					<h1 className="font-semibold text-xl">
						Overflow fade, scroll, and tooltip
					</h1>
					<p className="text-muted-foreground text-sm">
						Interactive controls fade only their clipped text. Hover a long
						label to auto-scroll it and see the full value in a tooltip.
					</p>
				</header>

				<TriggerCard label="Button with direct text" testId="button-auto">
					<Button
						className="w-40 justify-start"
						data-testid="button-auto-trigger"
						type="button"
						variant="outline"
					>
						{ACCOUNT_NAME}
					</Button>
				</TriggerCard>

				<TriggerCard label="Button with an icon" testId="button-icon">
					<Button
						className="w-52 justify-start"
						data-testid="button-icon-trigger"
						type="button"
						variant="ghost"
					>
						<HugeiconsIcon
							aria-hidden="true"
							className="size-3.5 shrink-0"
							icon={WorkflowCircle06Icon}
						/>
						{BRANCH_NAME}
					</Button>
				</TriggerCard>

				<TriggerCard label="Select value" testId="select">
					<Select defaultValue="branch" items={SELECT_ITEMS}>
						<SelectTrigger
							className="w-60"
							data-testid="select-trigger"
							size="sm"
						>
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="branch">{BRANCH_NAME}</SelectItem>
							<SelectItem value="project">Project</SelectItem>
						</SelectContent>
					</Select>
				</TriggerCard>

				<TriggerCard label="Toggle label" testId="toggle">
					<Toggle
						className="w-44 justify-start"
						data-testid="toggle-trigger"
						size="sm"
					>
						{FOLDER_NAME}
					</Toggle>
				</TriggerCard>

				<TriggerCard label="Explicit custom label" testId="custom">
					<Button
						className="w-52 justify-start"
						data-testid="custom-trigger"
						type="button"
						variant="ghost"
					>
						<ButtonLabel>{FOLDER_NAME}</ButtonLabel>
					</Button>
				</TriggerCard>

				<TriggerCard label="Short label stays crisp" testId="short">
					<Button
						className="w-52 justify-start"
						data-testid="short-trigger"
						type="button"
						variant="ghost"
					>
						<HugeiconsIcon
							aria-hidden="true"
							className="size-3.5 shrink-0"
							icon={Folder03Icon}
						/>
						Project
					</Button>
				</TriggerCard>
			</div>
		</main>
	);
}

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(<Story />);
}
