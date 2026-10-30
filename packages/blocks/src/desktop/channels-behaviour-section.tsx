"use client";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Input } from "@ryu/ui/components/input";
import { Label } from "@ryu/ui/components/label";
import {
	NativeSelect,
	NativeSelectOption,
} from "@ryu/ui/components/native-select";
import { Switch } from "@ryu/ui/components/switch";
import type { Dispatch, SetStateAction } from "react";
import {
	VOICE_REPLY_LABELS,
	VOICE_REPLY_MODES,
	voiceReplyModeInputSchema,
} from "./channels-constants.ts";
import type { FormState, supportedSettings } from "./channels-model.ts";

interface ChannelBehaviourSectionProps {
	form: FormState;
	setForm: Dispatch<SetStateAction<FormState>>;
	supported: ReturnType<typeof supportedSettings>;
}

export function ChannelBehaviourSection({
	form,
	setForm,
	supported,
}: ChannelBehaviourSectionProps) {
	const tl = useLiteralMessages();
	return (
		<div className="space-y-3 rounded-lg border bg-card p-4">
			<p className="font-medium text-sm">Behaviour</p>

			<div className="space-y-3 rounded-md border border-dashed p-3">
				<div className="flex items-center justify-between gap-4">
					<div>
						<p className="text-sm">Say hello first</p>
						<p className="text-muted-foreground text-xs">
							Let Ryu introduce itself and ask what to do next when this bot is
							ready. It waits for a local model to finish installing.
						</p>
					</div>
					<Switch
						aria-label="Send a welcome message first"
						checked={form.proactiveOpening}
						onCheckedChange={(v) =>
							setForm((f) => ({ ...f, proactiveOpening: v }))
						}
					/>
				</div>
				<div className="space-y-1.5">
					<Label htmlFor="channel-proactive-target">
						Where should Ryu say hello?
					</Label>
					<Input
						disabled={!form.proactiveOpening}
						id="channel-proactive-target"
						onChange={(e) =>
							setForm((f) => ({
								...f,
								proactiveTarget: e.target.value || null,
							}))
						}
						placeholder="The approved chat address or phone number"
						value={form.proactiveTarget ?? ""}
					/>
					<p className="text-muted-foreground text-xs">
						Use a chat that is already approved for this bot. Ryu never guesses
						a recipient or sends this to every chat.
					</p>
				</div>
			</div>

			{supported.typing ? (
				<div className="flex items-center justify-between gap-4">
					<div>
						<p className="text-sm">Typing indicator</p>
						<p className="text-muted-foreground text-xs">
							Show that the bot is working while the agent runs.
						</p>
					</div>
					<Switch
						aria-label="Typing indicator"
						checked={form.typingIndicator}
						onCheckedChange={(v) =>
							setForm((f) => ({ ...f, typingIndicator: v }))
						}
					/>
				</div>
			) : null}

			<div className="flex items-center justify-between gap-4">
				<div>
					<p className="text-sm">Lifecycle reactions</p>
					<p className="text-muted-foreground text-xs">
						Acknowledge received, completed, and failed turns with reactions
						where the platform supports them.
					</p>
				</div>
				<Switch
					aria-label="Lifecycle reactions"
					checked={form.lifecycleReactions}
					onCheckedChange={(v) =>
						setForm((f) => ({ ...f, lifecycleReactions: v }))
					}
				/>
			</div>

			{supported.reactionLearning ? (
				<div className="space-y-3 rounded-md border border-dashed p-3">
					<div className="flex items-center justify-between gap-4">
						<div>
							<p className="text-sm">Reaction learning</p>
							<p className="text-muted-foreground text-xs">
								Use reactions on Ryu's replies as Good response / Bad response
								feedback. It is off by default and only accepts exact replies.
							</p>
						</div>
						<Switch
							aria-label="Enable reaction learning"
							checked={form.reactionLearning.enabled}
							onCheckedChange={(v) =>
								setForm((f) => ({
									...f,
									reactionLearning: {
										...f.reactionLearning,
										enabled: v,
									},
								}))
							}
						/>
					</div>
					<div className="space-y-1.5">
						<Label htmlFor="channel-positive-emojis">
							Good response emojis
						</Label>
						<Input
							disabled={!form.reactionLearning.enabled}
							id="channel-positive-emojis"
							onChange={(e) =>
								setForm((f) => ({
									...f,
									reactionLearning: {
										...f.reactionLearning,
										positiveEmoji: e.target.value
											.split(",")
											.map((value) => value.trim())
											.filter(Boolean),
									},
								}))
							}
							placeholder="👍, ❤️, 🎉"
							value={form.reactionLearning.positiveEmoji.join(", ")}
						/>
					</div>
					<div className="space-y-1.5">
						<Label htmlFor="channel-negative-emojis">Bad response emojis</Label>
						<Input
							disabled={!form.reactionLearning.enabled}
							id="channel-negative-emojis"
							onChange={(e) =>
								setForm((f) => ({
									...f,
									reactionLearning: {
										...f.reactionLearning,
										negativeEmoji: e.target.value
											.split(",")
											.map((value) => value.trim())
											.filter(Boolean),
									},
								}))
							}
							placeholder="👎, 💀, 😴"
							value={form.reactionLearning.negativeEmoji.join(", ")}
						/>
					</div>
					<div className="flex items-center justify-between gap-4">
						<div>
							<p className="text-sm">Allow group reactions</p>
							<p className="text-muted-foreground text-xs">
								Off by default because group feedback can represent more than
								one person.
							</p>
						</div>
						<Switch
							aria-label="Allow group reaction learning"
							checked={form.reactionLearning.allowGroup}
							disabled={!form.reactionLearning.enabled}
							onCheckedChange={(v) =>
								setForm((f) => ({
									...f,
									reactionLearning: {
										...f.reactionLearning,
										allowGroup: v,
									},
								}))
							}
						/>
					</div>
				</div>
			) : null}

			{supported.commandMenu ? (
				<div className="flex items-center justify-between gap-4">
					<div>
						<p className="text-sm">Publish command menu</p>
						<p className="text-muted-foreground text-xs">
							Offer the same slash commands and skills the desktop chat does, in
							the platform's own command menu.
						</p>
					</div>
					<Switch
						aria-label="Publish command menu"
						checked={form.publishCommands}
						onCheckedChange={(v) =>
							setForm((f) => ({ ...f, publishCommands: v }))
						}
					/>
				</div>
			) : null}

			{supported.richText ? (
				<div className="flex items-center justify-between gap-4">
					<div>
						<p className="text-sm">Rich text replies</p>
						<p className="text-muted-foreground text-xs">
							Send headings, lists and tables natively instead of raw markdown.
						</p>
					</div>
					<Switch
						aria-label="Rich text replies"
						checked={form.richText}
						onCheckedChange={(v) => setForm((f) => ({ ...f, richText: v }))}
					/>
				</div>
			) : null}

			{supported.streaming ? (
				<div className="flex items-center justify-between gap-4">
					<div>
						<p className="text-sm">Streaming drafts</p>
						<p className="text-muted-foreground text-xs">
							Show a draft while the reply is generated. Direct messages only —
							the platform rejects drafts in groups.
						</p>
					</div>
					<Switch
						aria-label="Streaming drafts"
						checked={form.streaming}
						onCheckedChange={(v) => setForm((f) => ({ ...f, streaming: v }))}
					/>
				</div>
			) : null}

			{supported.threadReplies ? (
				<div className="flex items-center justify-between gap-4">
					<div>
						<p className="text-sm">Reply in a thread</p>
						<p className="text-muted-foreground text-xs">
							Open a thread on each message so a busy channel stays readable and
							each thread keeps its own history.
						</p>
					</div>
					<Switch
						aria-label="Reply in a thread"
						checked={form.threadReplies}
						onCheckedChange={(v) =>
							setForm((f) => ({ ...f, threadReplies: v }))
						}
					/>
				</div>
			) : null}

			{supported.readReceipts ? (
				<div className="flex items-center justify-between gap-4">
					<div>
						<p className="text-sm">Read receipts</p>
						<p className="text-muted-foreground text-xs">
							Mark messages read when the bot picks them up.
						</p>
					</div>
					<Switch
						aria-label="Read receipts"
						checked={form.sendReadReceipts}
						onCheckedChange={(v) =>
							setForm((f) => ({ ...f, sendReadReceipts: v }))
						}
					/>
				</div>
			) : null}

			<div className="space-y-1.5">
				<Label htmlFor="channel-voice-reply">Voice replies</Label>
				<NativeSelect
					id="channel-voice-reply"
					onChange={(e) =>
						setForm((f) => ({
							...f,
							voiceReply: voiceReplyModeInputSchema.parse(e.target.value),
						}))
					}
					value={form.voiceReply}
				>
					{VOICE_REPLY_MODES.map((mode) => (
						<NativeSelectOption key={mode} value={mode}>
							{VOICE_REPLY_LABELS[mode]}
						</NativeSelectOption>
					))}
				</NativeSelect>
				<p className="text-muted-foreground text-xs">
					{form.channelType === "whatsapp" && form.voiceReply !== "never"
						? tl(
								"Voice messages you send are transcribed either way. A spoken reply is sent alongside the text, never instead of it. WhatsApp cannot carry Ryu's generated audio, so replies there stay text-only."
							)
						: tl(
								"Voice messages you send are transcribed either way. A spoken reply is sent alongside the text, never instead of it."
							)}
				</p>
			</div>
		</div>
	);
}
