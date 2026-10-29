"use client";

import { Tabs, TabsList, TabsTrigger } from "@ryu/ui/components/tabs";
import { cn } from "@ryu/ui/lib/utils";
import { ArrowRight, Check, LockKeyhole, UserRoundCheck } from "lucide-react";
import { useState } from "react";
import styles from "./gateway-request-preview.module.css";

const EXAMPLES = {
	read: {
		label: "Read",
		request: "Summarize the notes in the project folder.",
		tool: "Read project files",
		access: "Project folder only",
		review: "Not required for reading",
		decision: "Allowed",
		detail: "The agent can read the approved folder and prepare a summary.",
		Icon: Check,
	},
	send: {
		label: "Send",
		request: "Email the project update to the client.",
		tool: "Send email",
		access: "Drafting is allowed",
		review: "Required before sending",
		decision: "Needs your approval",
		detail:
			"The draft is ready. Sending waits for someone on your team to approve it.",
		Icon: UserRoundCheck,
	},
	delete: {
		label: "Delete",
		request: "Delete the source files after writing the summary.",
		tool: "Delete files",
		access: "Read-only project access",
		review: "Cannot override this access rule",
		decision: "Blocked",
		detail: "This agent has no permission to delete the source files.",
		Icon: LockKeyhole,
	},
} as const;

type ExampleKey = keyof typeof EXAMPLES;

export function GatewayRequestPreview({
	compact = false,
}: {
	compact?: boolean;
}) {
	const [selected, setSelected] = useState<ExampleKey>("send");
	const example = EXAMPLES[selected];

	if (compact) {
		return (
			<div
				className="relative h-full w-full overflow-hidden bg-muted/65 p-5 pb-16 text-foreground"
				data-testid="gateway-request-preview"
			>
				<Tabs
					onValueChange={(value) => {
						if (value === "read" || value === "send" || value === "delete") {
							setSelected(value);
						}
					}}
					value={selected}
				>
					<TabsList manageLayout={false}>
						{Object.entries(EXAMPLES).map(([value, item]) => (
							<TabsTrigger key={value} value={value}>
								{item.label}
							</TabsTrigger>
						))}
					</TabsList>
				</Tabs>
				<div aria-live="polite" className="mt-8">
					<div className="flex items-start gap-4">
						<example.Icon
							aria-hidden="true"
							className={cn(
								styles.loop,
								"size-5 shrink-0 animate-pulse text-muted-foreground"
							)}
							strokeWidth={1.5}
						/>
						<div className="min-w-0">
							<p className="font-heading font-medium text-xl tracking-tight">
								{example.decision}
							</p>
							<p className="mt-1 text-muted-foreground text-xs">
								{selected === "read"
									? "Allowed by policy"
									: selected === "send"
										? "Approval required"
										: "Blocked by policy"}
							</p>
						</div>
					</div>
				</div>
				<div className="type-compact absolute right-5 bottom-16 left-5 flex items-center gap-2 border-foreground/10 border-t pt-3 text-muted-foreground">
					<span>Agent</span>
					<ArrowRight aria-hidden="true" className="size-3" />
					<span>Gateway</span>
					<ArrowRight aria-hidden="true" className="size-3" />
					<span className="truncate">{example.tool}</span>
				</div>
			</div>
		);
	}

	return (
		<div
			className="w-full overflow-hidden rounded-3xl bg-background"
			data-testid="gateway-request-preview"
		>
			<div
				className={
					compact
						? "flex flex-wrap items-center justify-between gap-3 bg-muted/50 px-4 py-3"
						: "flex flex-wrap items-center justify-between gap-4 bg-muted/50 px-6 py-4"
				}
			>
				<span className="font-medium text-sm">Policy example</span>
				<Tabs
					onValueChange={(value) => {
						if (value === "read" || value === "send" || value === "delete") {
							setSelected(value);
						}
					}}
					value={selected}
				>
					<TabsList manageLayout={!compact}>
						{Object.entries(EXAMPLES).map(([value, item]) => (
							<TabsTrigger key={value} value={value}>
								{item.label}
							</TabsTrigger>
						))}
					</TabsList>
				</Tabs>
			</div>
			<div className={compact ? "grid" : "grid md:grid-cols-2"}>
				<div className={compact ? "space-y-4 p-4" : "space-y-8 p-6 md:p-8"}>
					<div>
						<p className="text-muted-foreground text-xs">Task</p>
						<p
							className={
								compact
									? "mt-2 font-medium text-sm leading-relaxed"
									: "mt-3 font-medium text-lg leading-relaxed"
							}
						>
							{example.request}
						</p>
					</div>
					<dl
						className={
							compact
								? "grid grid-cols-2 gap-x-4 gap-y-3 text-xs"
								: "space-y-5 text-sm"
						}
					>
						<div className="min-w-0">
							<dt className="text-muted-foreground">Tool</dt>
							<dd className="mt-1 break-words">{example.tool}</dd>
						</div>
						<div className="min-w-0">
							<dt className="text-muted-foreground">Access rule</dt>
							<dd className="mt-1 break-words">{example.access}</dd>
						</div>
						<div className={compact ? "col-span-2 min-w-0" : "min-w-0"}>
							<dt className="text-muted-foreground">Human review</dt>
							<dd className="mt-1 break-words">{example.review}</dd>
						</div>
					</dl>
				</div>
				<div
					aria-live="polite"
					className={
						compact
							? "flex items-center gap-3 bg-background px-4 py-3"
							: "flex flex-col justify-center bg-muted/30 p-6 md:p-10"
					}
				>
					<example.Icon
						aria-hidden="true"
						className={
							compact
								? "size-5 shrink-0 text-primary"
								: "mb-6 size-8 text-primary"
						}
						strokeWidth={1.5}
					/>
					<div className="min-w-0">
						<p
							className={
								compact
									? "font-heading font-medium text-lg tracking-tight"
									: "font-heading font-medium text-2xl tracking-tight"
							}
						>
							{example.decision}
						</p>
						<p
							className={
								compact
									? "mt-1 text-muted-foreground text-xs leading-relaxed"
									: "mt-4 text-muted-foreground text-sm leading-relaxed"
							}
						>
							{example.detail}
						</p>
					</div>
				</div>
			</div>
		</div>
	);
}
