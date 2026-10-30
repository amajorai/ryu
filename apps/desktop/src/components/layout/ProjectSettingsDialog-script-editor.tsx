import { useLiteralMessages } from "@ryu/i18n/react";
import { Label } from "@ryu/ui/components/label.tsx";
import { Textarea } from "@ryu/ui/components/textarea.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import { useState } from "react";
import type { ProjectEnvironmentScripts } from "@/src/store/useWorkspaceStore.ts";

const SCRIPT_PLATFORMS = ["default", "macos", "linux", "windows"] as const;
type ScriptPlatform = (typeof SCRIPT_PLATFORMS)[number];

export function ScriptEditor({
	compact = false,
	description,
	label,
	onChange,
	placeholder,
	scripts,
}: {
	compact?: boolean;
	description?: string;
	label: string;
	onChange: (scripts: ProjectEnvironmentScripts) => void;
	placeholder: string;
	scripts: ProjectEnvironmentScripts;
}) {
	const tl = useLiteralMessages();
	const [platform, setPlatform] = useState<ScriptPlatform>("default");
	return (
		<div className="space-y-1.5">
			<div>
				<Label>{label}</Label>
				{description ? (
					<p className="text-muted-foreground text-xs">{description}</p>
				) : null}
			</div>
			<div className="flex gap-1">
				{SCRIPT_PLATFORMS.map((item) => (
					<button
						className={cn(
							"rounded-md px-2 py-1 text-xs capitalize",
							platform === item
								? "bg-muted font-medium text-foreground"
								: "text-muted-foreground hover:text-foreground"
						)}
						key={item}
						onClick={() => setPlatform(item)}
						type="button"
					>
						{item === "default" ? "Default" : item}
					</button>
				))}
			</div>
			<Textarea
				className={cn("resize-y", compact ? "min-h-20" : "min-h-28")}
				onChange={(event) =>
					onChange({ ...scripts, [platform]: event.target.value })
				}
				placeholder={
					platform === "default"
						? placeholder
						: tl("Overrides Default on {platform}", { platform })
				}
				spellCheck={false}
				value={scripts[platform]}
				variant="code-caption"
			/>
		</div>
	);
}
