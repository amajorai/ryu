// "New folder" under the Vault page's folder list. The folder is created
// inside the selected one (or from the root when the name starts with `/`)
// and kept even while empty, so values can be saved into it next.

import { Add01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { sileo } from "sileo";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import { createVaultFolder } from "@/src/lib/api/vault-folders.ts";
import { vaultErrorMessage } from "./vault-errors.ts";
import { normalizeFolder } from "./vault-view.ts";

/** The folder a typed name creates: absolute from `/`, else inside `parent`. */
export function newFolderPath(parent: string, typed: string): string {
	const name = typed.trim();
	return normalizeFolder(name.startsWith("/") ? name : `${parent}/${name}`);
}

export function VaultNewFolder({
	environment,
	onCreated,
	parent,
	target,
}: {
	environment: string;
	onCreated: (path: string) => void;
	/** The selected folder; a relative name is created inside it. */
	parent: string;
	target: ApiTarget;
}) {
	const tl = useLiteralMessages();
	const queryClient = useQueryClient();
	const [open, setOpen] = useState(false);
	const [name, setName] = useState("");
	const create = useMutation({
		mutationFn: () =>
			createVaultFolder(target, {
				environment,
				path: newFolderPath(parent, name),
			}),
		onSuccess: async (path) => {
			await queryClient.invalidateQueries({ queryKey: ["vault", "folders"] });
			setName("");
			setOpen(false);
			onCreated(path);
			sileo.success({ title: tl("Created {folder}", { folder: path }) });
		},
	});

	if (!open) {
		return (
			<Button
				className="mt-1 w-full justify-start"
				onClick={() => setOpen(true)}
				size="sm"
				variant="ghost"
			>
				<HugeiconsIcon className="size-4" icon={Add01Icon} />
				New folder
			</Button>
		);
	}
	return (
		<form
			className="mt-1 space-y-1.5 px-1"
			onSubmit={(event) => {
				event.preventDefault();
				if (name.trim()) {
					create.mutate();
				}
			}}
		>
			<Input
				aria-label="Folder name"
				autoComplete="off"
				id="vault-new-folder"
				onChange={(event) => setName(event.target.value)}
				placeholder="api"
				value={name}
			/>
			{create.error ? (
				<p className="text-status-destructive text-xs" role="alert">
					{vaultErrorMessage(create.error, "Could not create the folder.", tl)}
				</p>
			) : null}
			<div className="flex gap-1">
				<Button
					disabled={create.isPending || name.trim() === ""}
					size="sm"
					type="submit"
					variant="mono"
				>
					Create
				</Button>
				<Button
					onClick={() => {
						setOpen(false);
						setName("");
						create.reset();
					}}
					size="sm"
					type="button"
					variant="ghost"
				>
					Cancel
				</Button>
			</div>
		</form>
	);
}
