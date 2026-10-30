import { Button } from "@ryu/ui/components/button.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { Textarea } from "@ryu/ui/components/textarea.tsx";
import {
	type PromptCacheConfirmation,
	PromptCacheConfirmDialog,
} from "@/src/components/chat/PromptCacheConfirmDialog.tsx";
import type { UserPersonalization } from "@/src/lib/api/preferences.ts";
import { SettingsCard, SettingsSection } from "../shared/settings-items.tsx";

export interface AboutYouSectionProps {
	confirmation: PromptCacheConfirmation | null;
	loadFailed: boolean;
	loading: boolean;
	onChange: (next: UserPersonalization) => void;
	onConfirmApply: () => void;
	onConfirmCancel: () => void;
	onRetryLoad: () => void;
	onSave: () => void;
	personalization: UserPersonalization;
	saving: boolean;
}

/** The node-local "About you" personalization form. */
export function AboutYouSection({
	confirmation,
	loadFailed,
	loading,
	onChange,
	onConfirmApply,
	onConfirmCancel,
	onRetryLoad,
	onSave,
	personalization,
	saving,
}: AboutYouSectionProps) {
	return (
		<SettingsSection
			caption="Added to agent context on this node. Not shared with your organization."
			title="About you"
		>
			<SettingsCard className="flex flex-col gap-3 py-3">
				{loadFailed ? (
					<div className="flex items-center justify-between gap-6" role="alert">
						<p className="text-muted-foreground text-sm">
							Couldn’t load your saved profile details. Retry before editing so
							you don’t overwrite them.
						</p>
						<Button
							disabled={loading}
							onClick={onRetryLoad}
							size="sm"
							variant="outline"
						>
							{loading ? "Loading…" : "Retry"}
						</Button>
					</div>
				) : (
					<>
						<Input
							aria-label="Nickname"
							disabled={loading}
							onChange={(e) =>
								onChange({
									...personalization,
									nickname: e.target.value,
								})
							}
							placeholder="Nickname"
							value={personalization.nickname}
						/>
						<Input
							aria-label="Occupation"
							disabled={loading}
							onChange={(e) =>
								onChange({
									...personalization,
									occupation: e.target.value,
								})
							}
							placeholder="Occupation"
							value={personalization.occupation}
						/>
						<Textarea
							aria-label="More about you"
							disabled={loading}
							onChange={(e) =>
								onChange({
									...personalization,
									aboutYou: e.target.value,
								})
							}
							placeholder="More about you"
							value={personalization.aboutYou}
						/>
						<Textarea
							aria-label="About your organization"
							disabled={loading}
							onChange={(e) =>
								onChange({
									...personalization,
									aboutOrganization: e.target.value,
								})
							}
							placeholder="About your organization"
							value={personalization.aboutOrganization}
						/>
						<Button
							className="self-end"
							disabled={loading || saving}
							onClick={onSave}
							size="sm"
							variant="outline"
						>
							{saving ? "Saving…" : "Save personalization"}
						</Button>
					</>
				)}
			</SettingsCard>
			<PromptCacheConfirmDialog
				confirmation={confirmation}
				onApply={onConfirmApply}
				onCancel={onConfirmCancel}
			/>
		</SettingsSection>
	);
}
