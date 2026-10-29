"use client";

import { Button } from "@ryu/ui/components/button";
import { WORKSPACE_PREVIEWS } from "@ryuhq/protocol/workspace-preview";
import { useState } from "react";

/** An offline illustration, separate from the real app and its execution gates. */
export function WorkspacePreview({ onContinue }: { onContinue?: () => void }) {
	const [selectedId, setSelectedId] = useState<string>(
		WORKSPACE_PREVIEWS[0].id
	);
	const selected =
		WORKSPACE_PREVIEWS.find((item) => item.id === selectedId) ??
		WORKSPACE_PREVIEWS[0];
	return (
		<section
			aria-label="Sample workspace"
			className="mx-auto w-full max-w-2xl rounded-2xl border border-border/60 bg-background/90 p-5 text-left"
			data-testid="workspace-preview"
		>
			<p className="text-muted-foreground text-xs">
				Sample workspace · illustrative content
			</p>
			<div className="my-4 flex flex-wrap gap-2">
				{WORKSPACE_PREVIEWS.map((item) => (
					<Button
						aria-pressed={selectedId === item.id}
						key={item.id}
						onClick={() => setSelectedId(item.id)}
						size="sm"
						variant={selectedId === item.id ? "secondary" : "ghost"}
					>
						{item.title}
					</Button>
				))}
			</div>
			<p className="font-medium text-sm">{selected.prompt}</p>
			<p className="mt-3 whitespace-pre-line rounded-xl bg-muted/60 p-4 text-muted-foreground text-sm">
				{selected.output}
			</p>
			{onContinue ? (
				<Button className="mt-4" onClick={onContinue}>
					Continue to my workspace
				</Button>
			) : null}
		</section>
	);
}
