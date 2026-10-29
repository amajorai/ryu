import { ChatDisplayPrefsProvider } from "@ryu/blocks/desktop/agent-elements/chat-display-prefs.tsx";
import { Switch } from "@ryu/ui/components/switch.tsx";
import { IconCpu, IconLoader2 } from "@tabler/icons-react";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import {
	ComposerSettingsMenu,
	type ComposerSettingsSection,
} from "../../components/agent-elements/input/composer-settings-menu.tsx";
import { SidebarConversationPreview } from "../../src/components/layout/sidebar-conversation-preview.tsx";
import "../../src/index.css";

const pickerSections: ComposerSettingsSection[] = [
	{
		key: "agent",
		label: "Agent",
		ariaLabel: "Select agent",
		items: [{ id: "ryu", name: "Ryu" }],
		value: "ryu",
		onChange: () => undefined,
	},
	{
		key: "model",
		label: "Model",
		ariaLabel: "Select model",
		items: [{ id: "sonnet", name: "Claude Sonnet 4.5" }],
		value: "sonnet",
		onChange: () => undefined,
	},
];

function StatusChips() {
	return (
		<div
			className="inline-flex h-8 items-center rounded-full border border-border/30 bg-popover/80 px-1.5 text-muted-foreground shadow-sm backdrop-blur"
			data-testid="status-chips"
		>
			<span className="inline-flex h-7 items-center gap-1.5 rounded-full px-1.5">
				<IconLoader2 className="size-3.5 text-primary" />
				<span>Step 2 of 4</span>
			</span>
			<span aria-hidden className="px-0.5 text-border">
				·
			</span>
			<span className="inline-flex h-7 items-center gap-1.5 rounded-full px-1.5">
				<span>3 files changed</span>
				<span className="font-medium text-success">+42</span>
				<span className="font-medium text-destructive">-9</span>
			</span>
		</div>
	);
}

function ChatRow({
	active = false,
	botMode = false,
	title,
	states,
}: {
	active?: boolean;
	botMode?: boolean;
	title: string;
	states: string[];
}) {
	return (
		<div
			className={`flex min-h-14 items-center gap-2 rounded-xl px-3 py-2 ${active ? "bg-muted" : "hover:bg-muted/60"}`}
			data-testid={botMode ? "bot-mode-row" : "chat-row"}
		>
			<div className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-primary/12 font-medium text-primary text-xs">
				{botMode ? "R" : "C"}
			</div>
			<div className="min-w-0 flex-1">
				<div className="truncate font-medium text-sm">{title}</div>
				<SidebarConversationPreview
					className="mt-0.5"
					states={states}
					testId={botMode ? "bot-mode-preview" : "chat-preview"}
				/>
			</div>
			<span className="type-compact shrink-0 text-muted-foreground/60">
				{active ? "now" : "2m"}
			</span>
		</div>
	);
}

