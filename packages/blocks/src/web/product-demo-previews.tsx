"use client";

import { useLiteralMessages } from "@ryu/i18n/react";
import { Switch } from "@ryu/ui/components/switch";
import { Tabs, TabsList, TabsTrigger } from "@ryu/ui/components/tabs";
import { cn } from "@ryu/ui/lib/utils";
import {
	ArrowRight,
	Github,
	Laptop,
	Mail,
	MessageSquare,
	NotebookPen,
	Server,
} from "lucide-react";
import { useState } from "react";

const TOOLS = [
	{ name: "Gmail", Icon: Mail },
	{ name: "Slack", Icon: MessageSquare },
	{ name: "Notion", Icon: NotebookPen },
	{ name: "GitHub", Icon: Github },
] as const;

interface PreviewProps {
	compact?: boolean;
}

export function ToolAccessPreview({ compact = false }: PreviewProps) {
	const [enabled, setEnabled] = useState<string[]>(["Gmail", "Notion"]);
	const [model, setModel] = useState("Claude");
	const tl = useLiteralMessages();

	return (
		<div
			className={cn(
				"relative overflow-hidden bg-card/75 text-foreground",
				compact
					? "h-full w-full bg-muted/65 p-5 pb-16"
					: "rounded-(--radius-os-window) p-6 ring-1 ring-border/45 md:p-8"
			)}
			data-testid="tool-access-preview"
		>
			<div className="flex items-center justify-between gap-4">
				<span className="font-medium text-sm">Tool access</span>
				{compact ? null : (
					<span className="text-muted-foreground text-xs">Example agent</span>
				)}
			</div>
			<Tabs
				className={compact ? "mt-3" : "mt-6"}
				onValueChange={setModel}
				value={model}
			>
				<TabsList manageLayout={!compact}>
					{["Claude", "ChatGPT", "Local"].map((name) => (
						<TabsTrigger key={name} value={name}>
							{name}
						</TabsTrigger>
					))}
				</TabsList>
			</Tabs>
			<div
				className={cn(
					compact ? "mt-3 grid grid-cols-2 gap-2" : "mt-8 space-y-3"
				)}
			>
				{TOOLS.map(({ name, Icon: ToolIcon }) => (
					<div
						className={cn(
							"flex min-w-0 items-center",
							compact
								? "gap-2 border-foreground/10 border-b px-0 py-3"
								: "gap-4 rounded-xl bg-muted/40 p-4"
						)}
						key={name}
					>
						<ToolIcon
							aria-hidden="true"
							className={cn(
								"shrink-0 text-muted-foreground",
								compact ? "size-4" : "size-5"
							)}
							strokeWidth={1.5}
						/>
						<label
							className="min-w-0 flex-1 truncate font-medium text-sm"
							htmlFor={`preview-tool-${name}`}
						>
							{name}
						</label>
						<Switch
							checked={enabled.includes(name)}
							id={`preview-tool-${name}`}
							onCheckedChange={(checked) =>
								setEnabled((current) =>
									checked
										? [...current, name]
										: current.filter((item) => item !== name)
								)
							}
						/>
					</div>
				))}
			</div>
			<p
				aria-live="polite"
				className={cn(
					"text-muted-foreground",
					compact ? "mt-3 text-xs" : "mt-6 text-sm"
				)}
			>
				{tl(
					"{toolCount, plural, one {# tool} other {# tools}} available to {model}",
					{ toolCount: enabled.length, model }
				)}
			</p>
		</div>
	);
}

