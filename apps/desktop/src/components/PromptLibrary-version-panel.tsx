// apps/desktop/src/components/PromptLibrary-version-panel.tsx
//
// The selected-version panel of the prompt library: the version's metadata,
// its body or a diff against the compared version, and the actions to load it
// into the agent or point a label at it.

import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import type { PromptVersion } from "@/src/lib/api/prompts.ts";
import { versionBody, type versionDiffRows } from "@/src/lib/prompt-library.ts";

const DIFF_TONE = {
	add: "text-status-success",
	remove: "text-status-destructive",
	equal: "text-muted-foreground",
} as const;
const DIFF_MARK = { add: "+ ", remove: "- ", equal: "  " } as const;

export interface PromptLibraryVersionPanelProps {
	busy: boolean;
	current: PromptVersion;
	diff: ReturnType<typeof versionDiffRows> | null;
	editable: boolean;
	handleLabel: () => void;
	handleUse: () => void;
	labelDraft: string;
	locked: boolean;
	setLabelDraft: (label: string) => void;
}

export function PromptLibraryVersionPanel({
	busy,
	current,
	diff,
	editable,
	handleLabel,
	handleUse,
	labelDraft,
	locked,
	setLabelDraft,
}: PromptLibraryVersionPanelProps) {
	const tl = useLiteralMessages();
	return (
		<div className="flex flex-col gap-2">
			<p className="text-muted-foreground text-xs">
				{current.commitMessage ?? "No commit message"}
				{current.variables.length > 0
					? ` ${tl("· variables: {variables}", { variables: current.variables.join(", ") })}`
					: ""}
				{current.modelConfig.model
					? ` ${tl("· model: {model}", { model: current.modelConfig.model })}`
					: ""}
			</p>
			{diff ? (
				<div className="flex flex-col gap-1">
					<pre className="type-caption max-h-72 overflow-auto rounded bg-muted/40 p-2 font-mono leading-relaxed">
						{diff.rows.map((row) => (
							<div className={DIFF_TONE[row.op]} key={row.id}>
								{DIFF_MARK[row.op]}
								{row.text}
							</div>
						))}
					</pre>
					{diff.variables.added.length > 0 ||
					diff.variables.removed.length > 0 ||
					diff.modelConfig.length > 0 ? (
						<p className="text-muted-foreground text-xs">
							{[
								...diff.variables.added.map((name) => `+ variable ${name}`),
								...diff.variables.removed.map((name) => `- variable ${name}`),
								...diff.modelConfig,
							].join(" · ")}
						</p>
					) : null}
				</div>
			) : (
				<pre className="type-caption max-h-72 overflow-auto whitespace-pre-wrap rounded bg-muted/40 p-2 font-mono leading-relaxed">
					{versionBody(current)}
				</pre>
			)}
			<div className="flex flex-wrap items-center gap-2">
				<Button
					disabled={locked}
					onClick={handleUse}
					size="sm"
					typography="compact"
				>
					Use in this agent
				</Button>
				{editable ? (
					<>
						<Input
							aria-label="Label"
							className="w-36"
							onChange={(event) => setLabelDraft(event.target.value)}
							placeholder="production"
							size="compact"
							value={labelDraft}
						/>
						<Button
							loading={busy}
							onClick={handleLabel}
							size="sm"
							typography="compact"
							variant="secondary"
						>
							{tl("Point label at v{version}", {
								version: String(current.version),
							})}
						</Button>
					</>
				) : (
					<span className="text-muted-foreground text-xs">
						Organization prompts are edited in the organization registry.
					</span>
				)}
			</div>
		</div>
	);
}
