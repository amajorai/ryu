// Sync a node folder to a connected store: the store, the folder, the name
// prefix (or, for AWS and vault stores, the remote secret path) and how often
// to re-push. Pushes also follow every write into the folder.

import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ryu/ui/components/dialog.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { Label } from "@ryu/ui/components/label.tsx";
import {
	NativeSelect,
	NativeSelectOption,
} from "@ryu/ui/components/native-select.tsx";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { sileo } from "sileo";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	createVaultExternalDestination,
	type VaultExternalStore,
} from "@/src/lib/api/vault-external.ts";
import { vaultErrorMessage } from "./vault-errors.ts";
import { remotePathHint, syncTargetLabel } from "./vault-sync-form.ts";

export const SYNC_INTERVALS = [
	{ label: "Every hour", value: 3600 },
	{ label: "Every 6 hours", value: 21_600 },
	{ label: "Every day", value: 86_400 },
	{ label: "Every 10 minutes", value: 600 },
] as const;

function SyncForm({
	environment,
	onDone,
	stores,
	target,
}: {
	environment: string;
	onDone: () => void;
	stores: VaultExternalStore[];
	target: ApiTarget;
}) {
	const tl = useLiteralMessages();
	const queryClient = useQueryClient();
	const [storeId, setStoreId] = useState(stores[0]?.id ?? "");
	const [env, setEnv] = useState(environment);
	const [path, setPath] = useState("/");
	const [remotePath, setRemotePath] = useState("");
	const [intervalSecs, setIntervalSecs] = useState(3600);
	const [problem, setProblem] = useState<string | null>(null);
	const [pending, setPending] = useState(false);
	const store = stores.find((item) => item.id === storeId);
	const hint = remotePathHint(store?.kind ?? "");

	const submit = async () => {
		setPending(true);
		setProblem(null);
		try {
			await createVaultExternalDestination(target, {
				environment: env.trim(),
				intervalSecs,
				path: path.trim() || "/",
				remotePath: remotePath.trim(),
				storeId,
			});
			await queryClient.invalidateQueries({
				queryKey: ["vault", "external"],
			});
			sileo.success({ title: "Sync added" });
			onDone();
		} catch (caught) {
			setProblem(vaultErrorMessage(caught, "Could not add the sync.", tl));
		} finally {
			setPending(false);
		}
	};

	return (
		<form
			className="space-y-3"
			onSubmit={(event) => {
				event.preventDefault();
				submit();
			}}
		>
			<DialogHeader>
				<DialogTitle>Sync a folder</DialogTitle>
				<DialogDescription>
					Values in the folder are pushed after every change and on a schedule.
					Values deleted here stay on GitHub, Vercel and Google Cloud.
				</DialogDescription>
			</DialogHeader>
			<div className="space-y-1.5">
				<Label htmlFor="sync-store">Destination</Label>
				<NativeSelect
					className="w-full"
					id="sync-store"
					onChange={(event) => setStoreId(event.target.value)}
					value={storeId}
				>
					{stores.map((item) => (
						<NativeSelectOption key={item.id} value={item.id}>
							{`${item.name} (${syncTargetLabel(item.kind)})`}
						</NativeSelectOption>
					))}
				</NativeSelect>
			</div>
			<div className="grid gap-3 sm:grid-cols-2">
				<div className="space-y-1.5">
					<Label htmlFor="sync-environment">Environment</Label>
					<Input
						autoComplete="off"
						id="sync-environment"
						onChange={(event) => setEnv(event.target.value)}
						value={env}
					/>
				</div>
				<div className="space-y-1.5">
					<Label htmlFor="sync-path">Folder</Label>
					<Input
						autoComplete="off"
						id="sync-path"
						onChange={(event) => setPath(event.target.value)}
						value={path}
					/>
				</div>
				<div className="space-y-1.5">
					<Label htmlFor="sync-remote">{hint.label}</Label>
					<Input
						autoComplete="off"
						id="sync-remote"
						onChange={(event) => setRemotePath(event.target.value)}
						placeholder={hint.placeholder}
						value={remotePath}
					/>
				</div>
				<div className="space-y-1.5">
					<Label htmlFor="sync-interval">Re-push</Label>
					<NativeSelect
						className="w-full"
						id="sync-interval"
						onChange={(event) => setIntervalSecs(Number(event.target.value))}
						value={String(intervalSecs)}
					>
						{SYNC_INTERVALS.map((item) => (
							<NativeSelectOption key={item.value} value={String(item.value)}>
								{item.label}
							</NativeSelectOption>
						))}
					</NativeSelect>
				</div>
			</div>
			{problem ? (
				<p className="text-sm text-status-destructive" role="alert">
					{problem}
				</p>
			) : null}
			<DialogFooter>
				<Button disabled={pending || !storeId} type="submit">
					Add sync
				</Button>
			</DialogFooter>
		</form>
	);
}

export function VaultSyncDialog({
	environment,
	onOpenChange,
	open,
	stores,
	target,
}: {
	environment: string;
	onOpenChange: (open: boolean) => void;
	open: boolean;
	stores: VaultExternalStore[];
	target: ApiTarget;
}) {
	return (
		<Dialog onOpenChange={onOpenChange} open={open}>
			<DialogContent className="sm:max-w-lg">
				{open ? (
					<SyncForm
						environment={environment}
						onDone={() => onOpenChange(false)}
						stores={stores}
						target={target}
					/>
				) : null}
			</DialogContent>
		</Dialog>
	);
}
