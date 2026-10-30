/** A sidecar row as the view needs it — the container resolves install state. */
export interface ServiceRow {
	deprecated?: boolean;
	description?: string | null;
	displayName: string;
	installedVersion?: string | null;
	installState: "installed" | "installing" | "failed" | "available" | string;
	latestVersion?: string | null;
	name: string;
	/** Action label currently in flight for this row (install/start/stop/restart). */
	pending?: string | null;
	running: boolean;
}

export interface DependencyRow {
	installed: boolean;
	name: string;
}

export interface SandboxView {
	available: boolean;
	docker?: { available: boolean; reason?: string | null } | null;
	enabled: boolean;
}

export interface ServicesViewProps {
	agents?: ServiceRow[];
	bulkPending?: "start" | "stop" | "deps" | null;
	dependencies?: DependencyRow[];
	error?: string | null;
	gatewayPending?: "start" | "stop" | null;
	gatewayRunning?: boolean | null;
	loading?: boolean;
	onGatewayStart?: () => void;
	onGatewayStop?: () => void;
	onInstall?: (name: string) => void;
	onInstallMissing?: () => void;
	onRestart?: (name: string) => void;
	onStart?: (name: string) => void;
	onStartAll?: () => void;
	onStop?: (name: string) => void;
	onStopAll?: () => void;
	onToggleSandbox?: () => void;
	sandbox?: SandboxView | null;
	sandboxPending?: boolean;
	tools?: ServiceRow[];
}
