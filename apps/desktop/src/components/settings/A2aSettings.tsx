import { Badge } from "@ryu/ui/components/badge.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { Label } from "@ryu/ui/components/label.tsx";
import { SensitiveValue } from "@ryu/ui/components/sensitive-value.tsx";
import { toast } from "@ryu/ui/components/sileo.tsx";
import { SkeletonRows } from "@ryu/ui/components/skeleton.tsx";
import { Switch } from "@ryu/ui/components/switch.tsx";
import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { z } from "zod";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import { useAgents } from "@/src/hooks/useAgents.ts";
import {
	type A2aCardSignature,
	type A2aPeer,
	type A2aPeerCredential,
	type A2aPrincipal,
	type A2aPublishedAgent,
	type A2aScope,
	type A2aServerConfig,
	type A2aTaskRecord,
	cancelA2aTask,
	deleteA2aPeer,
	deletePublishedA2aAgent,
	discoverA2aPeer,
	getA2aSettings,
	issueA2aPrincipal,
	listA2aPeers,
	listA2aPrincipals,
	listA2aTasks,
	listPublishedA2aAgents,
	publishA2aAgent,
	revokeA2aPrincipal,
	saveA2aSettings,
	setA2aPeerTrust,
} from "@/src/lib/api/a2a.ts";
import type { Agent, AgentInput, AgentSummary } from "@/src/lib/api/agents.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";

const ALL_SCOPES: A2aScope[] = [
	"send",
	"read",
	"cancel",
	"subscribe",
	"push_config",
	"extended_card",
];

const CARD_SIGNATURE_LABELS: Record<A2aCardSignature["status"], string> = {
	invalid: "signature invalid",
	unsigned: "unsigned card",
	unverifiable: "signature unchecked",
	verified: "signed card",
};

function cardSignatureDetail(signature: A2aCardSignature): string {
	switch (signature.status) {
		case "verified":
			return `Agent Card signature verified with key ${signature.kid}`;
		case "unsigned":
			return "The peer's Agent Card carries no signature";
		case "unverifiable":
		case "invalid":
			return signature.reason;
		default:
			return "";
	}
}

type PeerCredentialDraft =
	| { kind: "none" }
	| { kind: "bearer"; token: string }
	| { header: string; kind: "api_key"; value: string }
	| { kind: "basic"; password: string; username: string }
	| {
			clientId: string;
			clientSecret: string;
			kind: "oauth2_client_credentials";
			scopes: string;
			tokenUrl: string;
	  };

function isPeerCredentialKind(
	value: string
): value is A2aPeerCredential["kind"] {
	return (
		value === "none" ||
		value === "bearer" ||
		value === "api_key" ||
		value === "basic" ||
		value === "oauth2_client_credentials"
	);
}

function emptyCredentialDraft(
	kind: A2aPeerCredential["kind"]
): PeerCredentialDraft {
	switch (kind) {
		case "none":
			return { kind };
		case "bearer":
			return { kind, token: "" };
		case "api_key":
			return { header: "X-API-Key", kind, value: "" };
		case "basic":
			return { kind, password: "", username: "" };
		case "oauth2_client_credentials":
			return {
				clientId: "",
				clientSecret: "",
				kind,
				scopes: "",
				tokenUrl: "",
			};
		default: {
			const exhaustive: never = kind;
			return exhaustive;
		}
	}
}

function credentialFromDraft(
	draft: PeerCredentialDraft
): A2aPeerCredential | undefined {
	switch (draft.kind) {
		case "none":
			return undefined;
		case "bearer":
			return draft.token.trim() ? draft : undefined;
		case "api_key":
			return draft.header.trim() && draft.value.trim() ? draft : undefined;
		case "basic":
			return draft.username.trim() && draft.password.trim() ? draft : undefined;
		case "oauth2_client_credentials":
			return draft.tokenUrl.trim() &&
				draft.clientId.trim() &&
				draft.clientSecret.trim()
				? {
						clientId: draft.clientId,
						clientSecret: draft.clientSecret,
						kind: draft.kind,
						scopes: draft.scopes
							.split(/[\s,]+/)
							.map((scope) => scope.trim())
							.filter(Boolean),
						tokenUrl: draft.tokenUrl,
					}
				: undefined;
		default: {
			const exhaustive: never = draft;
			return exhaustive;
		}
	}
}

