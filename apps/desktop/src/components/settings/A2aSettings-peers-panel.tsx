import { useLiteralMessages } from "@ryu/i18n/react";
import { Badge } from "@ryu/ui/components/badge.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { Label } from "@ryu/ui/components/label.tsx";
import { toast } from "@ryu/ui/components/sileo.tsx";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import {
	type A2aPeer,
	deleteA2aPeer,
	discoverA2aPeer,
	setA2aPeerTrust,
} from "@/src/lib/api/a2a.ts";
import type { Agent, AgentInput, AgentSummary } from "@/src/lib/api/agents.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	CARD_SIGNATURE_LABELS,
	cardSignatureDetail,
	credentialFromDraft,
	emptyCredentialDraft,
	errorMessage,
	isPeerCredentialKind,
	type PeerCredentialDraft,
	SectionCard,
} from "./A2aSettings-shared.tsx";

export function PeersPanel({
	agents,
	createAgent,
	onChanged,
	peers,
	target,
}: {
	agents: AgentSummary[];
	createAgent: (input: AgentInput) => Promise<Agent>;
	onChanged: () => Promise<void>;
	peers: A2aPeer[];
	target: ApiTarget;
}) {
	const tl = useLiteralMessages();
	const [url, setUrl] = useState("");
	const [name, setName] = useState("");
	const [credential, setCredential] = useState<PeerCredentialDraft>(
		emptyCredentialDraft("bearer")
	);
	const credentialReady =
		credential.kind === "none" || credentialFromDraft(credential) !== undefined;
	const discover = useMutation({
		mutationFn: () =>
			discoverA2aPeer(target, {
				credential: credentialFromDraft(credential),
				name: name || undefined,
				url,
			}),
		onSuccess: async () => {
			setUrl("");
			setName("");
			setCredential(emptyCredentialDraft("bearer"));
			toast.success("Peer discovered; review it before trusting");
			await onChanged();
		},
		onError: (error) => toast.error(errorMessage(error)),
	});
	const trust = useMutation({
		mutationFn: ({ id, value }: { id: string; value: A2aPeer["trust"] }) =>
			setA2aPeerTrust(target, id, value),
		onSuccess: onChanged,
		onError: (error) => toast.error(errorMessage(error)),
	});
	const remove = useMutation({
		mutationFn: (id: string) => deleteA2aPeer(target, id),
		onSuccess: onChanged,
		onError: (error) => toast.error(errorMessage(error)),
	});
	const addToRoster = useMutation({
		mutationFn: (peer: A2aPeer) =>
			createAgent({
				description: tl("Remote A2A peer at {agentCardUrl}", {
					agentCardUrl: peer.agentCardUrl,
				}),
				engine: `a2a:${peer.id}`,
				// Identity mode does not apply to a remote peer: it runs on its own
				// node under that node's accounts, and the editor shows a note
				// instead of the choice. The record keeps the default, and Core
				// lets only an unrestricted agent hand it work.
				identityMode: "managed",
				model: null,
				name: peer.name,
				systemPrompt: null,
				title: "Remote A2A",
				tools: [],
			}),
		onSuccess: () => toast.success("Remote peer added to the agent roster"),
		onError: (error) => toast.error(errorMessage(error)),
	});

	return (
		<SectionCard
			description="Discover an Agent Card first. Outbound calls remain blocked until you explicitly trust the peer. Credentials are write-only. A peer added to Agents works with the accounts on its own node, so it has no identity to choose here, and only an agent that acts as you with no account limit can hand it work."
			title="Peer agents"
		>
			<div className="grid gap-2 sm:grid-cols-2">
				<div className="space-y-1.5 sm:col-span-2">
					<Label htmlFor="a2a-peer-url">Agent Card or base URL</Label>
					<Input
						id="a2a-peer-url"
						onChange={(event) => setUrl(event.target.value)}
						placeholder="https://peer.example.com"
						value={url}
					/>
				</div>
				<div className="space-y-1.5">
					<Label htmlFor="a2a-peer-name">Name (optional)</Label>
					<Input
						id="a2a-peer-name"
						onChange={(event) => setName(event.target.value)}
						value={name}
					/>
				</div>
				<div className="space-y-1.5">
					<Label htmlFor="a2a-peer-credential-kind">Credential</Label>
					<select
						className="h-9 w-full rounded-md border bg-background px-3 text-sm"
						id="a2a-peer-credential-kind"
						onChange={(event) => {
							if (isPeerCredentialKind(event.target.value)) {
								setCredential(emptyCredentialDraft(event.target.value));
							}
						}}
						value={credential.kind}
					>
						<option value="none">No credential</option>
						<option value="bearer">Bearer token</option>
						<option value="api_key">API key header</option>
						<option value="basic">Basic authentication</option>
						<option value="oauth2_client_credentials">
							OAuth 2 client credentials
						</option>
					</select>
				</div>
				{credential.kind === "bearer" ? (
					<div className="space-y-1.5 sm:col-span-2">
						<Label htmlFor="a2a-peer-token">Bearer token</Label>
						<Input
							autoComplete="new-password"
							id="a2a-peer-token"
							onChange={(event) =>
								setCredential({ ...credential, token: event.target.value })
							}
							type="password"
							value={credential.token}
						/>
					</div>
				) : null}
				{credential.kind === "api_key" ? (
					<>
						<div className="space-y-1.5">
							<Label htmlFor="a2a-peer-api-header">Header name</Label>
							<Input
								id="a2a-peer-api-header"
								onChange={(event) =>
									setCredential({ ...credential, header: event.target.value })
								}
								value={credential.header}
							/>
						</div>
						<div className="space-y-1.5">
							<Label htmlFor="a2a-peer-api-value">API key</Label>
							<Input
								autoComplete="new-password"
								id="a2a-peer-api-value"
								onChange={(event) =>
									setCredential({ ...credential, value: event.target.value })
								}
								type="password"
								value={credential.value}
							/>
						</div>
					</>
				) : null}
				{credential.kind === "basic" ? (
					<>
						<div className="space-y-1.5">
							<Label htmlFor="a2a-peer-basic-user">Username</Label>
							<Input
								autoComplete="username"
								id="a2a-peer-basic-user"
								onChange={(event) =>
									setCredential({ ...credential, username: event.target.value })
								}
								value={credential.username}
							/>
						</div>
						<div className="space-y-1.5">
							<Label htmlFor="a2a-peer-basic-password">Password</Label>
							<Input
								autoComplete="new-password"
								id="a2a-peer-basic-password"
								onChange={(event) =>
									setCredential({ ...credential, password: event.target.value })
								}
								type="password"
								value={credential.password}
							/>
						</div>
					</>
				) : null}
				{credential.kind === "oauth2_client_credentials" ? (
					<>
						<div className="space-y-1.5 sm:col-span-2">
							<Label htmlFor="a2a-peer-oauth-url">Token URL</Label>
							<Input
								id="a2a-peer-oauth-url"
								onChange={(event) =>
									setCredential({ ...credential, tokenUrl: event.target.value })
								}
								placeholder="https://auth.example.com/oauth/token"
								value={credential.tokenUrl}
							/>
						</div>
						<div className="space-y-1.5">
							<Label htmlFor="a2a-peer-oauth-client">Client ID</Label>
							<Input
								id="a2a-peer-oauth-client"
								onChange={(event) =>
									setCredential({ ...credential, clientId: event.target.value })
								}
								value={credential.clientId}
							/>
						</div>
						<div className="space-y-1.5">
							<Label htmlFor="a2a-peer-oauth-secret">Client secret</Label>
							<Input
								autoComplete="new-password"
								id="a2a-peer-oauth-secret"
								onChange={(event) =>
									setCredential({
										...credential,
										clientSecret: event.target.value,
									})
								}
								type="password"
								value={credential.clientSecret}
							/>
						</div>
						<div className="space-y-1.5 sm:col-span-2">
							<Label htmlFor="a2a-peer-oauth-scopes">Scopes (optional)</Label>
							<Input
								id="a2a-peer-oauth-scopes"
								onChange={(event) =>
									setCredential({ ...credential, scopes: event.target.value })
								}
								placeholder="a2a.send a2a.read"
								value={credential.scopes}
							/>
						</div>
					</>
				) : null}
			</div>
			<Button
				disabled={!(url.trim() && credentialReady)}
				loading={discover.isPending}
				onClick={() => discover.mutate()}
				size="sm"
			>
				Discover peer
			</Button>
			<div className="divide-y rounded-md border">
				{peers.length === 0 ? (
					<p className="px-3 py-4 text-muted-foreground text-xs">
						No peer agents configured.
					</p>
				) : null}
				{peers.map((peer) => (
					<div className="flex items-center gap-2 px-3 py-2.5" key={peer.id}>
						<div className="min-w-0 flex-1">
							<div className="flex items-center gap-2">
								<p className="truncate font-medium text-sm" title={peer.name}>
									{peer.name}
								</p>
								<Badge variant="outline">{peer.trust}</Badge>
								{peer.cardSignature ? (
									<Badge
										title={cardSignatureDetail(peer.cardSignature, tl)}
										variant="outline"
									>
										{CARD_SIGNATURE_LABELS[peer.cardSignature.status]}
									</Badge>
								) : null}
							</div>
							<p className="truncate text-muted-foreground text-xs">
								{peer.agentCardUrl} · {peer.credentialKind.replaceAll("_", " ")}
								{peer.credentialConfigured ? " configured" : ""}
							</p>
						</div>
						<Button
							aria-label={tl("Add {name} to Agents", { name: peer.name })}
							disabled={
								peer.trust !== "trusted" ||
								agents.some((agent) => agent.engine === `a2a:${peer.id}`) ||
								addToRoster.isPending
							}
							onClick={() => addToRoster.mutate(peer)}
							size="sm"
							variant="ghost"
						>
							{agents.some((agent) => agent.engine === `a2a:${peer.id}`)
								? "Added"
								: "Add to Agents"}
						</Button>
						<Button
							aria-label={`${peer.trust === "trusted" ? "Revoke trust from" : "Trust"} ${peer.name}`}
							disabled={trust.isPending}
							onClick={() =>
								trust.mutate({
									id: peer.id,
									value: peer.trust === "trusted" ? "revoked" : "trusted",
								})
							}
							size="sm"
							variant="ghost"
						>
							{peer.trust === "trusted" ? "Revoke" : "Trust"}
						</Button>
						<Button
							aria-label={tl("Remove peer {name}", { name: peer.name })}
							disabled={remove.isPending}
							onClick={() => remove.mutate(peer.id)}
							size="sm"
							variant="ghost"
						>
							Remove
						</Button>
					</div>
				))}
			</div>
		</SectionCard>
	);
}