export function DeploymentPreview({ compact = false }: PreviewProps) {
	const [mode, setMode] = useState("cloud");
	const hosted = mode === "cloud";
	if (compact) {
		return (
			<div
				className="relative h-full w-full overflow-hidden bg-muted/65 p-5 pb-16 text-foreground"
				data-testid="deployment-preview"
			>
				<Tabs onValueChange={setMode} value={mode}>
					<TabsList manageLayout={false}>
						<TabsTrigger value="cloud">Cloud</TabsTrigger>
						<TabsTrigger value="self-hosted">Self-hosted</TabsTrigger>
					</TabsList>
				</Tabs>
				<div className="mt-8 grid grid-cols-[1fr_auto_1fr] items-center gap-3 text-xs">
					<div className="flex min-w-0 items-center gap-2">
						<Laptop
							aria-hidden="true"
							className="size-5 shrink-0 text-muted-foreground"
						/>
						<span>Team</span>
					</div>
					<ArrowRight
						aria-hidden="true"
						className="size-4 text-muted-foreground"
					/>
					<div className="flex min-w-0 items-center gap-2">
						<Server
							aria-hidden="true"
							className="size-5 shrink-0 text-muted-foreground"
						/>
						<span className="truncate font-medium">
							{hosted ? "Ryu Cloud" : "Your server"}
						</span>
					</div>
				</div>
				<div className="mt-8 h-px bg-foreground/10" />
				<div className="type-compact mt-3 flex justify-between gap-3 text-muted-foreground">
					<span>Agents</span>
					<span>Tools</span>
					<span>Workflows</span>
				</div>
			</div>
		);
	}

	return (
		<div
			className={cn(
				"relative overflow-hidden rounded-(--radius-os-window) bg-card/75 p-6 text-foreground ring-1 ring-border/45 md:p-8"
			)}
			data-testid="deployment-preview"
		>
			<Tabs onValueChange={setMode} value={mode}>
				<TabsList manageLayout={!compact}>
					<TabsTrigger value="cloud">
						{compact ? "Cloud" : "Ryu Cloud"}
					</TabsTrigger>
					<TabsTrigger value="self-hosted">Self-hosted</TabsTrigger>
				</TabsList>
			</Tabs>
			<div
				className={cn(
					"flex items-center",
					compact ? "mt-4 gap-2" : "mt-8 flex-col gap-4"
				)}
			>
				<div
					className={cn(
						"flex min-w-0 items-center",
						compact
							? "flex-1 gap-2 rounded-xl bg-background/60 p-3"
							: "w-full gap-4 rounded-xl bg-muted/40 p-4"
					)}
				>
					<Laptop
						aria-hidden="true"
						className={cn(
							"shrink-0 text-muted-foreground",
							compact ? "size-4" : "size-6"
						)}
					/>
					<span className="truncate text-sm">
						{compact ? "Team" : "Your team"}
					</span>
				</div>
				<ArrowRight
					aria-hidden="true"
					className="size-4 shrink-0 text-muted-foreground"
				/>
				<div
					className={cn(
						"min-w-0 rounded-xl bg-background/60",
						compact ? "flex-1 p-3" : "w-full p-6"
					)}
				>
					<div className="flex items-center gap-2">
						<Server
							aria-hidden="true"
							className={cn(
								"shrink-0 text-primary",
								compact ? "size-4" : "size-6"
							)}
						/>
						<span className="truncate font-medium text-sm">
							{hosted ? "Ryu Cloud" : "Your server"}
						</span>
					</div>
					<div className="mt-3 grid grid-cols-3 gap-1.5">
						{["Agents", "Tools", "Workflows"].map((name) => (
							<span
								className="type-caption truncate rounded-lg bg-background px-1.5 py-2 text-center"
								key={name}
							>
								{name}
							</span>
						))}
					</div>
				</div>
			</div>
			{compact ? null : (
				<div aria-live="polite" className="mt-6 grid grid-cols-2 gap-4 text-sm">
					<div>
						<p className="text-muted-foreground text-xs">Infrastructure</p>
						<p className="mt-1">
							{hosted ? "Managed by Ryu" : "Managed by your team"}
						</p>
					</div>
					<div>
						<p className="text-muted-foreground text-xs">
							Access and approvals
						</p>
						<p className="mt-1">Set by your team</p>
					</div>
				</div>
			)}
		</div>
	);
}
