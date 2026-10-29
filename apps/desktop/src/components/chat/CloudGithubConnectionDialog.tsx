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
import { useEffect, useState } from "react";
import { ApiError, type ApiTarget } from "@/src/lib/api/client.ts";
import { fetchCloudEnvironments } from "@/src/lib/api/cloud-environments.ts";
import {
	type CloudGithubConnection,
	connectCloudGithub,
	fetchCloudGithub,
} from "@/src/lib/api/cloud-github.ts";

const githubError = <TError,>(failure: TError) =>
	failure instanceof ApiError && failure.serverMessage
		? failure.serverMessage
		: failure instanceof Error
			? failure.message
			: "Could not verify GitHub connection";

export function CloudGithubConnectionDialog({
	target,
	onClose,
	onRepository,
}: {
	target: ApiTarget;
	onClose: () => void;
	onRepository: (repository: string, vaultKey: string) => void;
}) {
	const tl = useLiteralMessages();
	const [connection, setConnection] = useState<CloudGithubConnection | null>(
		null
	);
	const [token, setToken] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [search, setSearch] = useState("");
	useEffect(() => {
		const controller = new AbortController();
		fetchCloudGithub(target, controller.signal)
			.then((result) => {
				if (!controller.signal.aborted) {
					setConnection(result);
				}
			})
			.catch((failure) => {
				if (!controller.signal.aborted) {
					setError(githubError(failure));
				}
			});
		return () => controller.abort();
	}, [target.url, target.token, target.userJwt]);
	async function connect() {
		setBusy(true);
		setError(null);
		try {
			const snapshot = await fetchCloudEnvironments(target);
			setConnection(await connectCloudGithub(target, token, snapshot.revision));
			setToken("");
		} catch (failure) {
			setError(githubError(failure));
		} finally {
			setBusy(false);
		}
	}
	return (
		<Dialog
			onOpenChange={(open) => {
				if (!(open || busy)) {
					onClose();
				}
			}}
			open
		>
			<DialogContent className="max-h-[90dvh] overflow-y-auto">
				<DialogHeader>
					<DialogTitle>Connect GitHub</DialogTitle>
					<DialogDescription>
						Ryu verifies your personal access token with GitHub before saving it
						to your encrypted personal vault. It is used through the credential
						proxy for repository access and stays hidden after saving.
					</DialogDescription>
				</DialogHeader>
				{error ? (
					<p className="text-sm text-status-destructive" role="alert">
						{error}
					</p>
				) : null}
				{connection?.connected ? (
					<div className="space-y-3">
						<p className="text-sm" role="status">
							{tl("Connected as {login}", { login: connection.login })}
						</p>
						<Input
							aria-label="Search GitHub repositories"
							onChange={(event) => setSearch(event.target.value)}
							placeholder="Search repositories"
							value={search}
						/>
						<div className="max-h-60 space-y-1 overflow-y-auto">
							{connection.repositories
								.filter((repository) =>
									repository.fullName
										.toLowerCase()
										.includes(search.toLowerCase())
								)
								.map((repository) => (
									<Button
										className="w-full justify-start"
										key={repository.fullName}
										onClick={() => {
											if (connection.vaultKey) {
												onRepository(repository.fullName, connection.vaultKey);
											}
										}}
										size="sm"
										variant="ghost"
									>
										{repository.fullName}
										{repository.private ? " · Private" : ""}
									</Button>
								))}
						</div>
						<p className="text-muted-foreground text-xs">
							Choose a repository to create an environment draft. Publish it
							before starting a cloud task.
						</p>
					</div>
				) : null}
				<div className="space-y-2">
					<Label htmlFor="cloud-github-token">
						GitHub personal access token
					</Label>
					<Input
						autoComplete="off"
						id="cloud-github-token"
						onChange={(event) => setToken(event.target.value)}
						type="password"
						value={token}
					/>
					<p className="text-muted-foreground text-xs">
						Use a token with read access to the repositories you want to clone.
						Your Gateway must allow api.github.com for verification.
					</p>
				</div>
				<DialogFooter>
					<Button disabled={busy} onClick={onClose} variant="ghost">
						Close
					</Button>
					<Button disabled={busy || !token.trim()} onClick={connect}>
						{busy ? "Verifying…" : "Verify and connect"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
