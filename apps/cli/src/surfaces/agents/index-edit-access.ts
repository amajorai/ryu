import type { KeyEvent } from "@opentui/core";
import type { Agent, AgentIdentityMode } from "@ryuhq/core-client/agents";
import { appResponseValueSchema } from "@ryuhq/core-client/app-request-json";
import { type ApiTarget, request } from "@ryuhq/core-client/client";
import {
	type Dispatch,
	type SetStateAction,
	useCallback,
	useMemo,
	useRef,
	useState,
} from "react";
import {
	type AccountCatalogCore,
	type AvailableAccounts,
	accountCatalogLoadFailed,
	accountLimitStartBlocked,
	accountPickerRows,
	loadAvailableAccounts,
	toggleAccountAccess,
} from "../../core/agentAccountCatalog.ts";
import {
	ACCOUNT_KEY_FORMATS,
	addAccountKeys,
	parseAccountKey,
	removeAccountKeys,
} from "../../core/agentIdentity.ts";
import { tf } from "../../i18n/translate.ts";

/** The account-access panel state and keys of the agent editor. */
export function useAgentAccessPanel({
	target,
	isNew,
	agentId,
	engine,
	identityMode,
	existing,
	accountAccess,
	setAccountAccess,
	setAccountAccessTouched,
}: {
	accountAccess: string[] | null;
	agentId: string;
	engine: string;
	existing: Agent | null;
	identityMode: AgentIdentityMode;
	isNew: boolean;
	setAccountAccess: Dispatch<SetStateAction<string[] | null>>;
	setAccountAccessTouched: Dispatch<SetStateAction<boolean>>;
	target: ApiTarget;
}) {
	const [accessPanelOpen, setAccessPanelOpen] = useState(false);
	const [accessIndex, setAccessIndex] = useState(0);
	const [accessAdding, setAccessAdding] = useState(false);
	const [accessAddText, setAccessAddText] = useState("");
	const [accessError, setAccessError] = useState<string | null>(null);
	// The accounts the panel lists; `null` while they load.
	const [accessAccounts, setAccessAccounts] =
		useState<AvailableAccounts | null>(null);
	const accessRequestRef = useRef(0);

	const loadAccessAccounts = useCallback(() => {
		const requestId = ++accessRequestRef.current;
		setAccessAccounts(null);
		const core: AccountCatalogCore = {
			get: (path) => request(target, path, {}, appResponseValueSchema),
			post: (path, body) =>
				request(target, path, { method: "POST", body }, appResponseValueSchema),
		};
		loadAvailableAccounts(core, {
			agentId: isNew ? null : agentId,
			engine: engine.trim() || null,
			identityMode,
			savedIdentityMode: existing?.identityMode ?? null,
		})
			.catch((error: unknown) => accountCatalogLoadFailed(error))
			.then((accounts) => {
				if (requestId === accessRequestRef.current) {
					setAccessAccounts(accounts);
				}
			});
	}, [target, isNew, agentId, engine, identityMode, existing]);

	// Every listed account, then the keys allowed now or when loaded that the
	// list does not show, so unticking one never makes it disappear.
	const accessRows = useMemo(() => {
		const saved = existing?.accountAccess ?? null;
		const kept =
			saved === null && accountAccess === null
				? null
				: [...new Set([...(saved ?? []), ...(accountAccess ?? [])])];
		return accountPickerRows(
			accessAccounts ?? { hiddenGroups: [], sections: [] },
			kept
		);
	}, [accessAccounts, accountAccess, existing]);

	const addAccessKey = useCallback(() => {
		const key = parseAccountKey(accessAddText);
		if (key === null) {
			setAccessError(
				tf("Not an account key Core accepts. Keys look like: {formats}", {
					formats: ACCOUNT_KEY_FORMATS.map(
						(format) => format.split("  ")[0]
					).join(", "),
				})
			);
			return;
		}
		// Adding to "no limit" starts a limited list with only this key.
		const next = addAccountKeys(accountAccess, [key]);
		setAccountAccess(next);
		setAccountAccessTouched(true);
		const listed = accessRows.findIndex((row) => row.key === key);
		setAccessIndex(listed === -1 ? accessRows.length : listed);
		setAccessAddText("");
		setAccessAdding(false);
		setAccessError(null);
	}, [accessAddText, accountAccess, accessRows]);

	// Returns true when the key was handled by the account-access panel.
	const handleAccessPanelKey = (key: KeyEvent): boolean => {
		if (!accessPanelOpen) {
			return false;
		}
		if (accessAdding) {
			if (key.name === "escape") {
				setAccessAdding(false);
				setAccessAddText("");
				setAccessError(null);
			} else if (key.name === "return") {
				addAccessKey();
			}
			return true;
		}
		const selected = accessRows[accessIndex];
		if (key.name === "escape") {
			setAccessPanelOpen(false);
			setAccessError(null);
		} else if (key.name === "up" || key.name === "k") {
			setAccessIndex((i) => Math.max(0, i - 1));
		} else if (key.name === "down" || key.name === "j") {
			setAccessIndex((i) =>
				Math.min(Math.max(0, accessRows.length - 1), i + 1)
			);
		} else if (key.name === "r") {
			setAccessError(null);
			loadAccessAccounts();
		} else if (existing?.locked) {
			// A locked agent's access is shown, never changed.
		} else if (key.name === "a") {
			setAccessAdding(true);
			setAccessAddText("");
			setAccessError(null);
		} else if (
			key.name === "space" ||
			key.name === " " ||
			key.name === "return"
		) {
			// Under no limit, the first toggle starts a limit from every listed
			// account, so wait until they have loaded: otherwise it would leave
			// out accounts still loading.
			const blocked =
				accountAccess === null && accessAccounts !== null
					? accountLimitStartBlocked(accessAccounts)
					: null;
			if (blocked) {
				setAccessError(blocked);
			} else if (
				selected &&
				!(accountAccess === null && accessAccounts === null)
			) {
				setAccountAccess(
					toggleAccountAccess(
						accountAccess,
						accessAccounts ?? { hiddenGroups: [], sections: [] },
						selected.key
					)
				);
				setAccountAccessTouched(true);
				setAccessError(null);
			}
		} else if (
			(key.name === "x" || key.name === "delete" || key.name === "d") &&
			accountAccess !== null
		) {
			if (selected && accountAccess.includes(selected.key)) {
				setAccountAccess(removeAccountKeys(accountAccess, [selected.key]));
				setAccountAccessTouched(true);
			}
		} else if (key.name === "c") {
			setAccountAccess(null);
			setAccountAccessTouched(true);
			setAccessIndex(0);
		} else if (key.name === "0" && !(key.ctrl || key.meta || key.option)) {
			// Plain 0 only: Alt+0 is the shell's sidebar-focus chord.
			setAccountAccess([]);
			setAccountAccessTouched(true);
			setAccessIndex(0);
		}
		return true;
	};

	return {
		accessAccounts,
		accessAddText,
		accessAdding,
		accessError,
		accessIndex,
		accessPanelOpen,
		accessRows,
		handleAccessPanelKey,
		loadAccessAccounts,
		setAccessAddText,
		setAccessAdding,
		setAccessError,
		setAccessIndex,
		setAccessPanelOpen,
	};
}
