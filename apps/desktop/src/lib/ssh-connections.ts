import { z } from "zod";
export type SshAuthMode = "identity" | "none";

export interface SshConnection {
	auth: SshAuthMode;
	host: string;
	id: string;
	identityFile?: string;
	name: string;
	port: number;
	username: string;
}

export const SSH_CONNECTIONS_STORAGE_KEY = "ryu:ssh-connections";

const sshStoredRecordSchema = z.object({
	name: z.unknown().optional(),
	host: z.unknown().optional(),
	username: z.unknown().optional(),
	id: z.unknown().optional(),
	port: z.unknown().optional(),
	auth: z.unknown().optional(),
	identityFile: z.unknown().optional(),
});
const sshStoredRecordsSchema = z.array(z.unknown());
const sshPortSchema = z.number().int().min(1).max(65_535);
type SshStoredInput = Parameters<typeof sshStoredRecordSchema.parse>[0];

function hasControlCharacters(value: string): boolean {
	for (const character of value) {
		const code = character.charCodeAt(0);
		if (code < 32 || code === 127) {
			return true;
		}
	}
	return false;
}

function cleanText(value: SshStoredInput, maxLength: number): string | null {
	const parsed = z.string().safeParse(value);
	if (!parsed.success) {
		return null;
	}
	const text = parsed.data.trim();
	if (!text || text.length > maxLength || hasControlCharacters(text)) {
		return null;
	}
	return text;
}

function safeToken(value: SshStoredInput, maxLength: number): string | null {
	const text = cleanText(value, maxLength);
	return text && /^[A-Za-z0-9._:\-[\]]+$/.test(text) ? text : null;
}

function safeIdentityPath(value: SshStoredInput): string | null {
	return cleanText(value, 4096);
}

/**
 * The username is optional: absent, empty or whitespace-only means the profile
 * has no username (""). Anything else must be a safe token, or the profile is
 * refused.
 */
function optionalUsername(value: SshStoredInput): string | null {
	if (value === undefined) {
		return "";
	}
	const parsed = z.string().safeParse(value);
	if (parsed.success && parsed.data.trim() === "") {
		return "";
	}
	return safeToken(value, 120);
}

function connectionId(): string {
	if (z.function().safeParse(crypto?.randomUUID).success) {
		return crypto.randomUUID();
	}
	return `ssh-${Date.now()}-${Math.round(Math.random() * 1e9)}`;
}

export function normalizeSshConnection(
	raw: SshStoredInput
): SshConnection | null {
	const parsed = sshStoredRecordSchema.safeParse(raw);
	if (!parsed.success) {
		return null;
	}
	const metadata = parsed.data;
	const name = cleanText(metadata.name, 120);
	const host = safeToken(metadata.host, 255);
	const username = optionalUsername(metadata.username);
	const id = safeToken(metadata.id, 120);
	const port = sshPortSchema.safeParse(Number(metadata.port));
	if (!(name && host) || username === null || !port.success) {
		return null;
	}
	const auth: SshAuthMode = metadata.auth === "identity" ? "identity" : "none";
	const identityFile = safeIdentityPath(metadata.identityFile);
	const identity: Pick<SshConnection, "auth" | "host" | "id" | "identityFile"> =
		{
			auth,
			host,
			id: id ?? connectionId(),
		};
	if (identityFile) {
		identity.identityFile = identityFile;
	}
	return { ...identity, name, port: port.data, username };
}

export function loadSshConnections(): SshConnection[] {
	try {
		const raw = localStorage.getItem(SSH_CONNECTIONS_STORAGE_KEY);
		const parsed = sshStoredRecordsSchema.safeParse(raw ? JSON.parse(raw) : []);
		if (!parsed.success) {
			return [];
		}
		const seen = new Set<string>();
		const connections: SshConnection[] = [];
		for (const item of parsed.data) {
			const connection = normalizeSshConnection(item);
			if (connection && !seen.has(connection.id)) {
				seen.add(connection.id);
				connections.push(connection);
			}
		}
		return connections;
	} catch {
		return [];
	}
}

export function saveSshConnections(
	connections: readonly SshConnection[]
): void {
	localStorage.setItem(
		SSH_CONNECTIONS_STORAGE_KEY,
		JSON.stringify(connections)
	);
}
