// Prompt Studio: text / chat prompt variants editor.

import {
	Add01Icon,
	ArrowDown01Icon,
	ArrowUp01Icon,
	Copy01Icon,
	Delete02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import {
	NativeSelect,
	NativeSelectOption,
} from "@ryu/ui/components/native-select.tsx";
import { Textarea } from "@ryu/ui/components/textarea.tsx";
import { z } from "zod";
import { parseEvalMessages } from "@/src/lib/prompt-studio.ts";
import { parsePromptfooValue } from "@/src/lib/promptfoo.ts";
import type { PromptVariantRow } from "./PromptStudio-suite-config.ts";

export function PromptVariantsEditor({
	locked,
	onAdd,
	onDuplicate,
	onMove,
	onRemove,
	onUpdate,
	variants,
}: {
	locked: boolean;
	onAdd: () => void;
	onDuplicate: (id: string) => void;
	onMove: (id: string, direction: -1 | 1) => void;
	onRemove: (id: string) => void;
	onUpdate: (id: string, patch: Partial<PromptVariantRow>) => void;
	variants: PromptVariantRow[];
}) {
	const tl = useLiteralMessages();
	return (
		<div className="flex flex-col gap-2 rounded-lg bg-muted/20 p-3">
			<div className="flex items-center gap-2">
				<span className="font-medium text-xs">Prompt variants</span>
				<span className="type-caption text-muted-foreground">
					Run text or multi-turn prompt variants through the same test matrix.
				</span>
				<Button disabled={locked} onClick={onAdd} size="sm" variant="ghost">
					<HugeiconsIcon className="size-3" icon={Add01Icon} />
					Add variant
				</Button>
			</div>
			{variants.length === 0 ? (
				<p className="type-caption text-muted-foreground">
					The agent prompt above is the primary variant. Add another to compare
					prompt revisions side by side.
				</p>
			) : null}
			{variants.map((variant, index) => (
				<div
					className="flex flex-col gap-2 rounded-md border p-2"
					key={variant.id}
				>
					<div className="flex items-center gap-2">
						<Input
							aria-label={tl("Prompt variant {number} name", {
								number: String(index + 1),
							})}
							className="max-w-48"
							disabled={locked}
							onChange={(event) =>
								onUpdate(variant.id, { name: event.target.value })
							}
							size="dense"
							value={variant.name || `Variant ${index + 1}`}
						/>
						<Button
							aria-label={tl("Move {name} up", {
								name:
									variant.name ||
									tl("variant {number}", { number: String(index + 1) }),
							})}
							className="size-7"
							disabled={index === 0 || locked}
							onClick={() => onMove(variant.id, -1)}
							size="icon-sm"
							variant="ghost"
						>
							<HugeiconsIcon className="size-3" icon={ArrowUp01Icon} />
						</Button>
						<Button
							aria-label={tl("Move {name} down", {
								name:
									variant.name ||
									tl("variant {number}", { number: String(index + 1) }),
							})}
							className="size-7"
							disabled={index === variants.length - 1 || locked}
							onClick={() => onMove(variant.id, 1)}
							size="icon-sm"
							variant="ghost"
						>
							<HugeiconsIcon className="size-3" icon={ArrowDown01Icon} />
						</Button>
						<Button
							aria-label={tl("Duplicate {name}", {
								name:
									variant.name ||
									tl("variant {number}", { number: String(index + 1) }),
							})}
							className="size-7"
							disabled={locked}
							onClick={() => onDuplicate(variant.id)}
							size="icon-sm"
							variant="ghost"
						>
							<HugeiconsIcon className="size-3" icon={Copy01Icon} />
						</Button>
						<NativeSelect
							appearance="dense"
							aria-label={tl("Prompt variant {number} type", {
								number: String(index + 1),
							})}
							className="w-24"
							disabled={locked}
							onChange={(event) =>
								onUpdate(variant.id, {
									messages:
										event.target.value === "chat" ? variant.messages : [],
									type: z.enum(["text", "chat"]).parse(event.target.value),
								})
							}
							value={variant.type}
						>
							<NativeSelectOption value="text">Text</NativeSelectOption>
							<NativeSelectOption value="chat">Chat</NativeSelectOption>
						</NativeSelect>
						<Button
							aria-label={tl("Remove {name}", {
								name:
									variant.name ||
									tl("variant {number}", { number: String(index + 1) }),
							})}
							disabled={locked}
							onClick={() => onRemove(variant.id)}
							size="icon-sm"
							variant="ghost"
						>
							<HugeiconsIcon className="size-3" icon={Delete02Icon} />
						</Button>
					</div>
					{variant.type === "chat" ? (
						<Textarea
							aria-label="Variant chat messages (JSON)"
							disabled={locked}
							onChange={(event) => {
								try {
									const parsed = parsePromptfooValue(
										JSON.parse(event.target.value)
									);
									if (!Array.isArray(parsed)) {
										return;
									}
									onUpdate(variant.id, {
										messages: parseEvalMessages(parsed),
									});
								} catch {
									// Keep the last valid message list until the JSON is complete.
								}
							}}
							placeholder='[{"role":"user","content":"Hello {{name}}"}]'
							size="compact"
							value={JSON.stringify(variant.messages, null, 2)}
							variant="code"
						/>
					) : (
						<Textarea
							aria-label="Variant system prompt"
							disabled={locked}
							onChange={(event) =>
								onUpdate(variant.id, { content: event.target.value })
							}
							placeholder="A second system prompt variant. {{vars}} are rendered per case."
							size="compact"
							value={variant.content}
							variant="code"
						/>
					)}
				</div>
			))}
		</div>
	);
}
