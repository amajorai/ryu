import {
	AgentAvailabilityDot,
	AgentAvailabilityProvider,
} from "@ryu/blocks/desktop/agent-availability.tsx";
import { AgentChat } from "@ryu/blocks/desktop/agent-elements/agent-chat.tsx";
import { formatAsyncQuestionAnswer } from "@ryu/blocks/desktop/agent-elements/question/async-question.ts";
import { I18nProvider } from "@ryu/i18n/react";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuTrigger,
} from "@ryu/ui/components/dropdown-menu.tsx";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { UIMessage } from "ai";
import { ThemeProvider } from "next-themes";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { AvailabilitySubmenu } from "../../src/components/layout/AvailabilityMenu.tsx";
import { AvailabilitySettings } from "../../src/components/settings/AvailabilitySettings.tsx";
import { SettingsDialog } from "../../src/components/settings/SettingsDialog.tsx";
import { AppSurfaceProvider } from "../../src/contexts/app-surface-context.tsx";
import { EntitlementProvider } from "../../src/contexts/entitlement-context.tsx";
import { usePresenceSync } from "../../src/hooks/usePresenceSync.ts";
import { useUserAvailability } from "../../src/hooks/useUserAvailability.ts";
import { useSettingsDialog } from "../../src/store/useSettingsDialog.ts";
import "../../src/index.css";

const queryClient = new QueryClient({
	defaultOptions: { queries: { retry: false } },
});

const nativeFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
	const requestUrl =
		input instanceof Request
			? new URL(input.url)
			: new URL(String(input), window.location.origin);
	const headers = { "content-type": "application/json" };

	if (requestUrl.pathname === "/api/auth/get-session") {
		return new Response(JSON.stringify({ session: null, user: null }), {
			headers,
			status: 200,
		});
	}
	if (requestUrl.pathname === "/api/plugins") {
		return new Response(JSON.stringify({ apps: [] }), { headers, status: 200 });
	}
	if (requestUrl.pathname === "/api/plugins/contributions") {
		return new Response(JSON.stringify({ settings_tabs: [] }), {
			headers,
			status: 200,
		});
	}
	if (requestUrl.pathname.startsWith("/api/")) {
		return new Response(JSON.stringify({}), { headers, status: 404 });
	}

	return nativeFetch(input, init);
};

const messages: UIMessage[] = [
	{
		id: "availability-user",
		role: "user",
		parts: [
			{
				text: "Review the migration and continue when it is safe.",
				type: "text",
			},
		],
	},
	{
		id: "availability-question",
		role: "assistant",
		parts: [
			{
				text: "I found two safe migration paths and need your preference before I continue.",
				type: "text",
			},
			{
				input: {
					questions: [
						{
							description:
								"The first option keeps the current schema and rolls out in one pass.",
							kind: "single",
							options: [
								{
									id: "safe-rollout",
									label: "Safe rollout",
								},
								{
									id: "fast-cutover",
									label: "Fast cutover",
								},
							],
							title: "Which path should I use?",
						},
					],
					totalQuestions: 1,
				},
				state: "input-available",
				toolCallId: "availability-question-call",
				type: "tool-Question",
			},
		],
	},
];

// `?scenario=async`: the agent asked a non-urgent question, did not wait, and
// finished the rest of the task. The card must still be answerable afterwards.
const asyncMessages: UIMessage[] = [
	{
		id: "async-user",
		role: "user",
		parts: [{ text: "Set up the dashboard for me.", type: "text" }],
	},
	{
		id: "async-question",
		role: "assistant",
		parts: [
			{
				input: {
					async: true,
					questions: [
						{
							kind: "single",
							options: [
								{ id: "dark", label: "Dark theme" },
								{ id: "light", label: "Light theme" },
							],
							title: "Which theme should the dashboard default to?",
						},
					],
				},
				output: {
					output: { deferred: true },
					status: "completed",
				},
				state: "output-available",
				toolCallId: "ask-async-1",
				type: "tool-Question",
			},
			{
				text: "I asked about the theme without waiting and used the dark theme for now. The dashboard is ready.",
				type: "text",
			},
		],
	},
];

const scenario = new URLSearchParams(window.location.search).get("scenario");

