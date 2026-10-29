import { AgentChat } from "@ryu/blocks/desktop/agent-elements/agent-chat.tsx";
import { useAvatarConversationState } from "@ryu/ui/components/avatar-conversation.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import { parseGhostAvatar } from "@ryu/ui/components/ghost-avatar.ts";
import type { GlyphValue } from "@ryu/ui/components/glyph.ts";
import type { ChatStatus, UIMessage } from "ai";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { z } from "zod";
import { AgentImageField } from "../../src/components/agents/AgentImageField.tsx";
import { ChatDisplayPrefs } from "../../src/components/chat/ChatDisplayPrefsProvider.tsx";
import { AgentAvatar } from "../../src/lib/agent-logos.tsx";
import {
	glyphToPersonaFields,
	personaToGlyphValue,
} from "../../src/lib/agent-persona.ts";
import "../../src/index.css";
const DEFAULT: GlyphValue = {
	kind: "expressive",
	variant: "3d",
	bodyStyle: "orb",
	behavior: "conversation",
	expression: "random",
	animation: "random",
};
const STAGES = [
	"idle",
	"thinking",
	"replying",
	"tool",
	"waiting",
	"error",
] as const;
type Stage = (typeof STAGES)[number];
const ROSTER = Array.from({ length: 20 }, (_, index) => `Agent ${index + 1}`);
function LiveAvatar({ value }: { value: GlyphValue }) {
	const state = useAvatarConversationState();
	return (
		<div className="flex items-center gap-4 rounded-xl border bg-card p-4">
			<AgentAvatar glyph={value} size="96px" />
			<div>
				<p className="font-medium">Ryu</p>
				<p
					className="text-muted-foreground text-sm"
					data-testid="live-avatar-state"
				>
					{state}
				</p>
			</div>
		</div>
	);
}
function loadValue(): GlyphValue {
	try {
		const raw: unknown = JSON.parse(
			localStorage.getItem("ryu-ghost-avatar-proof") ?? "null"
		);
		const stored = z.object({ expressive: z.json() }).safeParse(raw);
		if (stored.success) {
			const ghost = parseGhostAvatar(stored.data.expressive);
			if (ghost) {
				return { ...ghost, kind: "expressive" };
			}
		}
	} catch {
		/* Empty local preview settings. */
	}
	return DEFAULT;
}
function Story() {
	const [value, setValue] = useState<GlyphValue>(loadValue);
	const [stage, setStage] = useState<Stage>("idle");
	const [saved, setSaved] = useState(false);
	const status: ChatStatus =
		stage === "idle" || stage === "waiting"
			? "ready"
			: stage === "error"
				? "error"
				: stage === "thinking"
					? "submitted"
					: "streaming";
	const messages: UIMessage[] =
		stage === "idle"
			? []
			: [
					{
						id: "user",
						role: "user",
						parts: [
							{
								type: "text",
								text: "Review the project and explain what you find.",
							},
						],
					},
					{
						id: "assistant",
						role: "assistant",
						parts:
							stage === "replying"
								? [
										{
											type: "text",
											text: "I found the project files. Here is what I am checking…",
										},
									]
								: stage === "tool"
									? [
											{
												type: "dynamic-tool",
												toolName: "inspect_project",
												toolCallId: "inspect",
												state: "input-available",
												input: { path: "project" },
											},
										]
									: stage === "waiting"
										? [
												{
													type: "dynamic-tool",
													toolName: "inspect_project",
													toolCallId: "inspect",
													state: "approval-requested",
													input: { path: "project" },
													approval: { id: "approval" },
												},
											]
										: [
												{
													type: "reasoning",
													text: "Reviewing the request…",
													state: "streaming",
												},
											],
					},
				];
	return (
		<div className="min-h-screen bg-background text-foreground">
			<header className="border-b px-6 py-5">
				<p className="text-muted-foreground text-xs uppercase tracking-widest">
					Ryu · Agent avatars
				</p>
				<h1 className="mt-2 text-2xl">A face for your agent.</h1>
			</header>
			<main className="grid gap-6 p-6 lg:grid-cols-[340px_1fr]">
				<section className="space-y-5">
					<div className="rounded-xl border bg-card p-5">
						<div className="flex items-center gap-4">
							<AgentImageField
								fallback={<span>R</span>}
								onChange={(next) => {
									const fields = glyphToPersonaFields(next);
									localStorage.setItem(
										"ryu-ghost-avatar-proof",
										JSON.stringify(fields)
									);
									setValue(
										personaToGlyphValue({
											...fields,
											display_name: null,
											tone: null,
										})
									);
									setSaved(true);
								}}
								value={value}
							/>
							<div>
								<h2 className="font-medium">Ryu</h2>
								<p className="text-muted-foreground text-sm">
									Customize the agent avatar
								</p>
							</div>
						</div>
						{saved ? (
							<p className="mt-3 text-sm" role="status">
								Avatar saved
							</p>
						) : null}
					</div>
					<div className="rounded-xl border p-5">
						<h2 className="mb-3 font-medium">Agent roster</h2>
						<div className="grid grid-cols-5 gap-3">
							{ROSTER.map((name) => (
								<div key={name} title={name}>
									<AgentAvatar glyph={value} size="40px" />
								</div>
							))}
						</div>
					</div>
					<div className="rounded-xl border p-5">
						<h2 className="font-medium">Conversation replay</h2>
						<p className="mt-1 text-muted-foreground text-xs">
							Replay chat status and message parts through the real conversation
							component.
						</p>
						<div className="mt-3 flex flex-wrap gap-2">
							{STAGES.map((item) => (
								<Button
									key={item}
									onClick={() => setStage(item)}
									size="sm"
									variant={stage === item ? "default" : "outline"}
								>
									{item}
								</Button>
							))}
						</div>
					</div>
				</section>
				<section className="flex h-[700px] min-h-0 flex-col overflow-hidden rounded-xl border">
					<ChatDisplayPrefs>
						<AgentChat
							assistantAvatar={<AgentAvatar glyph={value} size="24px" />}
							assistantName="Ryu"
							composerFooter={<LiveAvatar value={value} />}
							emptyStateHeader={
								<div className="p-6 text-center">
									<h2 className="text-xl">What would you like to work on?</h2>
								</div>
							}
							error={
								stage === "error"
									? new Error("The local replay reported a failed request.")
									: undefined
							}
							messages={messages}
							onSend={() => setStage("thinking")}
							onStop={() => setStage("idle")}
							status={status}
						/>
					</ChatDisplayPrefs>
				</section>
			</main>
		</div>
	);
}
const root = document.getElementById("root");
if (root) {
	createRoot(root).render(<Story />);
}
