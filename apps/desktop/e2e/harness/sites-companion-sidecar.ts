import { join } from "node:path";
import {
	createSitesServer,
	type SitesServices,
} from "../../../../apps-store/sites/sidecar/src/server.ts";
import { SitesStore } from "../../../../apps-store/sites/sidecar/src/store.ts";
import { visitorScript } from "../../../../apps-store/sites/sidecar/src/visitor-bundle.ts";

interface SitesProofOptions {
	agentAvailable: boolean;
	answersAvailable: boolean;
	approvedSpaceId: string;
	edgeAvailable: boolean;
	identityAvailable: boolean;
	publicEnabled: boolean;
	retrievalAvailable: boolean;
	scannerAvailable: boolean;
	scannerMode: "pass" | "unavailable";
}

interface SitesProofObservations {
	answerCalls: Array<{ query: string; siteId: string; spaceId: string }>;
	resetActionCalls: Array<{
		ownerId: string;
		provider: string;
		siteId: string;
	}>;
	retrievalCalls: Array<{ query: string; siteId: string; spaceId: string }>;
	scanCalls: Array<{ digest: string; html: string; versionId?: string }>;
}

const ownerId = "sites-proof-owner";
const owner = {
	email: "owner@example.test",
	id: ownerId,
	workspaceIds: ["workspace-sites-proof"],
};
function requiredEnvironment(name: string, value: string | undefined): string {
	if (!value) {
		throw new Error(`Sites proof sidecar requires ${name}.`);
	}
	return value;
}

const directory = requiredEnvironment("RYU_DIR", process.env.RYU_DIR);
const token = requiredEnvironment(
	"RYU_SITES_TOKEN",
	process.env.RYU_SITES_TOKEN
);
const optionsPath = requiredEnvironment(
	"RYU_SITES_PROOF_OPTIONS_FILE",
	process.env.RYU_SITES_PROOF_OPTIONS_FILE
);
const observationsPath = requiredEnvironment(
	"RYU_SITES_PROOF_OBSERVATIONS_FILE",
	process.env.RYU_SITES_PROOF_OBSERVATIONS_FILE
);
const adminPort = Number(
	requiredEnvironment("RYU_SITES_PORT", process.env.RYU_SITES_PORT)
);
const visitorPort = Number(
	requiredEnvironment(
		"RYU_SITES_VISITOR_PORT",
		process.env.RYU_SITES_VISITOR_PORT
	)
);

async function readOptions(): Promise<SitesProofOptions> {
	return await Bun.file(optionsPath).json();
}

async function updateObservations<T extends keyof SitesProofObservations>(
	key: T,
	value: SitesProofObservations[T][number]
): Promise<void> {
	const observations = await Bun.file(observationsPath).json();
	observations[key].push(value);
	await Bun.write(observationsPath, JSON.stringify(observations));
}

const options = await readOptions();
const services: SitesServices = {
	managementIdentity: async () => owner,
	...(options.identityAvailable
		? {
				identity: async (request: Request) => {
					const cookies = request.headers.get("cookie") ?? "";
					return cookies
						.split(";")
						.some((cookie) => cookie.trim() === "sites-proof-owner=1")
						? owner
						: null;
				},
			}
		: undefined),
	...(options.edgeAvailable
		? {
				// An operator edge is configured, so custom domains can be added, but
				// this fixture never confirms a TLS binding: domains stay pending.
				domainReady: async () => false,
			}
		: undefined),
	...(options.retrievalAvailable
		? {
				canBindSpace: (_siteId: string, spaceId: string) =>
					spaceId === options.approvedSpaceId,
				retrieve: async (siteId: string, spaceId: string, query: string) => {
					await updateObservations("retrievalCalls", {
						query,
						siteId,
						spaceId,
					});
					return [
						{
							id: "approved-space-guide",
							text: `Approved Space result for ${query}.`,
							title: "Approved guide",
						},
					];
				},
			}
		: undefined),
	...(options.answersAvailable
		? {
				answer: async (siteId: string, spaceId: string, query: string) => {
					await updateObservations("answerCalls", { query, siteId, spaceId });
					return {
						text: `Fixture answer grounded in the approved Space for ${query}.`,
						sources: [{ id: "approved-space-guide" }],
					};
				},
			}
		: undefined),
	...(options.agentAvailable
		? {
				runResetAction: async (input: {
					ownerId: string;
					provider: "codex" | "claude" | "copilot";
					siteId: string;
				}) => {
					await updateObservations("resetActionCalls", input);
					return {
						detail: "Loopback reset-action fixture completed.",
						provider: input.provider,
						status: "completed" as const,
					};
				},
			}
		: undefined),
	...(options.scannerAvailable
		? {
				scanArtifact: async (html: string) => {
					const current = await readOptions();
					await updateObservations("scanCalls", {
						digest: new Bun.CryptoHasher("sha256").update(html).digest("hex"),
						html,
					});
					if (current.scannerMode === "unavailable") {
						throw new Error("Loopback scanner fixture is unavailable.");
					}
					return {
						allowed: !html.includes("PROOF_SECRET"),
						reason: html.includes("PROOF_SECRET")
							? "Fixture secret pattern detected."
							: null,
					};
				},
			}
		: undefined),
};

const store = new SitesStore(join(directory, "sites", "sites.sqlite"));
const server = createSitesServer({
	baseDomain: "localhost",
	ownerId,
	port: adminPort,
	publicEnabled: options.publicEnabled,
	services,
	store,
	token,
	visitorPort,
	visitorScript,
});

function stop(): void {
	server.stop();
	store.close();
}

process.once("SIGINT", stop);
process.once("SIGTERM", stop);
