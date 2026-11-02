"use client";

import { useLiteralMessages } from "@ryu/i18n/react";
import { Tabs, TabsList, TabsTrigger } from "@ryu/ui/components/tabs";
import { cn } from "@ryu/ui/lib/utils";
import { ArrowRight, Check, LockKeyhole, UserRoundCheck } from "lucide-react";
import { useState } from "react";
import { copyMarker as t } from "./copy-marker.ts";
import styles from "./gateway-request-preview.module.css";

const EXAMPLES = {
	read: {
		label: t("Read"),
		request: t("Summarize the notes in the project folder."),
		tool: t("Read project files"),
		access: t("Project folder only"),
		review: t("Not required for reading"),
		decision: t("Allowed"),
		detail: t("The agent can read the approved folder and prepare a summary."),
		Icon: Check,
	},
	send: {
		label: t("Send"),
		request: t("Email the project update to the client."),
		tool: t("Send email"),
		access: t("Drafting is allowed"),
		review: t("Required before sending"),
		decision: t("Needs your approval"),
		detail: t(
			"The draft is ready. Sending waits for someone on your team to approve it."
		),
		Icon: UserRoundCheck,
	},
	delete: {
		label: t("Delete"),
		request: t("Delete the source files after writing the summary."),
		tool: t("Delete files"),
		access: t("Read-only project access"),
		review: t("Cannot override this access rule"),
		decision: t("Blocked"),
		detail: t("This agent has no permission to delete the source files."),
		Icon: LockKeyhole,
	},
} as const;

type ExampleKey = keyof typeof EXAMPLES;

export function GatewayRequestPreview({
	compact = false,
}: {
	compact?: boolean;
}) {
	const tl = useLiteralMessages();
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
								{tl(item.label)}
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
								{tl(example.decision)}
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
				<div className="type-compact absolute start-5 end-5 bottom-16 flex items-center gap-2 border-foreground/10 border-t pt-3 text-muted-foreground">
					<span>Agent</span>
					<ArrowRight aria-hidden="true" className="size-3 rtl:-scale-x-100" />
					<span>Gateway</span>
					<ArrowRight aria-hidden="true" className="size-3 rtl:-scale-x-100" />
					<span className="truncate">{tl(example.tool)}</span>
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
								{tl(item.label)}
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
							{tl(example.request)}
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
							<dd className="mt-1 break-words">{tl(example.tool)}</dd>
						</div>
						<div className="min-w-0">
							<dt className="text-muted-foreground">Access rule</dt>
							<dd className="mt-1 break-words">{tl(example.access)}</dd>
						</div>
						<div className={compact ? "col-span-2 min-w-0" : "min-w-0"}>
							<dt className="text-muted-foreground">Human review</dt>
							<dd className="mt-1 break-words">{tl(example.review)}</dd>
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
							{tl(example.decision)}
						</p>
						<p
							className={
								compact
									? "mt-1 text-muted-foreground text-xs leading-relaxed"
									: "mt-4 text-muted-foreground text-sm leading-relaxed"
							}
						>
							{tl(example.detail)}
						</p>
					</div>
				</div>
			</div>
		</div>
	);
}
