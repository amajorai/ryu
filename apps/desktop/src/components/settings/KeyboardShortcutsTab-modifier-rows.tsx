import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select.tsx";
import {
	QUICK_PREVIEW_MODIFIER_OPTIONS,
	useQuickPreviewModifier,
} from "@/src/hooks/useQuickPreviewModifier.ts";
import {
	QUICK_REPLY_MODIFIER_OPTIONS,
	useQuickReplyModifier,
} from "@/src/hooks/useQuickReplyModifier.ts";
import { SettingsItem } from "./shared/settings-items.tsx";

export const QUICK_REPLY_MODIFIER_DESCRIPTION =
	"Hold this modifier while clicking a chat in the sidebar to open its floating quick-reply bar.";
export const QUICK_PREVIEW_MODIFIER_DESCRIPTION =
	"Hold this modifier while clicking and holding a chat in the sidebar to preview its messages without opening it.";

interface ModifierRowProps {
	/**
	 * Footer caption for the row's card. The enclosing SettingsGroup reads it
	 * off THIS element, because it cannot see the SettingsItem inside the
	 * wrapper, so every call site passes it (see settings-items).
	 */
	description: string;
}

export function QuickReplyModifierRow({ description }: ModifierRowProps) {
	const [modifier, setModifier] = useQuickReplyModifier();
	return (
		<SettingsItem
			actions={
				<Select
					onValueChange={(value) => {
						const option = QUICK_REPLY_MODIFIER_OPTIONS.find(
							(item) => item.value === value
						);
						if (option) {
							setModifier(option.value);
						}
					}}
					value={modifier}
				>
					<SelectTrigger
						aria-label="Quick reply click modifier"
						className="w-40"
						size="sm"
					>
						<SelectValue>
							{(value) =>
								QUICK_REPLY_MODIFIER_OPTIONS.find(
									(option) => option.value === value
								)?.label ?? value
							}
						</SelectValue>
					</SelectTrigger>
					<SelectContent>
						{QUICK_REPLY_MODIFIER_OPTIONS.map((option) => (
							<SelectItem key={option.value} value={option.value}>
								{option.label}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			}
			description={description}
			title="Quick reply click modifier"
		/>
	);
}

export function QuickPreviewModifierRow({ description }: ModifierRowProps) {
	const [modifier, setModifier] = useQuickPreviewModifier();
	return (
		<SettingsItem
			actions={
				<Select
					onValueChange={(value) => {
						const option = QUICK_PREVIEW_MODIFIER_OPTIONS.find(
							(item) => item.value === value
						);
						if (option) {
							setModifier(option.value);
						}
					}}
					value={modifier}
				>
					<SelectTrigger
						aria-label="Quick preview click modifier"
						className="w-40"
						size="sm"
					>
						<SelectValue>
							{(value) =>
								QUICK_PREVIEW_MODIFIER_OPTIONS.find(
									(option) => option.value === value
								)?.label ?? value
							}
						</SelectValue>
					</SelectTrigger>
					<SelectContent>
						{QUICK_PREVIEW_MODIFIER_OPTIONS.map((option) => (
							<SelectItem key={option.value} value={option.value}>
								{option.label}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			}
			description={description}
			title="Quick preview click modifier"
		/>
	);
}