function errorMessage<TError>(error: TError): string {
	const parsed = z
		.object({ serverMessage: z.string().min(1) })
		.safeParse(error);
	if (parsed.success) {
		return parsed.data.serverMessage;
	}
	return error instanceof Error ? error.message : "The A2A request failed";
}

function artifactSummaries(
	task: A2aTaskRecord
): { id: string; name: string }[] {
	const artifacts = task.protocolTask.artifacts;
	if (!Array.isArray(artifacts)) {
		return [];
	}
	const summaries: { id: string; name: string }[] = [];
	for (const artifact of artifacts) {
		const parsed = z
			.object({
				artifactId: z.string(),
				name: z.string().optional().catch(undefined),
			})
			.safeParse(artifact);
		if (!parsed.success) {
			continue;
		}
		const id = parsed.data.artifactId;
		const rawName = parsed.data.name;
		summaries.push({
			id,
			name: isNativeText(rawName) && rawName ? rawName : "Artifact",
		});
	}
	return summaries;
}

function SectionCard({
	children,
	description,
	title,
}: {
	children: ReactNode;
	description: string;
	title: string;
}) {
	return (
		<div className="space-y-4 rounded-lg bg-muted/40 p-4">
			<div>
				<h3 className="font-medium text-sm">{title}</h3>
				<p className="text-muted-foreground text-xs">{description}</p>
			</div>
			{children}
		</div>
	);
}

interface A2aAgentRoster {
	agents: AgentSummary[];
	create: (input: AgentInput) => Promise<Agent>;
}

export function A2aSettings() {
	const agentRoster = useAgents();
	return <A2aSettingsView agentRoster={agentRoster} />;
}

export function A2aSettingsView({
	agentRoster,
}: {
	agentRoster: A2aAgentRoster;
}) {
	const node = useActiveNode();
	const target: ApiTarget = {
		url: node.url,
		token: node.token ?? null,
		userJwt: node.userJwt ?? null,
	};
	const queryClient = useQueryClient();
	const settings = useQuery({
		queryKey: ["a2a", node.url, "settings"],
		queryFn: () => getA2aSettings(target),
	});
	const peers = useQuery({
		queryKey: ["a2a", node.url, "peers"],
		queryFn: () => listA2aPeers(target),
	});
	const principals = useQuery({
		queryKey: ["a2a", node.url, "principals"],
		queryFn: () => listA2aPrincipals(target),
	});
	const published = useQuery({
		queryKey: ["a2a", node.url, "published-agents"],
		queryFn: () => listPublishedA2aAgents(target),
	});
	const tasks = useQuery({
		queryKey: ["a2a", node.url, "tasks"],
		queryFn: () => listA2aTasks(target),
		refetchInterval: (query) =>
			(query.state.data ?? []).some((task) =>
				["submitted", "working"].includes(task.state)
			)
				? 2000
				: false,
	});
	const reload = async () => {
		await queryClient.invalidateQueries({ queryKey: ["a2a", node.url] });
	};
	const firstError =
		settings.error ??
		peers.error ??
		principals.error ??
		published.error ??
		tasks.error;

	if (settings.isLoading && !settings.data) {
		return <SkeletonRows inset="catalog" />;
	}
	if (!settings.data) {
		return (
			<div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm">
				<p className="font-medium">A2A settings are unavailable</p>
				<p className="mt-1 text-muted-foreground text-xs">
					{errorMessage(firstError)}
				</p>
				<Button
					className="mt-3"
					onClick={() => void settings.refetch()}
					size="sm"
				>
					Retry
				</Button>
			</div>
		);
	}

	return (
		<div className="space-y-4">
			{firstError ? (
				<div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-status-destructive text-xs">
					<span>{errorMessage(firstError)}</span>
					<Button onClick={() => void reload()} size="sm" variant="ghost">
						Retry A2A data
					</Button>
				</div>
			) : null}
			<ServerConfigForm
				config={settings.data}
				key={settings.data.updatedAt || "default"}
				onSaved={reload}
				target={target}
			/>
			<PublishedAgentsPanel
				agents={agentRoster.agents}
				onChanged={reload}
				published={published.data ?? []}
				target={target}
			/>
			<PeersPanel
				agents={agentRoster.agents}
				createAgent={agentRoster.create}
				onChanged={reload}
				peers={peers.data ?? []}
				target={target}
			/>
			<AccessPanel
				onChanged={reload}
				principals={principals.data ?? []}
				target={target}
			/>
			<TasksPanel onChanged={reload} target={target} tasks={tasks.data ?? []} />
		</div>
	);
}

