// apps/desktop/src/components/gateway/RoutePoolFields.tsx
//
// The two text fields that edit an auto-routing pool (Plane A): which models and
// which providers automatic model routing may pick. Shared by the gateway's
// global Smart routing card and the per-agent pool editor so both speak the same
// syntax: comma-separated, case-insensitive, `*` as a wildcard in model ids.

import { useRichLiteralMessages } from "@ryu/i18n/react";
import { Input } from "@ryu/ui/components/input.tsx";
import { Label } from "@ryu/ui/components/label.tsx";
import type { ReactNode } from "react";

export function RoutePoolFields({
	disabled,
	idPrefix,
	models,
	onModelsChange,
	onProvidersChange,
	providers,
}: {
	disabled?: boolean;
	/** Unique prefix for the input ids, so two editors can share a page. */
	idPrefix: string;
	/** Comma-separated model patterns, as typed. */
	models: string;
	onModelsChange: (next: string) => void;
	onProvidersChange: (next: string) => void;
	/** Comma-separated provider ids, as typed. */
	providers: string;
}) {
	const tlRich = useRichLiteralMessages();
	const codeTags = { code: (children: ReactNode) => <code>{children}</code> };
	const modelsId = `${idPrefix}-allowed-models`;
	const providersId = `${idPrefix}-allowed-providers`;
	return (
		<div className="flex flex-col gap-4">
			<div className="flex flex-col gap-1.5">
				<Label htmlFor={modelsId}>Allowed models</Label>
				<Input
					aria-describedby={`${modelsId}-hint`}
					disabled={disabled}
					id={modelsId}
					onChange={(e) => onModelsChange(e.target.value)}
					placeholder="Any model"
					value={models}
				/>
				<p className="text-muted-foreground text-xs" id={`${modelsId}-hint`}>
					{tlRich(
						"Comma-separated model ids; <code>{wildcard}</code> matches anything. For example <code>{example}</code> keeps routing on Claude and GPT models from any provider.",
						{ example: "*claude*, gpt-*", wildcard: "*" },
						codeTags
					)}
				</p>
			</div>
			<div className="flex flex-col gap-1.5">
				<Label htmlFor={providersId}>Allowed providers</Label>
				<Input
					aria-describedby={`${providersId}-hint`}
					disabled={disabled}
					id={providersId}
					onChange={(e) => onProvidersChange(e.target.value)}
					placeholder="Any provider"
					value={providers}
				/>
				<p className="text-muted-foreground text-xs" id={`${providersId}-hint`}>
					{tlRich(
						"Comma-separated provider ids, such as <code>{first}</code>, <code>{second}</code>, a custom endpoint's id, or <code>{core}</code> for agents served through this node. A routed model must match both lists.",
						{ core: "core", first: "anthropic", second: "openrouter" },
						codeTags
					)}
				</p>
			</div>
		</div>
	);
}
