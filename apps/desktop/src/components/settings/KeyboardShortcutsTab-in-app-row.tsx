import type { Chord } from "@ryu/hotkeys/chord";
import type { HotkeyAction } from "@ryu/hotkeys/registry";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { ChordRecorder } from "./KeyboardShortcutsTab-chord-recorder.tsx";
import { SettingsItem } from "./shared/settings-items.tsx";

interface InAppRowProps {
	action: HotkeyAction;
	binding: Chord | null;
	conflictLabels: string[];
	hasOverride: boolean;
	onChange: (chord: Chord) => void;
	onClear: () => void;
	onReset: () => void;
}

/** One editable in-app shortcut row. */
export function InAppRow({
	action,
	binding,
	hasOverride,
	conflictLabels,
	onChange,
	onClear,
	onReset,
}: InAppRowProps) {
	const tl = useLiteralMessages();
	return (
		<SettingsItem
			actions={
				<div className="flex items-center gap-1.5">
					<ChordRecorder
						conflicting={conflictLabels.length > 0}
						onChange={onChange}
						testId={`shortcut-recorder-${action.id}`}
						value={binding}
					/>
					<Button
						data-testid={`shortcut-clear-${action.id}`}
						disabled={binding === null}
						onClick={onClear}
						size="sm"
						variant="ghost"
					>
						Clear
					</Button>
					<Button
						data-testid={`shortcut-reset-${action.id}`}
						disabled={!hasOverride}
						onClick={onReset}
						size="sm"
						variant="ghost"
					>
						Reset
					</Button>
				</div>
			}
			title={
				<span className="flex flex-col gap-0.5">
					<span>{action.label}</span>
					{conflictLabels.length > 0 ? (
						<span className="text-status-destructive text-xs">
							{tl("Also bound to {labels}", {
								labels: conflictLabels.join(", "),
							})}
						</span>
					) : null}
				</span>
			}
		/>
	);
}
