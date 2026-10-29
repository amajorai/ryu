import { createContext, useContext } from "react";
import type {
	ConnectAppInfo,
	ConnectAppRequest,
	ConsentPluginCandidate,
	PluginInstallRequest,
} from "./tools/consent-tool.ts";

/** One connection access ceiling the user can pick before signing in. */
export interface ConsentAccessOption {
	description: string;
	id: string;
	label: string;
}

/**
 * What a consent card needs from the shell to act on the user's choice.
 * `packages/blocks` draws the cards; the desktop owns the node target, the
 * catalog, the install routes and the OAuth flows.
 *
 * Every call runs only from a user click. The agent never reaches these.
 */
export interface ConsentActions {
	/** Access ceilings offered before sign-in, the Connections page's choices.
	 *  The first entry is the recommended default. */
	accessOptions: readonly ConsentAccessOption[];
	/**
	 * Start the connection with the chosen access ceiling and resolve once it
	 * is active. The host opens the provider's sign-in page in the user's
	 * browser and waits for the flow to finish. Rejects on failure, timeout or
	 * when `signal` aborts (the user cancelled).
	 */
	connectApp(
		request: ConnectAppRequest,
		accessLevel: string,
		signal: AbortSignal
	): Promise<void>;
	/** Resolve the app's display name, logo and whether it is already connected. */
	describeApp(request: ConnectAppRequest): Promise<ConnectAppInfo>;
	/** Catalog candidates for the request, unranked. The card ranks them.
	 *  Rejects when the catalog or the installed state can't be read. */
	findPlugins(request: PluginInstallRequest): Promise<ConsentPluginCandidate[]>;
	/** Install one candidate through the normal, signature-checked install
	 *  path. Resolves with whether the plugin is turned on afterwards; a fresh
	 *  install is usually off until the user approves its permissions. */
	installPlugin(
		candidate: ConsentPluginCandidate
	): Promise<{ enabled: boolean }>;
	/** Re-read whether an installed candidate is turned on. */
	isPluginEnabled(candidate: ConsentPluginCandidate): Promise<boolean>;
	/**
	 * Identity of the node these actions talk to. Cards reload when it changes,
	 * so the user never approves one node's listing and acts on another node.
	 */
	nodeKey: string;
	/** Open the listing where the user can review it (store detail or repository). */
	openPluginListing(candidate: ConsentPluginCandidate): void;
}

export interface ConsentHostValue {
	/**
	 * Hook that returns the actions for the surrounding chat. A hook, not a
	 * value, so the host can resolve per-tab state (the active node) where the
	 * card renders, while the provider itself mounts once at the app root.
	 * Must be the same function for the provider's whole lifetime.
	 */
	useActions: () => ConsentActions;
}

const ConsentHostContext = createContext<ConsentHostValue | null>(null);

export { ConsentHostContext };

/** Read the injected consent host, or `null` when none is mounted. Consent
 *  parts then render a read-only card explaining where to finish the step. */
export function useConsentHost(): ConsentHostValue | null {
	return useContext(ConsentHostContext);
}