function ServerConfigForm({
	config,
	onSaved,
	target,
}: {
	config: A2aServerConfig;
	onSaved: () => Promise<void>;
	target: ApiTarget;
}) {
	const [draft, setDraft] = useState(config);
	const mutation = useMutation({
		mutationFn: () => saveA2aSettings(target, draft),
		onSuccess: async () => {
			toast.success("A2A endpoint settings saved");
			await onSaved();
		},
		onError: (error) => toast.error(errorMessage(error)),
	});
	const cardUrl = draft.publicBaseUrl
		? `${draft.publicBaseUrl.replace(/\/$/, "")}/.well-known/agent-card.json`
		: `${target.url.replace(/\/$/, "")}/.well-known/agent-card.json`;

	return (
		<SectionCard
			description="Expose selected local agents through the Linux Foundation A2A v1 HTTP protocol. Inbound access stays off until you enable it and issue a peer token."
			title="Agent-to-Agent endpoint"
		>
			<div className="flex items-center justify-between gap-4">
				<div>
					<p className="font-medium text-sm">Accept inbound A2A tasks</p>
					<p className="text-muted-foreground text-xs">
						Publishes JSON-RPC and HTTP+JSON interfaces with streaming and push
						updates.
					</p>
				</div>
				<Switch
					aria-label="Accept inbound A2A tasks"
					checked={draft.enabled}
					onCheckedChange={(enabled) => setDraft({ ...draft, enabled })}
				/>
			</div>
			<div className="grid gap-3 sm:grid-cols-2">
				<div className="space-y-1.5">
					<Label htmlFor="a2a-display-name">Display name</Label>
					<Input
						id="a2a-display-name"
						onChange={(event) =>
							setDraft({ ...draft, displayName: event.target.value })
						}
						value={draft.displayName}
					/>
				</div>
				<div className="space-y-1.5">
					<Label htmlFor="a2a-public-base">Public base URL</Label>
					<Input
						id="a2a-public-base"
						onChange={(event) =>
							setDraft({
								...draft,
								publicBaseUrl: event.target.value || null,
							})
						}
						placeholder="https://agent.example.com"
						value={draft.publicBaseUrl ?? ""}
					/>
				</div>
			</div>
			<div className="space-y-1.5">
				<Label htmlFor="a2a-description">Description</Label>
				<Input
					id="a2a-description"
					onChange={(event) =>
						setDraft({ ...draft, description: event.target.value })
					}
					value={draft.description}
				/>
			</div>
			<div className="grid gap-3 sm:grid-cols-2">
				<div className="space-y-1.5">
					<Label htmlFor="a2a-concurrency">Maximum concurrent tasks</Label>
					<Input
						id="a2a-concurrency"
						max={1024}
						min={1}
						onChange={(event) =>
							setDraft({
								...draft,
								maxConcurrentTasks: Number(event.target.value),
							})
						}
						type="number"
						value={draft.maxConcurrentTasks}
					/>
				</div>
				<div className="space-y-1.5">
					<Label htmlFor="a2a-payload-limit">Maximum payload (MiB)</Label>
					<Input
						id="a2a-payload-limit"
						max={16}
						min={1}
						onChange={(event) =>
							setDraft({
								...draft,
								maxPayloadBytes: Number(event.target.value) * 1024 * 1024,
							})
						}
						type="number"
						value={draft.maxPayloadBytes / (1024 * 1024)}
					/>
				</div>
			</div>
			<div className="flex items-center justify-between gap-4">
				<div>
					<p className="font-medium text-sm">Authenticated extended card</p>
					<p className="text-muted-foreground text-xs">
						Let authorized peers fetch the extended Agent Card.
					</p>
				</div>
				<Switch
					aria-label="Expose authenticated extended Agent Card"
					checked={draft.exposeExtendedCard}
					onCheckedChange={(exposeExtendedCard) =>
						setDraft({ ...draft, exposeExtendedCard })
					}
				/>
			</div>
			<div className="flex items-center justify-between gap-4">
				<div>
					<p className="font-medium text-sm">Require signed peer cards</p>
					<p className="text-muted-foreground text-xs">
						Only discover peers whose Agent Card signature verifies.
					</p>
				</div>
				<Switch
					aria-label="Require verified Agent Card signatures from peers"
					checked={draft.requireSignedPeerCards ?? false}
					onCheckedChange={(requireSignedPeerCards) =>
						setDraft({ ...draft, requireSignedPeerCards })
					}
				/>
			</div>
			<div className="rounded-md border bg-background/60 px-3 py-2">
				<p className="text-muted-foreground text-xs">Agent Card</p>
				<code className="break-all text-xs">{cardUrl}</code>
			</div>
			<Button
				loading={mutation.isPending}
				onClick={() => mutation.mutate()}
				size="sm"
			>
				Save endpoint
			</Button>
		</SectionCard>
	);
}

