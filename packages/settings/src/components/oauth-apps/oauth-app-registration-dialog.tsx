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
import { SensitiveValue } from "@ryu/ui/components/sensitive-value.tsx";
import { Textarea } from "@ryu/ui/components/textarea.tsx";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Copy } from "lucide-react";
import { useState } from "react";
import { sileo } from "sileo";
import type {
	CreateOAuthAppInput,
	OwnedOAuthApp,
} from "../../utils/api-client.ts";
import { settingsApi } from "../../utils/api-client.ts";
import {
	DEFAULT_SCOPES,
	errorMessage,
	OAUTH_SCOPE_CATALOG,
	scopeLabel,
} from "./shared.ts";

export function OAuthAppRegistrationDialog({
	createdApp,
	onCreatedAppChange,
	onCreated,
	onOpenChange,
	open,
}: {
	createdApp: OwnedOAuthApp | null;
	onCreatedAppChange: (app: OwnedOAuthApp | null) => void;
	onCreated: () => void;
	onOpenChange: (open: boolean) => void;
	open: boolean;
}) {
	const queryClient = useQueryClient();
	const [clientName, setClientName] = useState("");
	const [redirectUris, setRedirectUris] = useState("");
	const [applicationType, setApplicationType] =
		useState<CreateOAuthAppInput["applicationType"]>("web");
	const [clientType, setClientType] =
		useState<CreateOAuthAppInput["clientType"]>("confidential");
	const [selectedScopes, setSelectedScopes] =
		useState<string[]>(DEFAULT_SCOPES);
	const [copied, setCopied] = useState(false);

	const createMutation = useMutation({
		mutationFn: settingsApi.oauthApps.owned.create,
		onSuccess: ({ app }) => {
			onCreatedAppChange(app);
			void queryClient.invalidateQueries({ queryKey: ["oauth-apps", "owned"] });
			onCreated();
		},
	});

	function resetForm() {
		setClientName("");
		setRedirectUris("");
		setApplicationType("web");
		setClientType("confidential");
		setSelectedScopes(DEFAULT_SCOPES);
		setCopied(false);
		createMutation.reset();
	}

	function close() {
		onOpenChange(false);
		onCreatedAppChange(null);
		resetForm();
	}

	function toggleScope(scope: string) {
		setSelectedScopes((current) =>
			current.includes(scope)
				? current.filter((candidate) => candidate !== scope)
				: [...current, scope]
		);
	}

	function createOAuthApp() {
		const uris = redirectUris
			.split(/\r?\n/)
			.map((uri) => uri.trim())
			.filter(Boolean);
		createMutation.mutate({
			applicationType,
			clientName: clientName.trim(),
			clientType,
			redirectUris: uris,
			scopes: selectedScopes,
		});
	}

	async function copySecret() {
		if (!createdApp?.clientSecret) {
			return;
		}
		try {
			await navigator.clipboard.writeText(createdApp.clientSecret);
			setCopied(true);
			setTimeout(() => setCopied(false), 2000);
		} catch {
			sileo.error({ title: "Could not copy the client secret" });
		}
	}

	const canCreate =
		clientName.trim().length > 0 &&
		redirectUris.split(/\r?\n/).some((uri) => uri.trim()) &&
		selectedScopes.length > 0;

	return (
		<Dialog
			onOpenChange={(nextOpen) => (nextOpen ? onOpenChange(true) : close())}
			open={open}
		>
			<DialogContent className="max-w-2xl">
				<DialogHeader>
					<DialogTitle>
						{createdApp ? "OAuth app credentials" : "Create OAuth app"}
					</DialogTitle>
					<DialogDescription>
						{createdApp
							? "Save these credentials before closing. Ryu will not show the secret again."
							: "OAuth 2.1 clients use authorization code flow with PKCE. Choose the scopes this app may request."}
					</DialogDescription>
				</DialogHeader>

				{createdApp ? (
					<div className="space-y-4">
						<div className="space-y-1.5">
							<Label>Client ID</Label>
							<code className="block break-all rounded-md border bg-muted p-3 font-mono text-xs">
								{createdApp.clientId}
							</code>
						</div>
						{createdApp.clientSecret ? (
							<div className="space-y-1.5">
								<Label>Client secret</Label>
								<div className="flex items-center gap-2 rounded-md border bg-muted p-3">
									<code className="flex-1 break-all font-mono text-xs">
										<SensitiveValue
											label="client secret"
											value={createdApp.clientSecret}
										/>
									</code>
									<Button
										aria-label="Copy client secret"
										onClick={() => void copySecret()}
										size="sm"
										variant="ghost"
									>
										{copied ? "Copied" : <Copy className="size-4" />}
									</Button>
								</div>
							</div>
						) : (
							<p className="rounded-md bg-muted p-3 text-muted-foreground text-sm">
								This public client has no client secret. Keep using PKCE.
							</p>
						)}
					</div>
				) : (
					<div className="space-y-4">
						<div className="space-y-2">
							<Label htmlFor="oauth-app-name">App name</Label>
							<Input
								autoComplete="off"
								id="oauth-app-name"
								onChange={(event) => setClientName(event.target.value)}
								placeholder="e.g. Acme deployment bot"
								value={clientName}
							/>
						</div>

						<div className="space-y-2">
							<Label htmlFor="oauth-app-redirect-uris">
								Redirect URIs, one per line
							</Label>
							<Textarea
								autoComplete="off"
								id="oauth-app-redirect-uris"
								onChange={(event) => setRedirectUris(event.target.value)}
								placeholder="https://example.com/oauth/callback"
								rows={3}
								value={redirectUris}
							/>
							<p className="text-muted-foreground text-xs">
								Better Auth validates every URI for the selected web or native
								app type.
							</p>
						</div>

						<div className="grid gap-3 sm:grid-cols-2">
							<div className="space-y-2">
								<Label>Application type</Label>
								<div className="flex gap-2">
									{(["web", "native"] as const).map((value) => (
										<Button
											aria-pressed={applicationType === value}
											key={value}
											onClick={() => setApplicationType(value)}
											size="sm"
											variant={
												applicationType === value ? "default" : "outline"
											}
										>
											{value[0]?.toUpperCase() ?? ""}
											{value.slice(1)}
										</Button>
									))}
								</div>
							</div>

							<div className="space-y-2">
								<Label>Client type</Label>
								<div className="flex gap-2">
									{(["confidential", "public"] as const).map((value) => (
										<Button
											aria-pressed={clientType === value}
											key={value}
											onClick={() => setClientType(value)}
											size="sm"
											variant={clientType === value ? "default" : "outline"}
										>
											{value[0]?.toUpperCase() ?? ""}
											{value.slice(1)}
										</Button>
									))}
								</div>
							</div>
						</div>

						<div className="space-y-2">
							<Label>Allowed scopes</Label>
							<div className="flex max-h-44 flex-wrap gap-2 overflow-y-auto rounded-md border p-3">
								{OAUTH_SCOPE_CATALOG.map((scope) => {
									const active = selectedScopes.includes(scope);
									return (
										<Button
											aria-pressed={active}
											key={scope}
											onClick={() => toggleScope(scope)}
											size="sm"
											variant={active ? "default" : "outline"}
										>
											{scopeLabel(scope)}
										</Button>
									);
								})}
							</div>
						</div>

						{createMutation.isError ? (
							<p className="text-sm text-status-destructive" role="alert">
								{errorMessage(
									createMutation.error,
									"Failed to create OAuth app"
								)}
							</p>
						) : null}
					</div>
				)}

				<DialogFooter>
					{createdApp ? (
						<Button onClick={close}>Done</Button>
					) : (
						<>
							<Button onClick={close} variant="ghost">
								Cancel
							</Button>
							<Button
								disabled={!canCreate || createMutation.isPending}
								loading={createMutation.isPending}
								onClick={createOAuthApp}
							>
								Create app
							</Button>
						</>
					)}
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
