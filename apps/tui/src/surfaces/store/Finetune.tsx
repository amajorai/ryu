/* @jsxImportSource @opentui/react */
// Fine-tune section - a light, fresh panel for the unified Store (the TUI analog of
// apps/desktop FinetuningPage). The full train-a-LoRA-and-merge-to-GGUF flow is a
// desktop/GPU workflow; here we surface a node-aware overview so the store's
// Fine-tune tab is present and coherent without duplicating that machinery. It owns
// no keyboard and no fetch logic.

import { Badge } from "@/components/ui/badge.tsx";
import { Card } from "@/components/ui/card.tsx";
import { useTheme } from "@/components/ui/theme-provider.tsx";
import { useCore } from "../../core/CoreContext.tsx";

interface FinetunePanelProps {
	/** True while Fine-tune is the visible store section. Unused (no keyboard). */
	active: boolean;
}

const STEPS: { key: string; label: string }[] = [
	{ key: "base", label: "Pick a base model from the Models section" },
	{ key: "data", label: "Provide a chat / alpaca / text dataset" },
	{ key: "train", label: "Train a LoRA adapter (Unsloth) on the node's GPU" },
	{ key: "merge", label: "Merge to a servable GGUF - it appears under Models" },
];

export function FinetunePanel(_props: FinetunePanelProps) {
	const theme = useTheme();
	const { url } = useCore();

	return (
		<box flexDirection="column" flexGrow={1} paddingLeft={1} paddingTop={1}>
			<box flexDirection="row" gap={1}>
				<text fg={theme.colors.foreground}>
					<b>Fine-tune</b>
				</text>
				<Badge bordered={false} variant="secondary">
					Unsloth
				</Badge>
			</box>
			<box paddingBottom={1} paddingTop={1}>
				<text fg={theme.colors.mutedForeground}>
					Train a LoRA on your own data, then merge to a GGUF you can serve.
				</text>
			</box>
			<Card
				subtitle="local training needs a GPU on the active node"
				title="How it works"
			>
				{STEPS.map((step, i) => (
					<box flexDirection="row" gap={1} key={step.key}>
						<text fg={theme.colors.accent}>{`${i + 1}.`}</text>
						<text fg={theme.colors.foreground}>{step.label}</text>
					</box>
				))}
			</Card>
			<box paddingTop={1}>
				<text fg={theme.colors.mutedForeground}>
					{`Runs against ${url} · start a job from the desktop app`}
				</text>
			</box>
		</box>
	);
}
