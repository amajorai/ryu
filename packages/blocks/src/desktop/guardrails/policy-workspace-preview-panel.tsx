"use client";

import { Button } from "@ryu/ui/components/button";
import { useState } from "react";
import type {
	PolicyLockableField,
	PolicyPreviewView,
	PolicyRules,
	PolicyScopeKind,
	PolicyScopeOptions,
	PolicyScopeRef,
} from "./policy-model.ts";
import { PolicyPreview } from "./policy-preview.tsx";
import { defaultScopeFor, PolicyScopePicker } from "./policy-scope-picker.tsx";
import { StatusLine } from "./policy-workspace-chrome.tsx";
import { policyErrorMessage } from "./policy-workspace-errors.ts";
import type { PolicyWorkspaceClient } from "./policy-workspace-types.ts";

export function PreviewPanel({
	candidate,
	client,
	idPrefix,
	kinds,
	scopeOptions,
}: {
	candidate?: {
		locked: PolicyLockableField[];
		policyId?: string;
		rules: PolicyRules;
	};
	client: PolicyWorkspaceClient;
	idPrefix: string;
	kinds?: readonly PolicyScopeKind[];
	scopeOptions: PolicyScopeOptions;
}) {
	const [scope, setScope] = useState<PolicyScopeRef>(() =>
		defaultScopeFor("org", scopeOptions)
	);
	const [preview, setPreview] = useState<PolicyPreviewView | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const scopeChosen = scope.kind === "org" || scope.id.length > 0;

	const run = async () => {
		setLoading(true);
		setError(null);
		try {
			setPreview(await client.preview({ candidate, scope }));
		} catch (previewError) {
			setPreview(null);
			setError(policyErrorMessage(previewError, "Could not load the preview."));
		} finally {
			setLoading(false);
		}
	};

	return (
		<div className="flex flex-col gap-4">
			<PolicyScopePicker
				disabled={loading}
				idPrefix={idPrefix}
				kinds={kinds}
				onChange={(next) => {
					setScope(next);
					setPreview(null);
				}}
				options={scopeOptions}
				value={scope}
			/>
			<div className="px-3.5">
				{/* Outline, not secondary: the secondary fill matches the settings
				    surface this sits on, so it would read as plain text. */}
				<Button
					disabled={!scopeChosen}
					loading={loading}
					onClick={() => {
						run().catch(() => undefined);
					}}
					size="sm"
					variant="outline"
				>
					Preview
				</Button>
			</div>
			<StatusLine error={error} success={null} />
			{preview ? <PolicyPreview preview={preview} /> : null}
		</div>
	);
}