function PublishedAgentsPanel({
	agents,
	onChanged,
	published,
	target,
}: {
	agents: AgentSummary[];
	onChanged: () => Promise<void>;
	published: A2aPublishedAgent[];
	target: ApiTarget;
}) {
	const [agentId, setAgentId] = useState("");
	const selected = agents.find((agent) => agent.id === agentId);
	const publish = useMutation({
		mutationFn: () => {
			if (!selected) {
				throw new Error("Choose a local agent to publish");
			}
			const description =
				selected.description || `A2A access to ${selected.name}`;
			return publishA2aAgent(target, {
				agentId: selected.id,
				description,
				enabled: true,
				name: selected.name,
				skills: [
					{
						description,
						id: `ryu:${selected.id}`,
						name: selected.name,
						tags: ["ryu"],
					},
				],
			});
		},
		onSuccess: async () => {
			setAgentId("");
			toast.success("Agent published to A2A");
			await onChanged();
		},
		onError: (error) => toast.error(errorMessage(error)),
	});
	const update = useMutation({
		mutationFn: (agent: A2aPublishedAgent) =>
			publishA2aAgent(target, {
				agentId: agent.agentId,
				description: agent.description,
				enabled: !agent.enabled,
				id: agent.id,
				name: agent.name,
				skills: agent.skills,
			}),
		onSuccess: onChanged,
		onError: (error) => toast.error(errorMessage(error)),
	});
	const remove = useMutation({
		mutationFn: (id: string) => deletePublishedA2aAgent(target, id),
		onSuccess: onChanged,
		onError: (error) => toast.error(errorMessage(error)),
	});

	return (
		<SectionCard
			description="Only published agents appear in the public Agent Card or receive inbound tasks."
			title="Published agents"
		>
			<div className="flex gap-2">
				<label className="sr-only" htmlFor="a2a-agent-picker">
					Local agent
				</label>
				<select
					className="h-9 min-w-0 flex-1 rounded-md border bg-background px-3 text-sm"
					id="a2a-agent-picker"
					onChange={(event) => setAgentId(event.target.value)}
					value={agentId}
				>
					<option value="">Choose a local agent…</option>
					{agents.map((agent) => (
						<option key={agent.id} value={agent.id}>
							{agent.name}
						</option>
					))}
				</select>
				<Button
					disabled={!selected}
					loading={publish.isPending}
					onClick={() => publish.mutate()}
					size="sm"
				>
					Publish
				</Button>
			</div>
			<div className="divide-y rounded-md border">
				{published.length === 0 ? (
					<p className="px-3 py-4 text-muted-foreground text-xs">
						No agents are published.
					</p>
				) : null}
				{published.map((agent) => (
					<div className="flex items-center gap-3 px-3 py-2.5" key={agent.id}>
						<div className="min-w-0 flex-1">
							<p className="truncate font-medium text-sm" title={agent.name}>
								{agent.name}
							</p>
							<p className="truncate text-muted-foreground text-xs">
								{agent.agentId} · {agent.skills.length} skill
								{agent.skills.length === 1 ? "" : "s"}
							</p>
						</div>
						<Switch
							aria-label={`${agent.enabled ? "Disable" : "Enable"} ${agent.name}`}
							checked={agent.enabled}
							disabled={update.isPending}
							onCheckedChange={() => update.mutate(agent)}
						/>
						<Button
							aria-label={`Remove published agent ${agent.name}`}
							disabled={remove.isPending}
							onClick={() => remove.mutate(agent.id)}
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

function PeersPanel({
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
				description: `Remote A2A peer at ${peer.agentCardUrl}`,
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
										title={cardSignatureDetail(peer.cardSignature)}
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
							aria-label={`Add ${peer.name} to Agents`}
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
							aria-label={`Remove peer ${peer.name}`}
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

function AccessPanel({
	onChanged,
	principals,
	target,
}: {
	onChanged: () => Promise<void>;
	principals: A2aPrincipal[];
	target: ApiTarget;
}) {
	const [name, setName] = useState("");
	const [scopes, setScopes] = useState<A2aScope[]>(ALL_SCOPES);
	const [issuedToken, setIssuedToken] = useState<string | null>(null);
	const issue = useMutation({
		mutationFn: () => issueA2aPrincipal(target, name, scopes),
		onSuccess: async (issued) => {
			setIssuedToken(issued.token);
			setName("");
			await onChanged();
		},
		onError: (error) => toast.error(errorMessage(error)),
	});
	const revoke = useMutation({
		mutationFn: (id: string) => revokeA2aPrincipal(target, id),
		onSuccess: onChanged,
		onError: (error) => toast.error(errorMessage(error)),
	});
	const toggleScope = (scope: A2aScope) => {
		setScopes((current) =>
			current.includes(scope)
				? current.filter((value) => value !== scope)
				: [...current, scope]
		);
	};

	return (
		<SectionCard
			description="Issue a separate scoped token for each inbound peer. Ryu stores only its hash and shows the token once."
			title="Inbound peer access"
		>
			<div className="flex gap-2">
				<div className="min-w-0 flex-1 space-y-1.5">
					<Label htmlFor="a2a-principal-name">Peer name</Label>
					<Input
						id="a2a-principal-name"
						onChange={(event) => setName(event.target.value)}
						placeholder="Hermes production"
						value={name}
					/>
				</div>
				<Button
					className="self-end"
					disabled={!name.trim() || scopes.length === 0}
					loading={issue.isPending}
					onClick={() => issue.mutate()}
					size="sm"
				>
					Issue token
				</Button>
			</div>
			<fieldset>
				<legend className="mb-2 text-muted-foreground text-xs">
					Allowed operations
				</legend>
				<div className="flex flex-wrap gap-x-4 gap-y-2">
					{ALL_SCOPES.map((scope) => (
						<label className="flex items-center gap-1.5 text-xs" key={scope}>
							<input
								checked={scopes.includes(scope)}
								onChange={() => toggleScope(scope)}
								type="checkbox"
							/>
							{scope.replace("_", " ")}
						</label>
					))}
				</div>
			</fieldset>
			{issuedToken ? (
				<div className="rounded-md border border-warning/30 bg-warning/5 p-3">
					<p className="font-medium text-sm">Copy this token now</p>
					<p className="mb-2 text-muted-foreground text-xs">
						It cannot be retrieved after this panel is dismissed or another
						token is issued.
					</p>
					<code className="block select-all break-all rounded bg-background p-2 text-xs">
						<SensitiveValue label="A2A token" value={issuedToken} />
					</code>
					<Button
						aria-label="Copy A2A token"
						className="mt-2"
						onClick={async () => {
							try {
								await navigator.clipboard.writeText(issuedToken);
								toast.success("A2A token copied");
							} catch {
								toast.error(
									"Couldn't copy the A2A token. Reveal and copy it while this panel is open."
								);
							}
						}}
						size="sm"
						variant="ghost"
					>
						Copy token
					</Button>
				</div>
			) : null}
			<div className="divide-y rounded-md border">
				{principals.length === 0 ? (
					<p className="px-3 py-4 text-muted-foreground text-xs">
						No inbound peer tokens issued.
					</p>
				) : null}
				{principals.map((principal) => (
					<div
						className="flex items-center gap-3 px-3 py-2.5"
						key={principal.id}
					>
						<div className="min-w-0 flex-1">
							<p
								className="truncate font-medium text-sm"
								title={principal.name}
							>
								{principal.name}
							</p>
							<p
								className="truncate text-muted-foreground text-xs"
								title={principal.scopes.join(", ")}
							>
								{principal.scopes.join(", ")}
							</p>
						</div>
						{principal.revokedAt ? (
							<Badge variant="outline">revoked</Badge>
						) : null}
						<Button
							aria-label={`Revoke token for ${principal.name}`}
							disabled={Boolean(principal.revokedAt) || revoke.isPending}
							onClick={() => revoke.mutate(principal.id)}
							size="sm"
							variant="ghost"
						>
							Revoke
						</Button>
					</div>
				))}
			</div>
		</SectionCard>
	);
}

function TasksPanel({
	onChanged,
	target,
	tasks,
}: {
	onChanged: () => Promise<void>;
	target: ApiTarget;
	tasks: A2aTaskRecord[];
}) {
	const cancel = useMutation({
		mutationFn: (id: string) => cancelA2aTask(target, id),
		onSuccess: onChanged,
		onError: (error) => toast.error(errorMessage(error)),
	});
	return (
		<SectionCard
			description="Recent inbound and outbound protocol tasks, including persisted state and artifact counts."
			title="Recent A2A tasks"
		>
			<div className="divide-y rounded-md border">
				{tasks.length === 0 ? (
					<p className="px-3 py-4 text-muted-foreground text-xs">
						No A2A tasks yet.
					</p>
				) : null}
				{tasks.map((task) => {
					const protocolTaskId = isNativeText(task.protocolTask.id)
						? task.protocolTask.id
						: task.id;
					const artifacts = artifactSummaries(task);
					const canCancel = ["submitted", "working"].includes(task.state);
					return (
						<div className="flex items-center gap-3 px-3 py-2.5" key={task.id}>
							<div className="min-w-0 flex-1">
								<div className="flex items-center gap-2">
									<p
										className="truncate font-mono text-xs"
										title={protocolTaskId}
									>
										{protocolTaskId}
									</p>
									<Badge variant="outline">{task.state}</Badge>
								</div>
								<p className="text-muted-foreground text-xs">
									{task.direction} · {artifacts.length} artifact
									{artifacts.length === 1 ? "" : "s"}
								</p>
								{artifacts.length > 0 ? (
									<details className="mt-1 text-xs">
										<summary
											aria-label={`View artifacts for A2A task ${protocolTaskId}`}
											className="cursor-pointer text-muted-foreground"
										>
											View artifacts
										</summary>
										<ul className="mt-1 space-y-0.5 pl-4">
											{artifacts.map((artifact) => (
												<li key={artifact.id}>
													{artifact.name} · <code>{artifact.id}</code>
												</li>
											))}
										</ul>
									</details>
								) : null}
							</div>
							<Button
								aria-label={`Cancel A2A task ${protocolTaskId}`}
								disabled={!canCancel || cancel.isPending}
								onClick={() => cancel.mutate(task.id)}
								size="sm"
								variant="ghost"
							>
								Cancel
							</Button>
						</div>
					);
				})}
			</div>
		</SectionCard>
	);
}
