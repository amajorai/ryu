import type { CSSProperties } from "react";
import type { ProductRealmId } from "./data/product-realms.ts";
import styles from "./product-realm-scenes.module.css";
import { BotScene } from "./product-scenes/bot.tsx";
import { ConsoleScene } from "./product-scenes/console.tsx";
import { GatewayScene } from "./product-scenes/gateway.tsx";
import { Scene } from "./product-scenes/scene.tsx";

type SceneId = ProductRealmId | "apps";

interface WorkspaceArtworkStyle extends CSSProperties {
	"--realm-workspace-image": string;
}
const workspaceArtwork: WorkspaceArtworkStyle = {
	"--realm-workspace-image": "url('/homepage/ryu-os-workspace.png')",
};

export function ProductRealmScene({ id }: { id: SceneId }) {
	switch (id) {
		case "connect":
			return (
				<Scene id={id}>
					<div className="absolute inset-0 overflow-hidden bg-muted/65">
						<div className="divide-y divide-border/45 px-4 pt-3">
							{(
								[
									["MCP", "Hosted Skill resources", "/mcp"],
									["Skills", "Discoverable instructions", "SKILL.md"],
									["Tools", "Tenant-allowed calls", "/v1/exec/tool"],
									["Composio", "Connected actions", "account-bound"],
								] as const
							).map(([name, detail, scope]) => (
								<div className="flex items-center gap-3 py-2.5" key={name}>
									<span className="type-compact flex size-7 shrink-0 items-center justify-center rounded-lg bg-muted font-medium">
										{name[0]}
									</span>
									<div className="min-w-0 flex-1">
										<p className="type-caption font-medium">{name}</p>
										<p className="type-compact truncate text-muted-foreground">
											{detail}
										</p>
									</div>
									<span className="type-micro hidden font-mono text-muted-foreground sm:block">
										{scope}
									</span>
								</div>
							))}
						</div>
					</div>
				</Scene>
			);
		case "gateway":
			return <GatewayScene />;
		case "compute":
			return (
				<Scene id={id}>
					<div className="type-caption absolute inset-0 overflow-hidden bg-muted/65 px-5 pt-6 font-mono">
						<div className="grid grid-cols-[5rem_1fr] gap-x-3 gap-y-4">
							<span className="text-muted-foreground">workcell</span>
							<span>GPU lane</span>
							<span className="text-muted-foreground">duration</span>
							<span>1 hour maximum</span>
							<span className="text-muted-foreground">access</span>
							<span>Scoped run · no host login</span>
						</div>
						<div className="type-compact mt-6 border-realm-capacity-marker/45 border-l-2 bg-realm-capacity-marker/10 px-3 py-2">
							Provider network not connected
						</div>
					</div>
				</Scene>
			);
		case "os":
			return (
				<Scene id={id}>
					<div className="absolute inset-0 overflow-hidden bg-realm-workspace-background">
						<div
							className={`absolute inset-0 bg-center bg-no-repeat dark:brightness-90 ${styles.workspaceArtwork}`}
							data-testid="ryu-os-workspace-image"
							style={workspaceArtwork}
						/>
					</div>
				</Scene>
			);
		case "console":
			return <ConsoleScene />;
		case "bot":
			return <BotScene />;
		case "passport":
			return (
				<Scene id={id}>
					<div className="absolute inset-0 overflow-hidden bg-muted/65 px-4 pt-4">
						<div className="flex items-baseline justify-between gap-2">
							<p className="font-medium text-lg tracking-tight">
								research-agent
							</p>
							<span className="type-compact text-realm-complete dark:text-realm-complete-dark">
								Sealed profile
							</span>
						</div>
						<p className="type-compact mt-1 font-mono text-muted-foreground">
							profile / ops · 2 domains
						</p>
						<div className="type-compact mt-4 space-y-2 border-border/50 border-t pt-3">
							<div className="flex justify-between">
								<span>github.com</span>
								<span className="text-realm-complete dark:text-realm-complete-dark">
									Stored
								</span>
							</div>
							<div className="flex justify-between">
								<span>mail.google.com</span>
								<span className="text-realm-progress dark:text-realm-progress-dark">
									Needs auth
								</span>
							</div>
							<p className="pt-1 text-muted-foreground">
								Credentials stay out of model context.
							</p>
						</div>
					</div>
				</Scene>
			);
		case "box":
			return (
				<Scene id={id}>
					<div className="type-compact absolute inset-0 overflow-hidden bg-muted/65 px-3 pt-4 font-mono">
						<div className="flex items-center justify-between gap-2">
							<span>box_7f3a</span>
							<span className="text-realm-complete dark:text-realm-complete-dark">
								ready
							</span>
						</div>
						<div className="mt-4 bg-foreground/4 p-3 leading-5">
							<p className="text-muted-foreground">
								POST /v1/boxes/:id/commands
							</p>
							<p>→ preview server listening</p>
							<p>→ filesystem persisted</p>
						</div>
						<div className="mt-3 flex justify-between gap-2 text-muted-foreground">
							<span>Files</span>
							<span>Preview</span>
							<span>Events</span>
						</div>
					</div>
				</Scene>
			);
		case "mail":
			return (
				<Scene id={id}>
					<div className="absolute inset-0 overflow-hidden bg-muted/65">
						<div className="divide-y divide-border/45 pt-3">
							{[
								["A", "Ava · Acme", "Project update", "10:42"],
								["M", "Maya · Finance", "September report", "09:18"],
								["J", "Jules · Team", "Next steps", "Yesterday"],
							].map(([initial, sender, subject, time]) => (
								<div
									className="type-compact flex items-center gap-2.5 px-3 py-2.5"
									key={sender}
								>
									<span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted font-medium">
										{initial}
									</span>
									<div className="min-w-0 flex-1">
										<p className="truncate font-medium">{sender}</p>
										<p className="truncate text-muted-foreground">{subject}</p>
									</div>
									<span className="type-micro text-muted-foreground">
										{time}
									</span>
								</div>
							))}
						</div>
					</div>
				</Scene>
			);
		case "notify":
			return (
				<Scene id={id}>
					<div className="type-compact absolute inset-0 overflow-hidden bg-muted/65 font-mono">
						<div className="divide-y divide-border/45 px-4 pt-3">
							{[
								[
									"10:42:18",
									"deploy.completed",
									"delivered",
									"text-realm-complete dark:text-realm-complete-dark",
								],
								[
									"10:40:04",
									"payment.received",
									"delivered",
									"text-realm-complete dark:text-realm-complete-dark",
								],
								[
									"10:38:51",
									"backup.failed",
									"retrying",
									"text-realm-progress dark:text-realm-progress-dark",
								],
							].map(([time, event, status, tone]) => (
								<div className="flex items-center gap-2 py-3" key={event}>
									<span className="text-muted-foreground">{time}</span>
									<span className="min-w-0 flex-1 truncate">{event}</span>
									<span className={tone}>{status}</span>
								</div>
							))}
						</div>
					</div>
				</Scene>
			);
		case "sites":
			return (
				<Scene id={id}>
					<div className="type-caption absolute inset-0 overflow-hidden bg-muted/65 px-5 pt-6 font-mono">
						<div className="grid grid-cols-[5.5rem_1fr] gap-x-3 gap-y-4">
							<span className="text-muted-foreground">deployed</span>
							<span>version 3</span>
							<span className="text-muted-foreground">secret scan</span>
							<span>passed</span>
							<span className="text-muted-foreground">origin</span>
							<span className="truncate">launch-notes.example.com</span>
						</div>
					</div>
				</Scene>
			);
		case "hire":
			return (
				<Scene id={id}>
					<div className="absolute inset-0 overflow-hidden bg-muted/65">
						<div className="divide-y divide-border/45 px-3 pt-3">
							{[
								["PA", "Policy analyst", "Audits and reviews"],
								["RR", "Release reviewer", "Ship checks"],
								["IT", "Inbox triage", "Sorts and drafts replies"],
							].map(([initials, role, detail]) => (
								<div
									className="type-compact flex items-center gap-2 py-2.5"
									key={role}
								>
									<span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted font-medium">
										{initials}
									</span>
									<div className="min-w-0 flex-1">
										<p className="truncate font-medium">{role}</p>
										<p className="truncate text-muted-foreground">{detail}</p>
									</div>
								</div>
							))}
						</div>
						<div className="type-compact mx-3 mt-3 border-realm-capacity-marker/45 border-l-2 bg-realm-capacity-marker/10 px-3 py-2">
							Early access · runs not available yet
						</div>
					</div>
				</Scene>
			);
		case "share":
			return (
				<Scene id={id}>
					<div className="type-compact absolute inset-0 overflow-hidden bg-muted/65 px-4 pt-5">
						<div className="grid grid-cols-2 gap-3">
							<div>
								<p className="text-muted-foreground">Offer</p>
								<p className="mt-1 font-medium">Compute workcell</p>
							</div>
							<div>
								<p className="text-muted-foreground">Availability</p>
								<p className="mt-1 font-medium">Only when idle</p>
							</div>
						</div>
						<div className="mt-5 flex justify-between border-border/45 border-t pt-3">
							<span>Node access</span>
							<span className="text-muted-foreground">Private only</span>
						</div>
						<div className="mt-4 border-realm-capacity-marker/45 border-l-2 bg-realm-capacity-marker/10 px-3 py-2 text-realm-review-foreground dark:text-realm-review-foreground-dark">
							Provider enrollment not enabled
						</div>
					</div>
				</Scene>
			);
		case "apps":
			return (
				<Scene id={id}>
					<div className="absolute inset-0 grid grid-cols-2 gap-2 overflow-hidden p-3">
						<div className="rounded-lg bg-background/90 p-3">
							<p className="type-caption font-medium">Sites</p>
							<div className="mt-3 h-11 rounded-sm bg-realm-site-surface/70 dark:bg-realm-site-surface-dark/25" />
							<div className="mt-2 h-1 w-3/4 bg-foreground/25" />
							<div className="mt-1 h-1 w-1/2 bg-foreground/15" />
						</div>
						<div className="rounded-lg bg-background/90 p-3">
							<p className="type-caption font-medium">Dashboards</p>
							<div className="mt-3 h-1 w-3/4 bg-foreground/20" />
							<div className="mt-2 h-1 w-full bg-foreground/10" />
							<div className="mt-2 h-1 w-5/6 bg-foreground/10" />
						</div>
						<div className="rounded-lg bg-background/90 p-3">
							<p className="type-caption font-medium">Video Studio</p>
							<div className="mt-3 flex gap-1">
								<span className="h-8 w-1/3 bg-realm-video-primary/60 dark:bg-realm-video-primary-dark/30" />
								<span className="h-8 w-1/3 bg-muted" />
								<span className="h-8 w-1/3 bg-realm-video-secondary/60 dark:bg-realm-video-secondary-dark/30" />
							</div>
						</div>
						<div className="rounded-lg bg-background/90 p-3">
							<p className="type-caption font-medium">Slides</p>
							<div className="mt-3 h-1 w-full bg-foreground/20" />
							<div className="mt-2 h-1 w-4/5 bg-foreground/10" />
						</div>
					</div>
				</Scene>
			);
	}
}
