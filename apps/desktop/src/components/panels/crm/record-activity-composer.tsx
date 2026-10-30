import {
	Calendar01Icon,
	CheckmarkCircle01Icon,
	Note01Icon,
	TelephoneIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { Label } from "@ryu/ui/components/label.tsx";
import { Textarea } from "@ryu/ui/components/textarea.tsx";
import type { Dispatch, SetStateAction } from "react";
import type { ActivityKind } from "@/src/lib/api/crm.ts";

/** Which kinds a person can author. `field_change` / `stage_change` are absent on
 *  purpose — they are the store's audit trail, not something anyone writes. */
const AUTHORABLE: {
	icon: typeof Note01Icon;
	kind: ActivityKind;
	label: string;
}[] = [
	{ icon: Note01Icon, kind: "note", label: "Note" },
	{ icon: TelephoneIcon, kind: "call", label: "Call" },
	{ icon: Calendar01Icon, kind: "meeting", label: "Meeting" },
	{ icon: CheckmarkCircle01Icon, kind: "task", label: "Task" },
];

interface ActivityComposerInput {
	composerBody: string;
	composerDue: string;
	composerKind: ActivityKind;
	composerTitle: string;
	saving: boolean;
	setComposerBody: Dispatch<SetStateAction<string>>;
	setComposerDue: Dispatch<SetStateAction<string>>;
	setComposerKind: Dispatch<SetStateAction<ActivityKind>>;
	setComposerTitle: Dispatch<SetStateAction<string>>;
	submitActivity: () => Promise<void>;
}

/** The timeline's composer: pick a kind, then title, detail and (tasks) a due time. */
export function renderActivityComposer({
	composerBody,
	composerDue,
	composerKind,
	composerTitle,
	saving,
	setComposerBody,
	setComposerDue,
	setComposerKind,
	setComposerTitle,
	submitActivity,
}: ActivityComposerInput) {
	return (
		<div className="border-b p-3">
			<div className="mb-2 flex flex-wrap gap-1">
				{AUTHORABLE.map((option) => (
					<Button
						key={option.kind}
						onClick={() => setComposerKind(option.kind)}
						size="sm"
						variant={composerKind === option.kind ? "secondary" : "ghost"}
					>
						<HugeiconsIcon icon={option.icon} size={14} />
						{option.label}
					</Button>
				))}
			</div>
			<div className="space-y-2">
				<div>
					<Label className="sr-only" htmlFor="crm-activity-title">
						Title
					</Label>
					<Input
						id="crm-activity-title"
						onChange={(event) => setComposerTitle(event.target.value)}
						placeholder={
							composerKind === "task" ? "What needs doing?" : "What happened?"
						}
						value={composerTitle}
					/>
				</div>
				<div>
					<Label className="sr-only" htmlFor="crm-activity-body">
						Detail
					</Label>
					<Textarea
						id="crm-activity-body"
						onChange={(event) => setComposerBody(event.target.value)}
						placeholder="Detail (optional)"
						rows={2}
						value={composerBody}
					/>
				</div>
				{composerKind === "task" && (
					<div className="flex items-center gap-2">
						<Label htmlFor="crm-activity-due" size="compact">
							Due
						</Label>
						<Input
							className="w-56"
							id="crm-activity-due"
							onChange={(event) => setComposerDue(event.target.value)}
							type="datetime-local"
							value={composerDue}
						/>
						<span className="text-muted-foreground text-xs">
							A task with no due time never announces itself.
						</span>
					</div>
				)}
				<div className="flex justify-end">
					<Button
						disabled={saving || composerTitle.trim() === ""}
						onClick={() => void submitActivity()}
						size="sm"
					>
						{saving ? "Saving…" : "Add"}
					</Button>
				</div>
			</div>
		</div>
	);
}
