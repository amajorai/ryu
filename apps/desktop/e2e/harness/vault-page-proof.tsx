// Renders the Vault page against canned `/api/vault/*` responses so the page
// can be screenshotted without a running Core.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import type {
	VaultSecret,
	VaultSecretMetadata,
	VaultSecretMetadataPatch,
} from "../../src/lib/api/vault.ts";
import VaultPage from "../../src/pages/VaultPage.tsx";
import { useNodeStore } from "../../src/store/useNodeStore.ts";
import proofStyles from "./vault-page-proof.module.css";
import "../../src/index.css";

const CAPS_ALL = [
	"list",
	"use",
	"read",
	"write",
	"delete",
	"admin",
	"approve",
] satisfies VaultSecret["capabilities"];
type VaultProofSecret = Omit<VaultSecret, "deletedAt">;
const metadata = (
	over: VaultSecretMetadataPatch = {}
): VaultSecretMetadata => ({
	description: "",
	tags: [],
	expiresAt: null,
	rotationPeriodSecs: null,
	generator: null,
	expandReferences: false,
	maxVersions: 20,
	...over,
});
const secret = (
	over: Partial<VaultProofSecret> & Pick<VaultSecret, "name">
): VaultProofSecret => ({
	scope: "user",
	scopeId: "local",
	environment: "production",
	path: "/",
	version: 1,
	status: "active",
	metadata: metadata(),
	capabilities: CAPS_ALL,
	createdAt: "2026-09-01T09:00:00Z",
	createdBy: "operator",
	updatedAt: "2026-10-04T16:20:00Z",
	updatedBy: "operator",
	rotatedAt: "2026-10-04T16:20:00Z",
	...over,
});

const SECRETS = [
	secret({
		name: "GITHUB_TOKEN",
		version: 4,
		binding: { kind: "mcp", id: "github" },
	}),
	secret({
		name: "STRIPE_SECRET_KEY",
		path: "/payments",
		version: 2,
		status: "rotation_due",
		metadata: metadata({
			rotationPeriodSecs: 2_592_000,
			description: "Live key",
		}),
	}),
	secret({
		name: "SENDGRID_API_KEY",
		path: "/email",
		scope: "node",
		scopeId: "node-1",
		status: "expired",
		metadata: metadata({ expiresAt: "2026-10-01T00:00:00Z" }),
	}),
	secret({
		name: "OPENAI_API_KEY",
		scope: "org",
		scopeId: "org-1",
		source: "control-plane",
		version: 7,
		capabilities: ["list", "use"],
	}),
];

const json = <FixturePayload,>(body: FixturePayload, status = 200) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});

window.fetch = Object.assign(
	async (input: Parameters<typeof window.fetch>[0]) => {
		const url = new URL(String(input instanceof Request ? input.url : input));
		const path = url.pathname;
		if (path === "/api/vault/secrets") {
			return json({
				secrets: SECRETS,
				node: {
					id: "node-1",
					scope: "local",
					orgId: null,
					teamId: null,
					ownerUserId: null,
				},
				caller: null,
				canManageShared: false,
				sharedRemote: true,
				sharedError: null,
				activeEnvironment: "production",
				seal: {
					mode: "shamir",
					sealed: false,
					shares: 5,
					threshold: 3,
					progress: 0,
					keyVersions: [1, 2],
					activeKeyVersion: 2,
				},
			});
		}
		if (path.endsWith("/versions")) {
			return json({
				versions: [
					{
						version: 2,
						createdAt: "2026-10-04T16:20:00Z",
						createdBy: "operator",
						source: "write",
						destroyed: false,
						current: true,
					},
					{
						version: 1,
						createdAt: "2026-09-01T09:00:00Z",
						createdBy: "operator",
						source: "import",
						destroyed: false,
						current: false,
					},
				],
			});
		}
		if (path === "/api/vault/environments") {
			return json({
				active: "production",
				environments: [
					{
						slug: "development",
						name: "development",
						protected: false,
						requiredApprovals: 1,
						position: 0,
					},
					{
						slug: "production",
						name: "production",
						protected: true,
						requiredApprovals: 2,
						position: 1,
					},
				],
			});
		}
		if (path === "/api/vault/folders") {
			return json({ folders: ["/payments", "/payments/eu", "/email"] });
		}
		if (path === "/api/vault/change-requests") {
			return json({
				changeRequests: [
					{
						id: "vcr_1",
						status: "pending",
						operation: "write",
						coords: {
							scope: "node",
							scopeId: "node-1",
							environment: "production",
							path: "/payments",
							name: "STRIPE_SECRET_KEY",
						},
						hasValue: true,
						patch: {},
						requestedBy: "user:dana",
						requestedAt: "2026-10-05T08:12:00Z",
						approvals: [{ by: "user:lee", at: 1_759_652_000_000 }],
						requiredApprovals: 2,
						decidedBy: null,
						decidedAt: null,
						reason: null,
					},
				],
			});
		}
		return json({ error: "not mocked" }, 404);
	},
	window.fetch
);

const node = { name: "Vault proof", url: window.location.origin, token: null };
useNodeStore.setState({
	nodes: [node],
	defaultNode: node.name,
	getActiveNode: () => node,
});

const queryClient = new QueryClient({
	defaultOptions: { queries: { retry: false } },
});
const root = document.getElementById("root");
if (root) {
	createRoot(root).render(
		<QueryClientProvider client={queryClient}>
			<div className={proofStyles.fixture1}>
				<VaultPage />
			</div>
		</QueryClientProvider>
	);
}
