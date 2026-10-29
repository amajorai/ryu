import {
	createDefaultWorkbench,
	type WorkbenchState,
} from "@ryu/workbench/model";
import {
	migrateWorkbenchSnapshot,
	parseWorkbenchSnapshot,
	sameWorkbenchSnapshot,
	serializeWorkbenchSnapshot,
	type WorkbenchIds,
} from "@ryu/workbench/persistence";
import {
	type AppRequestValue,
	appRequestValueSchema,
} from "@ryuhq/core-client/app-request-json.ts";
import { z } from "zod";

export const WORKBENCH_STORAGE_KEY = "ryu_workbench_layout_v2";

const LEGACY_SESSION_STORAGE_KEY = "ryu_session_tabs";
const LEGACY_PINNED_DOCK_STORAGE_KEY = "ryu_pinned_dock_tabs";
const LEGACY_SIDEBAR_WIDTH_STORAGE_KEY = "ryu:sidebar-width";

type StartupSource = "default" | "legacy" | "v2";

export interface DesktopWorkbenchStartup {
	source: StartupSource;
	state: WorkbenchState;
}

interface DesktopWorkbenchStartupOptions {
	folder?: string | null;
	ids: WorkbenchIds;
	sidebarOpen?: boolean;
	storage: Storage;
}

export interface DesktopWorkbenchWriter {
	flush: () => void;
	schedule: (state: WorkbenchState) => void;
}

interface StorageRead {
	ok: boolean;
	value: string | null;
}

function readStorage(storage: Storage, key: string): StorageRead {
	try {
		return { ok: true, value: storage.getItem(key) };
	} catch {
		return { ok: false, value: null };
	}
}

function parseJson(raw: string | null): AppRequestValue {
	if (raw === null) {
		return undefined;
	}
	try {
		return appRequestValueSchema.parse(JSON.parse(raw));
	} catch {
		return undefined;
	}
}

interface PreparedLegacySession {
	activeWorkspace: AppRequestValue;
	session: AppRequestValue;
}

const legacySessionRecordFieldsSchema = z.record(
	z.string(),
	appRequestValueSchema
);
const legacySessionRecordSchema = z.custom<
	z.output<typeof legacySessionRecordFieldsSchema>
>((value) => legacySessionRecordFieldsSchema.safeParse(value).success);
const legacySessionProjectionSchema = z.object({
	tabs: z.array(appRequestValueSchema),
	activeIndex: appRequestValueSchema.optional(),
});
const legacyWorkspaceProjectionSchema = z.object({
	workspaceSession: appRequestValueSchema.optional(),
});

function prepareLegacySession(session: AppRequestValue): PreparedLegacySession {
	const record = legacySessionRecordSchema.safeParse(session);
	if (!record.success) {
		return { activeWorkspace: undefined, session };
	}
	const parsed = legacySessionProjectionSchema.safeParse(record.data);
	if (!parsed.success) {
		return { activeWorkspace: undefined, session };
	}
	const row = parsed.data;
	let activeIndex = 0;
	const selectedIndex = z.number().safeParse(row.activeIndex);
	if (row.tabs.length > 0 && selectedIndex.success) {
		activeIndex = Math.min(
			row.tabs.length - 1,
			Math.max(0, Math.trunc(selectedIndex.data))
		);
	}
	const activeTab = legacyWorkspaceProjectionSchema.safeParse(
		row.tabs[activeIndex]
	);
	return {
		activeWorkspace: activeTab.success
			? activeTab.data.workspaceSession
			: undefined,
		session: { ...record.data, activeIndex },
	};
}

function parseSidebarWidth(raw: string | null): number | undefined {
	if (raw === null) {
		return undefined;
	}
	const value = Number(raw);
	return Number.isFinite(value) ? value : undefined;
}

export function writeDesktopWorkbenchSnapshot(
	storage: Storage,
	state: WorkbenchState
): boolean {
	try {
		storage.setItem(
			WORKBENCH_STORAGE_KEY,
			JSON.stringify(serializeWorkbenchSnapshot(state))
		);
		return true;
	} catch {
		return false;
	}
}

/**
 * Read the universal snapshot before the legacy tab provider mounts. A present
 * but invalid v2 value is never replaced from older stores: preserving both
 * values leaves recovery possible instead of silently committing data loss.
 */
export function readDesktopWorkbenchStartup({
	folder,
	ids,
	sidebarOpen,
	storage,
}: DesktopWorkbenchStartupOptions): DesktopWorkbenchStartup {
	const current = readStorage(storage, WORKBENCH_STORAGE_KEY);
	if (!current.ok) {
		return { source: "default", state: createDefaultWorkbench(ids) };
	}
	if (current.value !== null) {
		const parsed = parseWorkbenchSnapshot(parseJson(current.value), ids);
		return parsed
			? { source: "v2", state: parsed }
			: { source: "default", state: createDefaultWorkbench(ids) };
	}

	const sessionRead = readStorage(storage, LEGACY_SESSION_STORAGE_KEY);
	const pinnedRead = readStorage(storage, LEGACY_PINNED_DOCK_STORAGE_KEY);
	const sidebarWidthRead = readStorage(
		storage,
		LEGACY_SIDEBAR_WIDTH_STORAGE_KEY
	);
	if (!(sessionRead.ok && pinnedRead.ok && sidebarWidthRead.ok)) {
		return { source: "default", state: createDefaultWorkbench(ids) };
	}
	const legacySession = prepareLegacySession(parseJson(sessionRead.value));
	const migrated = migrateWorkbenchSnapshot(
		{
			activeWorkspace: legacySession.activeWorkspace,
			folder,
			pinnedByFolder: parseJson(pinnedRead.value),
			session: legacySession.session,
			sidebarOpen,
			sidebarWidth: parseSidebarWidth(sidebarWidthRead.value),
		},
		ids
	);
	const validated = parseWorkbenchSnapshot(
		serializeWorkbenchSnapshot(migrated),
		ids
	);
	if (!validated) {
		return { source: "default", state: createDefaultWorkbench(ids) };
	}

	writeDesktopWorkbenchSnapshot(storage, validated);
	return { source: "legacy", state: validated };
}

export function createDesktopWorkbenchWriter(
	storage: Storage,
	delayMs: number,
	initialState?: WorkbenchState
): DesktopWorkbenchWriter {
	let lastWritten = initialState;
	let pending: WorkbenchState | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;

	const flush = () => {
		if (timer !== undefined) {
			clearTimeout(timer);
			timer = undefined;
		}
		if (!pending) {
			return;
		}
		if (sameWorkbenchSnapshot(lastWritten, pending)) {
			pending = undefined;
			return;
		}
		if (writeDesktopWorkbenchSnapshot(storage, pending)) {
			lastWritten = pending;
			pending = undefined;
		}
	};

	const schedule = (state: WorkbenchState) => {
		if (pending && sameWorkbenchSnapshot(pending, state)) {
			if (timer === undefined) {
				timer = setTimeout(flush, delayMs);
			}
			return;
		}
		if (!pending && sameWorkbenchSnapshot(lastWritten, state)) {
			return;
		}
		pending = state;
		if (timer !== undefined) {
			clearTimeout(timer);
		}
		timer = setTimeout(flush, delayMs);
	};

	return { flush, schedule };
}
