// The export half of the vault transfer dialog: format picker, an optional
// organization project whose values to include (P1-15), copy and download.
// Exported plaintext lives only in this component's state.

import { Copy01Icon, Download01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@ryu/ui/components/dialog.tsx";
import { Label } from "@ryu/ui/components/label.tsx";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select.tsx";
import { Textarea } from "@ryu/ui/components/textarea.tsx";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { sileo } from "sileo";
import { useStepUp } from "@/src/components/StepUpDialog.tsx";
import { sharedValuesMissingMessage } from "@/src/lib/access-refusal.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	exportVaultSecrets,
	type VaultExportFormat,
} from "@/src/lib/api/vault.ts";
import { readWithStepUp, vaultErrorMessage } from "./vault-errors.ts";
import { listMappedOrgProjects } from "./vault-org-projects.ts";
import { exportFileName } from "./vault-view.ts";

const EXPORT_FORMATS: { label: string; value: VaultExportFormat }[] = [
	{ value: "dotenv", label: ".env" },
	{ value: "json", label: "JSON" },
	{ value: "yaml", label: "YAML" },
	{ value: "shell", label: "Shell exports" },
	{ value: "k8s-secret", label: "Kubernetes Secret" },
];

/** The select value for "include no project". */
const NO_PROJECT = "__none__";

export function VaultExportBody({
	environment,
	folder,
	location,
	target,
}: {
	environment: string;
	folder: string;
	location: string;
	target: ApiTarget;
}) {
	const tl = useLiteralMessages();
	const stepUp = useStepUp();
	const [format, setFormat] = useState<VaultExportFormat>("dotenv");
	const [projectId, setProjectId] = useState(NO_PROJECT);
	const projectsQuery = useQuery({
		queryKey: ["vault", "org-project-mappings", target.url],
		queryFn: () => listMappedOrgProjects(target),
	});
	const projects = projectsQuery.data ?? [];
	const projectItems = [
		{ value: NO_PROJECT, label: tl("None") },
		...projects.map((id) => ({ value: id, label: id })),
	];
	const [content, setContent] = useState<string | null>(null);
	const [count, setCount] = useState(0);
	const [sharedError, setSharedError] = useState<string | null>(null);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);

	// Not a React Query mutation: its cache would keep the exported values.
	const run = async () => {
		setError(null);
		setPending(true);
		try {
			// Shared values ask for a confirmation when no organization or team
			// node vouches for the export. A dismissed prompt exports nothing.
			const result = await readWithStepUp(stepUp.guard, () =>
				exportVaultSecrets(target, {
					environment,
					path: folder,
					format,
					...(projectId === NO_PROJECT ? {} : { projectId }),
				})
			);
			if (result !== null) {
				setContent(result.content);
				setCount(result.count);
				setSharedError(result.sharedError || null);
			}
		} catch (caught) {
			setError(vaultErrorMessage(caught, "Could not export.", tl));
		} finally {
			setPending(false);
		}
	};

	const copy = async () => {
		if (content === null) {
			return;
		}
		try {
			await navigator.clipboard.writeText(content);
			sileo.success({ title: "Copied" });
		} catch {
			sileo.error({ title: "Could not copy" });
		}
	};

	const download = () => {
		if (content === null) {
			return;
		}
		const url = URL.createObjectURL(
			new Blob([content], { type: "text/plain" })
		);
		const link = window.document.createElement("a");
		link.href = url;
		link.download = exportFileName(format, environment);
		window.document.body.append(link);
		link.click();
		link.remove();
		URL.revokeObjectURL(url);
	};

	return (
		<>
			{stepUp.dialog}
			<DialogHeader>
				<DialogTitle>Export secrets</DialogTitle>
				<DialogDescription>
					{tl("Values you can read from {location}. Exports are audited.", {
						location,
					})}
				</DialogDescription>
			</DialogHeader>
			{projects.length > 0 ? (
				<div className="space-y-1.5">
					<Label htmlFor="vault-export-project">Organization project</Label>
					<Select
						items={projectItems}
						onValueChange={(value: string) => {
							setProjectId(value);
							setContent(null);
						}}
						value={projectId}
					>
						<SelectTrigger id="vault-export-project">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{projectItems.map((item) => (
								<SelectItem key={item.value} value={item.value}>
									{item.label}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
					<p className="text-muted-foreground text-xs">
						Also include the values of a project this node maps a folder to.
					</p>
				</div>
			) : null}
			<div className="flex items-end gap-3">
				<div className="flex-1 space-y-1.5">
					<Label htmlFor="vault-export-format">Format</Label>
					<Select
						items={EXPORT_FORMATS}
						onValueChange={(value: string) => {
							const next = EXPORT_FORMATS.find((item) => item.value === value);
							if (next) {
								setFormat(next.value);
								setContent(null);
							}
						}}
						value={format}
					>
						<SelectTrigger id="vault-export-format">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{EXPORT_FORMATS.map((item) => (
								<SelectItem key={item.value} value={item.value}>
									{item.label}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>
				<Button
					disabled={pending}
					loading={pending}
					onClick={run}
					variant="mono"
				>
					Export
				</Button>
			</div>
			{content === null ? null : (
				<div className="space-y-1.5">
					<Label htmlFor="vault-export-content">
						{tl("{count, plural, one {# value} other {# values}}", { count })}
					</Label>
					{sharedError ? (
						<p className="text-status-destructive text-xs">
							{sharedValuesMissingMessage(sharedError, tl)}
						</p>
					) : null}
					<Textarea
						className="min-h-40"
						id="vault-export-content"
						readOnly
						spellCheck={false}
						value={content}
						variant="code-caption"
					/>
					<div className="flex justify-end gap-2">
						<Button onClick={copy} size="sm" variant="outline">
							<HugeiconsIcon className="size-4" icon={Copy01Icon} />
							Copy
						</Button>
						<Button onClick={download} size="sm" variant="outline">
							<HugeiconsIcon className="size-4" icon={Download01Icon} />
							Download
						</Button>
					</div>
				</div>
			)}
			{error ? (
				<p className="text-sm text-status-destructive">{error}</p>
			) : null}
		</>
	);
}
