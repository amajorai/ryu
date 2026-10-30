import { Input } from "@ryu/ui/components/input.tsx";
import { Label } from "@ryu/ui/components/label.tsx";
import { Switch } from "@ryu/ui/components/switch.tsx";
import type { FormState, SetFormState } from "./AddChannelDialog-form.ts";

/** Telegram-only reaction-learning settings of the new-channel form. */
export function AddChannelReactionLearningSection({
	form,
	setForm,
}: {
	form: FormState;
	setForm: SetFormState;
}) {
	return (
		<div className="flex flex-col gap-3 border-border border-t pt-4">
			<div className="flex items-center justify-between gap-4">
				<div>
					<p className="font-semibold text-sm">Reaction learning</p>
					<p className="text-detail text-muted-foreground">
						Use reactions on this bot's replies as Good response / Bad response
						feedback. Off by default.
					</p>
				</div>
				<Switch
					aria-label="Enable reaction learning"
					checked={form.reactionLearning.enabled}
					onCheckedChange={(v) =>
						setForm((f) => ({
							...f,
							reactionLearning: { ...f.reactionLearning, enabled: v },
						}))
					}
				/>
			</div>
			<div className="space-y-1.5">
				<Label htmlFor="channel-add-positive-emojis">
					Good response emojis
				</Label>
				<Input
					disabled={!form.reactionLearning.enabled}
					id="channel-add-positive-emojis"
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
				<Label htmlFor="channel-add-negative-emojis">Bad response emojis</Label>
				<Input
					disabled={!form.reactionLearning.enabled}
					id="channel-add-negative-emojis"
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
					<p className="text-detail text-muted-foreground">
						Off by default because group feedback can represent more than one
						person.
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
	);
}

/** "Say hello first" and enabled toggles of the new-channel form. */
export function AddChannelStartupSection({
	form,
	setForm,
}: {
	form: FormState;
	setForm: SetFormState;
}) {
	return (
		<>
			<div className="flex flex-col gap-3 border-border border-t pt-4">
				<div className="flex items-center justify-between gap-4">
					<div>
						<p className="font-semibold text-sm">Say hello first</p>
						<p className="text-detail text-muted-foreground">
							When this bot starts, Ryu sends one welcome message while it waits
							for you to write first.
						</p>
					</div>
					<Switch
						aria-label="Let Ryu say hello first"
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
							setForm((f) => ({ ...f, proactiveTarget: e.target.value }))
						}
						placeholder="The approved chat or phone number"
						value={form.proactiveTarget}
					/>
					<p className="text-detail text-muted-foreground">
						Enter one approved chat. Ryu never sends a welcome to everyone.
					</p>
				</div>
			</div>

			<div className="flex items-center justify-between gap-4 border-border border-t pt-4">
				<div>
					<p className="font-semibold text-sm">Enabled</p>
					<p className="text-detail text-muted-foreground">
						The gateway registers enabled bots when it starts.
					</p>
				</div>
				<Switch
					aria-label="Enable channel"
					checked={form.enabled}
					onCheckedChange={(v) => setForm((f) => ({ ...f, enabled: v }))}
				/>
			</div>
		</>
	);
}
