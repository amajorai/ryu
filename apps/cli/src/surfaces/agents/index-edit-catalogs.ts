import type { ApiTarget } from "@ryuhq/core-client/client";
import type { McpTool } from "@ryuhq/core-client/mcp";
import {
	type Dispatch,
	type SetStateAction,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import {
	type AgentSkillOption,
	encodeSkillSelection,
	encodeToolSelection,
	fetchAgentSkills,
	fetchAgentTools,
	selectedSkillIds,
	selectedToolIds,
	skillPickerRows,
	toolPickerRows,
} from "./capabilities.ts";
import { emptyCatalog, errText, type PickerCatalog } from "./index-shared.tsx";

/** The tool and skill catalogs behind the agent editor's capability pickers. */
export function useAgentCapabilityCatalogs({
	target,
	url,
	token,
	toolAllowlist,
	setToolAllowlist,
	skillAllowlist,
	setSkillAllowlist,
}: {
	setSkillAllowlist: Dispatch<SetStateAction<string[]>>;
	setToolAllowlist: Dispatch<SetStateAction<string[]>>;
	skillAllowlist: string[];
	target: ApiTarget;
	token: string | null | undefined;
	toolAllowlist: string[];
	url: string;
}) {
	const [toolCatalog, setToolCatalog] =
		useState<PickerCatalog<McpTool>>(emptyCatalog);
	const [skillCatalog, setSkillCatalog] =
		useState<PickerCatalog<AgentSkillOption>>(emptyCatalog);
	const toolsRequestRef = useRef(0);
	const skillsRequestRef = useRef(0);
	const catalogTargetRef = useRef(`${url}\u0000${token ?? ""}`);

	const loadToolCatalog = useCallback(() => {
		const requestId = ++toolsRequestRef.current;
		setToolCatalog((current) => ({
			...current,
			error: null,
			status: "loading",
		}));
		fetchAgentTools(target)
			.then((items) => {
				if (toolsRequestRef.current === requestId) {
					setToolCatalog({ error: null, items, status: "ready" });
				}
			})
			.catch((err) => {
				if (toolsRequestRef.current === requestId) {
					setToolCatalog((current) => ({
						...current,
						error: errText(err),
						status: "error",
					}));
				}
			});
	}, [target]);

	const loadSkillCatalog = useCallback(() => {
		const requestId = ++skillsRequestRef.current;
		setSkillCatalog((current) => ({
			...current,
			error: null,
			status: "loading",
		}));
		fetchAgentSkills(target)
			.then((items) => {
				if (skillsRequestRef.current === requestId) {
					setSkillCatalog({ error: null, items, status: "ready" });
				}
			})
			.catch((err) => {
				if (skillsRequestRef.current === requestId) {
					setSkillCatalog((current) => ({
						...current,
						error: errText(err),
						status: "error",
					}));
				}
			});
	}, [target]);

	useEffect(() => {
		const nextTarget = `${url}\u0000${token ?? ""}`;
		if (catalogTargetRef.current === nextTarget) {
			return;
		}
		catalogTargetRef.current = nextTarget;
		toolsRequestRef.current += 1;
		skillsRequestRef.current += 1;
		setToolCatalog(emptyCatalog());
		setSkillCatalog(emptyCatalog());
	}, [url, token]);

	const toolRows = useMemo(
		() => toolPickerRows(toolAllowlist, toolCatalog.items),
		[toolAllowlist, toolCatalog.items]
	);
	const skillRows = useMemo(
		() => skillPickerRows(skillAllowlist, skillCatalog.items),
		[skillAllowlist, skillCatalog.items]
	);
	const selectedTools = useMemo(
		() => selectedToolIds(toolAllowlist, toolCatalog.items),
		[toolAllowlist, toolCatalog.items]
	);
	const selectedSkills = useMemo(
		() => selectedSkillIds(skillAllowlist, skillCatalog.items),
		[skillAllowlist, skillCatalog.items]
	);

	const toggleTool = useCallback(
		(id: string) => {
			const next = new Set(selectedToolIds(toolAllowlist, toolCatalog.items));
			if (next.has(id)) {
				next.delete(id);
			} else {
				next.add(id);
			}
			setToolAllowlist(encodeToolSelection(next, toolCatalog.items));
		},
		[toolAllowlist, toolCatalog.items]
	);
	const toggleSkill = useCallback(
		(id: string) => {
			const next = new Set(
				selectedSkillIds(skillAllowlist, skillCatalog.items)
			);
			if (next.has(id)) {
				next.delete(id);
			} else {
				next.add(id);
			}
			setSkillAllowlist(encodeSkillSelection(next, skillCatalog.items));
		},
		[skillAllowlist, skillCatalog.items]
	);

	return {
		loadSkillCatalog,
		loadToolCatalog,
		selectedSkills,
		selectedTools,
		skillCatalog,
		skillRows,
		toggleSkill,
		toggleTool,
		toolCatalog,
		toolRows,
	};
}
