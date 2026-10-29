import { InputBar } from "@ryu/blocks/desktop/agent-elements/input-bar.tsx";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select.tsx";
import { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { z } from "zod";
import { ChatDisplayPrefs } from "@/src/components/chat/ChatDisplayPrefsProvider.tsx";
import {
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "@/src/components/settings/shared/settings-items.tsx";
import {
	COMPOSER_SEND_SHORTCUT_OPTIONS,
	type ComposerSendShortcut,
	readComposerSendShortcut,
	useComposerSendShortcut,
} from "@/src/hooks/useComposerSendShortcut.ts";
import "../../src/index.css";

interface SubmittedMessage {
	content: string;
	id: string;
}

type ProofStatus = "PENDING" | "VERIFIED";

interface ProofCompletionDetail {
	completedChecks: string[];
	expectedShortcut: ComposerSendShortcut;
}

const PROOF_COMPLETED_EVENT = "composer-send-shortcut-proof-complete";
const REQUIRED_COMPLETED_CHECKS = [
	"default-enter-send",
	"shift-enter-newline",
	"shift-enter-send",
	"command-enter-newline",
	"command-enter-send",
	"reload-persistence",
] as const;

function isProofCompletionDetail<RawInput>(
	value: RawInput
): value is RawInput & ProofCompletionDetail {
	return z
		.object({
			completedChecks: z.array(z.string()),
			expectedShortcut: z.enum(["enter", "shift-enter", "command-enter"]),
		})
		.safeParse(value).success;
}

function SendShortcutProof() {
	const [composerSendShortcut, setComposerSendShortcut] =
		useComposerSendShortcut();
	const [draft, setDraft] = useState("");
	const [messages, setMessages] = useState<SubmittedMessage[]>([]);
	const [status, setStatus] = useState<ProofStatus>("PENDING");
	const composerShellRef = useRef<HTMLDivElement>(null);
	const sendCountRef = useRef(0);

	useEffect(() => {
		const annotateTextarea = () => {
			const textarea = composerShellRef.current?.querySelector("textarea");
			if (textarea) {
				textarea.dataset.testid = "composer-proof-input";
			}
		};
		annotateTextarea();
		const observer = new MutationObserver(() => {
			annotateTextarea();
		});
		if (composerShellRef.current) {
			observer.observe(composerShellRef.current, {
				childList: true,
				subtree: true,
			});
		}
		return () => observer.disconnect();
	}, []);

	useEffect(() => {
		const handleProofCompleted = (event: Event) => {
			if (!(event instanceof CustomEvent)) {
				return;
			}
			if (!isProofCompletionDetail(event.detail)) {
				return;
			}
			const textarea = composerShellRef.current?.querySelector("textarea");
			if (textarea?.dataset.testid !== "composer-proof-input") {
				return;
			}
			if (draft.length > 0) {
				return;
			}
			if (readComposerSendShortcut() !== event.detail.expectedShortcut) {
				return;
			}
			if (composerSendShortcut !== event.detail.expectedShortcut) {
				return;
			}
			if (
				event.detail.completedChecks.length !==
					REQUIRED_COMPLETED_CHECKS.length ||
				REQUIRED_COMPLETED_CHECKS.some(
					(check, index) => check !== event.detail.completedChecks[index]
				)
			) {
				return;
			}
			setStatus("VERIFIED");
		};

		window.addEventListener(PROOF_COMPLETED_EVENT, handleProofCompleted);
		return () =>
			window.removeEventListener(PROOF_COMPLETED_EVENT, handleProofCompleted);
	}, [composerSendShortcut, draft]);

	const messagesLabel = useMemo(
		() => (messages.length === 0 ? "No sends yet" : `${messages.length} sends`),
		[messages.length]
	);

	return (
		<main className="min-h-screen bg-background px-6 py-8 text-foreground">
			<div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
				<header className="space-y-2">
					<p className="font-medium text-muted-foreground text-xs uppercase tracking-(--tracking-section)">
						Desktop proof
					</p>
					<h1 className="font-semibold text-3xl tracking-tight">
						Composer send shortcut
					</h1>
					<p className="max-w-3xl text-muted-foreground text-sm">
						This page mounts the production desktop composer, the General →
						Chats setting row, and the shared send-shortcut preference so both
						surfaces stay in sync.
					</p>
				</header>

				<SettingsSection caption="Settings → General → Chats" title="General">
					<SettingsGroup>
						<div data-testid="composer-send-shortcut-setting">
							<SettingsItem
								actions={
									<Select
										items={COMPOSER_SEND_SHORTCUT_OPTIONS}
										onValueChange={(value) => {
											if (
												value === "enter" ||
												value === "shift-enter" ||
												value === "command-enter"
											) {
												setComposerSendShortcut(
													value satisfies ComposerSendShortcut
												);
											}
										}}
										value={composerSendShortcut}
									>
										<SelectTrigger
											appearance="editor-row"
											aria-label="Send shortcut"
											className="w-56 shrink-0"
											id="composer-send-shortcut-select"
										>
											<SelectValue />
										</SelectTrigger>
										<SelectContent>
											{COMPOSER_SEND_SHORTCUT_OPTIONS.map((option) => (
												<SelectItem key={option.value} value={option.value}>
													{option.label}
												</SelectItem>
											))}
										</SelectContent>
									</Select>
								}
								description="Choose which key sends a prompt from the chat composer."
								title="Send shortcut"
							/>
						</div>
					</SettingsGroup>
				</SettingsSection>

				<section className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
					<div className="rounded-3xl border border-border/70 bg-card/40 p-4 shadow-sm">
						<div className="mb-3 space-y-1">
							<h2 className="font-semibold text-lg">Composer</h2>
							<p className="text-muted-foreground text-sm">
								Enter is the default. Switch to the other modes above and try
								plain Enter, Shift + Enter, and Command/Ctrl + Enter.
							</p>
						</div>
						<div data-testid="composer-proof-shell" ref={composerShellRef}>
							<InputBar
								compact
								onChange={setDraft}
								onSend={(message) => {
									sendCountRef.current += 1;
									setMessages((current) => [
										...current,
										{
											content: message.content,
											id: `send-${sendCountRef.current}`,
										},
									]);
									setDraft("");
								}}
								onStop={() => undefined}
								placeholder="Type a message to verify the send shortcut"
								status="ready"
								value={draft}
							/>
						</div>
					</div>

					<aside className="flex flex-col gap-4">
						<section className="rounded-3xl border border-border/70 bg-card/60 p-4">
							<div className="flex items-center justify-between gap-3">
								<h2 className="font-semibold text-sm">Submitted messages</h2>
								<p
									className="text-muted-foreground text-xs"
									data-testid="composer-proof-send-count"
								>
									{messagesLabel}
								</p>
							</div>
							<ol
								className="mt-3 flex min-h-48 flex-col gap-2"
								data-testid="composer-proof-sends"
							>
								{messages.length === 0 ? (
									<li className="rounded-2xl border border-border/70 border-dashed px-3 py-2 text-muted-foreground text-sm">
										No sends yet
									</li>
								) : (
									messages.map((message, index) => (
										<li
											className="rounded-2xl border border-border/70 bg-background/80 px-3 py-2 text-sm"
											key={message.id}
										>
											<span className="mr-2 text-muted-foreground text-xs">
												{index + 1}.
											</span>
											<span className="whitespace-pre-wrap break-words">
												{message.content}
											</span>
										</li>
									))
								)}
							</ol>
						</section>

						<section className="rounded-3xl border border-border/70 bg-card/60 p-4">
							<h2 className="font-semibold text-sm">Harness status</h2>
							<p className="mt-1 text-muted-foreground text-sm">
								The badge stays pending until the focused browser proof
								completes the Enter, Shift + Enter, Command/Ctrl + Enter, send,
								newline, and reload checks.
							</p>
							<output
								className={`mt-4 inline-flex rounded-full px-3 py-1 font-semibold text-sm ${
									status === "VERIFIED"
										? "bg-success/15 text-success"
										: "bg-warning/15 text-warning"
								}`}
								data-testid="composer-proof-status"
							>
								{status}
							</output>
						</section>
					</aside>
				</section>
			</div>
		</main>
	);
}

function App() {
	return (
		<ChatDisplayPrefs>
			<SendShortcutProof />
		</ChatDisplayPrefs>
	);
}

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(<App />);
}

document.body.setAttribute("data-harness-ready", "1");
