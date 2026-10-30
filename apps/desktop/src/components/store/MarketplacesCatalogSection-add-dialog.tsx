import { Add01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@ryu/ui/components/dialog.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { Label } from "@ryu/ui/components/label.tsx";
import { useState } from "react";
import type { CatalogKind } from "@/src/lib/api/catalog-sources.ts";

export function AddMarketplaceDialog({
	busy,
	kinds,
	onAdd,
	onOpenChange,
	open,
}: {
	busy: boolean;
	kinds: CatalogKind[];
	onAdd: (input: {
		authEnvVar?: string;
		baseUrl: string;
		displayName: string;
		id: string;
		kinds: CatalogKind[];
	}) => Promise<void>;
	onOpenChange: (open: boolean) => void;
	open: boolean;
}) {
	const [displayName, setDisplayName] = useState("");
	const [id, setId] = useState("");
	const [baseUrl, setBaseUrl] = useState("");
	const [authEnvVar, setAuthEnvVar] = useState("");
	const [selectedKinds, setSelectedKinds] = useState<CatalogKind[]>(kinds);
	const [error, setError] = useState<string | null>(null);

	const reset = () => {
		setDisplayName("");
		setId("");
		setBaseUrl("");
		setAuthEnvVar("");
		setSelectedKinds(kinds);
		setError(null);
	};

	const submit = async () => {
		if (!(displayName.trim() && id.trim() && baseUrl.trim())) {
			setError("Name, id, and repository or URL are required.");
			return;
		}
		if (selectedKinds.length === 0) {
			setError("Choose at least one catalog section.");
			return;
		}
		try {
			await onAdd({
				authEnvVar: authEnvVar.trim() || undefined,
				baseUrl: baseUrl.trim(),
				displayName: displayName.trim(),
				id: id.trim(),
				kinds: selectedKinds,
			});
			reset();
		} catch (submitError) {
			setError(
				submitError instanceof Error
					? submitError.message
					: "Failed to add marketplace"
			);
		}
	};

	return (
		<Dialog
			onOpenChange={(value) => {
				if (!value) {
					reset();
				}
				onOpenChange(value);
			}}
			open={open}
		>
			<DialogTrigger render={<Button size="sm" />}>
				<HugeiconsIcon className="size-4" icon={Add01Icon} />
				Add marketplace
			</DialogTrigger>
			<DialogContent className="sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>Add a marketplace</DialogTitle>
					<DialogDescription>
						Add a public or private GitHub-style marketplace. Private auth is
						stored as an environment-variable reference, never as a token in the
						UI.
					</DialogDescription>
				</DialogHeader>
				<div className="flex flex-col gap-4 py-2">
					<div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
						<div className="flex flex-col gap-1.5">
							<Label htmlFor="marketplace-name">Name</Label>
							<Input
								id="marketplace-name"
								onChange={(event) => setDisplayName(event.target.value)}
								value={displayName}
							/>
						</div>
						<div className="flex flex-col gap-1.5">
							<Label htmlFor="marketplace-id">Id</Label>
							<Input
								id="marketplace-id"
								onChange={(event) => setId(event.target.value)}
								placeholder="owner/repository"
								value={id}
							/>
						</div>
					</div>
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="marketplace-url">Repository or manifest URL</Label>
						<Input
							id="marketplace-url"
							onChange={(event) => setBaseUrl(event.target.value)}
							placeholder="https://github.com/owner/repository"
							value={baseUrl}
						/>
					</div>
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="marketplace-auth-env">
							Auth environment variable (optional)
						</Label>
						<Input
							id="marketplace-auth-env"
							onChange={(event) => setAuthEnvVar(event.target.value)}
							placeholder="GITHUB_TOKEN"
							value={authEnvVar}
						/>
					</div>
					<div className="flex flex-col gap-2">
						<Label>List this marketplace under</Label>
						<div className="flex flex-wrap gap-2">
							{kinds.map((kind) => {
								const selected = selectedKinds.includes(kind);
								return (
									<Button
										key={kind}
										onClick={() =>
											setSelectedKinds((current) =>
												current.includes(kind)
													? current.filter((value) => value !== kind)
													: [...current, kind]
											)
										}
										size="sm"
										variant={selected ? "default" : "outline"}
									>
										{kind === "plugin" ? "Apps and plugins" : "Skills"}
									</Button>
								);
							})}
						</div>
					</div>
					{error ? (
						<p className="text-sm text-status-destructive">{error}</p>
					) : null}
				</div>
				<DialogFooter>
					<Button onClick={() => onOpenChange(false)} variant="ghost">
						Cancel
					</Button>
					<Button loading={busy} onClick={submit}>
						Add marketplace
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