function AvailabilityStatusControl() {
	const availability = useUserAvailability();

	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				render={
					<button
						aria-label="Desktop user nav"
						className="flex items-center gap-2 rounded-xl px-2 py-1.5 text-left transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
						type="button"
					/>
				}
			>
				<span className="relative flex size-7 shrink-0 items-center justify-center rounded-full bg-primary font-medium text-primary-foreground text-xs">
					J
					<AgentAvailabilityDot
						className="absolute right-0 bottom-0 size-2.5 ring-2 ring-sidebar"
						status={availability.status}
					/>
				</span>
				<span className="font-medium text-sm">Jiawei</span>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" className="min-w-64" side="top">
				<AvailabilitySubmenu />
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

function PromptPreview() {
	const availability = useUserAvailability();
	const [asyncAnswer, setAsyncAnswer] = useState<string | null>(null);

	return (
		<section
			className="flex min-h-0 flex-col overflow-hidden rounded-3xl border border-border/70 bg-card shadow-sm"
			data-testid="prompt-preview"
		>
			<div className="flex items-start justify-between gap-4 border-border/70 border-b px-5 py-4">
				<div className="min-w-0">
					<p className="font-medium text-sm">Live prompt behavior</p>
					<p className="mt-1 text-muted-foreground text-xs">
						The pending question stays available while your interruption policy
						changes.
					</p>
				</div>
				<output
					className="shrink-0 rounded-full bg-muted px-2 py-1 font-medium text-muted-foreground text-xs"
					data-testid="prompt-location"
				>
					{availability.status === "online" ? "Composer" : "Transcript"}
				</output>
			</div>
			<div className="min-h-0 flex-1 p-2">
				<AgentChat
					messages={scenario === "async" ? asyncMessages : messages}
					onSend={() => undefined}
					onStop={() => undefined}
					questionTool={{
						onAnswers: ({ answers, async, questions, toolCallId }) => {
							if (async) {
								setAsyncAnswer(
									formatAsyncQuestionAnswer(
										toolCallId ?? "question",
										questions,
										answers
									)
								);
							}
						},
					}}
					status="ready"
				/>
			</div>
			<output className="sr-only" data-testid="async-answer">
				{asyncAnswer ?? ""}
			</output>
		</section>
	);
}

function Story() {
	const availability = useUserAvailability();
	const settingsOpen = useSettingsDialog((state) => state.open);
	const settingsSection = useSettingsDialog((state) => state.section);
	const setSettingsOpen = useSettingsDialog((state) => state.setOpen);
	usePresenceSync();

	return (
		<AgentAvailabilityProvider status={availability.status}>
			<main className="min-h-screen bg-background p-6 text-foreground">
				<div className="mx-auto flex max-w-6xl flex-col gap-6">
					<header className="flex items-end justify-between gap-6">
						<div className="min-w-0">
							<p className="font-medium text-primary text-xs uppercase tracking-(--tracking-section)">
								Ryu Desktop
							</p>
							<h1 className="mt-1 font-heading font-semibold text-3xl tracking-tight">
								Availability & prompt policy
							</h1>
							<p className="mt-2 max-w-2xl text-muted-foreground text-sm">
								Choose when Ryu may ask for a decision. Away and Do not disturb
								keep human-input prompts available without taking over your
								composer.
							</p>
						</div>
					</header>
					<div className="grid min-h-[650px] gap-6 lg:grid-cols-[minmax(20rem,0.8fr)_minmax(0,1.35fr)]">
						<section className="rounded-3xl border border-border/70 bg-sidebar p-5 shadow-sm">
							<AvailabilitySettings />
						</section>
						<PromptPreview />
					</div>
					<footer
						className="flex items-center justify-start rounded-2xl border border-border/70 bg-sidebar px-3 py-2 shadow-sm"
						data-testid="user-nav-preview"
					>
						<AvailabilityStatusControl />
					</footer>
					<output className="sr-only" data-testid="availability-status">
						{availability.status}
					</output>
				</div>
				<SettingsDialog
					defaultSection={settingsSection}
					onOpenChange={setSettingsOpen}
					open={settingsOpen}
				/>
			</main>
		</AgentAvailabilityProvider>
	);
}

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(
		<QueryClientProvider client={queryClient}>
			<I18nProvider>
				<MemoryRouter>
					<AppSurfaceProvider surface="desktop">
						<EntitlementProvider>
							<ThemeProvider
								attribute="class"
								defaultTheme="light"
								enableSystem
							>
								<Story />
							</ThemeProvider>
						</EntitlementProvider>
					</AppSurfaceProvider>
				</MemoryRouter>
			</I18nProvider>
		</QueryClientProvider>
	);
}