function Proof() {
	const [animationsEnabled, setAnimationsEnabled] = useState(true);
	const [showChatPreview, setShowChatPreview] = useState(true);
	const [placement, setPlacement] = useState<"composer" | "tab-bar">("tab-bar");

	const picker = (
		<div
			className="flex min-w-0 items-center gap-0.5"
			data-testid="proof-picker"
		>
			<ComposerSettingsMenu compact sections={pickerSections} />
			<button
				aria-label="Choose provider and model"
				className="flex max-w-36 items-center gap-1 truncate rounded-md px-2 py-1 text-muted-foreground text-xs hover:bg-muted/60"
				type="button"
			>
				<IconCpu className="size-3.5 shrink-0" />
				<span className="truncate">Claude Sonnet 4.5</span>
			</button>
		</div>
	);

	return (
		<ChatDisplayPrefsProvider value={{ animationsEnabled }}>
			<div className="min-h-screen bg-background p-6 text-foreground">
				<div className="mx-auto max-w-6xl space-y-5">
					<header className="flex items-end justify-between gap-6">
						<div>
							<p className="font-medium text-primary text-xs uppercase tracking-(--tracking-section)">
								Appearance
							</p>
							<h1 className="mt-1 font-heading font-semibold text-2xl tracking-tight">
								Chat activity & picker placement
							</h1>
							<p className="mt-1 max-w-2xl text-muted-foreground text-sm">
								A live product preview of the two-line sidebar states, shared
								text loop, motion gate, translucent progress chips, and the chat
								tab-bar picker.
							</p>
						</div>
						<div className="flex items-center gap-3 rounded-2xl border border-border/70 bg-card px-3 py-2 text-sm shadow-sm">
							<span>Enable animations</span>
							<Switch
								aria-label="Enable animations"
								checked={animationsEnabled}
								id="proof-animations"
								onCheckedChange={setAnimationsEnabled}
							/>
						</div>
					</header>

					<div className="grid gap-5 lg:grid-cols-[18rem_minmax(0,1fr)]">
						<aside className="rounded-3xl border border-border/70 bg-sidebar p-3 shadow-sm">
							<div className="flex items-center justify-between px-2 pb-3">
								<span className="font-medium text-sm">Chats</span>
								<span className="text-muted-foreground text-xs">
									2 sessions
								</span>
							</div>
							<div className="space-y-1">
								{showChatPreview ? (
									<ChatRow
										active
										states={["You: Review the latest changes", "In progress"]}
										title="Sidebar preview setting"
									/>
								) : (
									<div
										className="flex h-10 items-center gap-2 rounded-xl px-3"
										data-testid="chat-row-single-line"
									>
										<div className="flex size-7 items-center justify-center rounded-lg bg-primary/12 font-medium text-primary text-xs">
											C
										</div>
										<span className="truncate font-medium text-sm">
											Sidebar preview setting
										</span>
									</div>
								)}
								<ChatRow
									botMode
									states={["The latest agent reply is ready", "In progress"]}
									title="Ryu · Agents view"
								/>
							</div>
							<div className="mt-4 border-border/60 border-t pt-3">
								<div className="flex items-center justify-between gap-3 px-2 text-xs">
									<span>Show latest message / tool state</span>
									<Switch
										aria-label="Show latest message / tool state"
										checked={showChatPreview}
										id="proof-sidebar-preview"
										onCheckedChange={setShowChatPreview}
									/>
								</div>
								<p className="type-caption mt-2 px-2 text-muted-foreground leading-4">
									The Agents view keeps its two-line rows even when this native
									chat setting is off.
								</p>
							</div>
						</aside>

						<section className="flex min-h-[30rem] flex-col overflow-hidden rounded-3xl border border-border/70 bg-card shadow-sm">
							<div className="flex items-center justify-between gap-4 border-border/70 border-b px-5 py-3">
								<div className="min-w-0">
									<div className="truncate font-medium text-sm">
										Sidebar preview setting
									</div>
									<div className="text-muted-foreground text-xs">
										Appearance proof · today
									</div>
								</div>
								<div className="flex items-center gap-2 rounded-2xl border border-border/60 bg-background/70 px-2 py-1">
									{placement === "tab-bar" ? (
										picker
									) : (
										<span className="text-muted-foreground text-xs">
											Picker in composer
										</span>
									)}
								</div>
							</div>
							<div className="flex flex-1 flex-col justify-end gap-4 p-5">
								<div className="max-w-xl rounded-2xl bg-muted/65 px-4 py-3 text-sm leading-6">
									The sidebar shows the latest message and current run state as
									one compact two-line session row.
								</div>
								<div className="flex justify-end">
									<div className="max-w-xl rounded-2xl bg-primary/10 px-4 py-3 text-sm leading-6">
										The Agents view uses the same text loop, while the native
										preview switch stays independent.
									</div>
								</div>
								<div className="flex flex-wrap items-center justify-between gap-3 border-border/60 border-t pt-4">
									<div className="flex items-center gap-2">
										<Switch
											aria-label="Model & agent picker in tab bar actions"
											checked={placement === "tab-bar"}
											id="proof-placement"
											onCheckedChange={(checked) =>
												setPlacement(checked ? "tab-bar" : "composer")
											}
										/>
										<span className="text-muted-foreground text-xs">
											Model & agent picker in tab bar actions
										</span>
									</div>
									{placement === "composer" ? (
										picker
									) : (
										<span className="text-muted-foreground text-xs">
											Composer stays focused on writing
										</span>
									)}
								</div>
								<div className="flex justify-center">
									<StatusChips />
								</div>
								<div className="rounded-2xl border border-border/60 bg-background/60 px-4 py-3 text-muted-foreground text-xs">
									Step progress and files changed use a transparent 80% surface
									with backdrop blur.
								</div>
							</div>
						</section>
					</div>
				</div>
			</div>
		</ChatDisplayPrefsProvider>
	);
}

document.documentElement.classList.add("dark");
const root = document.getElementById("root");
if (root) {
	createRoot(root).render(<Proof />);
}
