/* @jsxImportSource @opentui/react */
import type { Agent } from "@ryuhq/core-client/agents";
import { StatusMessage } from "@/components/ui/status-message.tsx";
import { REMOTE_PEER_IDENTITY_NOTE } from "../../core/agentIdentity.ts";
import { EditField, PickerField, ToggleField } from "./index-fields.tsx";
import {
	type FieldDef,
	type FieldKey,
	PageHeader,
	type Theme,
} from "./index-shared.tsx";

/** The agent editor's field list, shown when no panel or picker is open. */
export function AgentEditForm({
	agentId,
	error,
	existing,
	fieldIndex,
	fields,
	focused,
	isNew,
	name,
	remotePeer,
	samplingSummary,
	saving,
	setterFor,
	theme,
	valueFor,
}: {
	agentId: string;
	error: string | null;
	existing: Agent | null;
	fieldIndex: number;
	fields: FieldDef[];
	focused: boolean;
	isNew: boolean;
	name: string;
	remotePeer: boolean;
	samplingSummary: string;
	saving: boolean;
	setterFor: (k: FieldKey) => (v: string) => void;
	theme: Theme;
	valueFor: (k: FieldKey) => string;
}) {
	return (
		<box flexDirection="column" flexGrow={1}>
			<PageHeader
				hint="Tab fields · arrows edit · Enter toggle/pick · ^S save"
				subtitle={isNew ? "Create a new agent" : (existing?.id ?? agentId)}
				title={isNew ? "New agent" : name.trim() || "Edit agent"}
			/>
			<box flexDirection="column" gap={1} padding={1}>
				{fields.map((field, i) =>
					field.kind === "toggle" ? (
						<ToggleField
							focused={focused && fieldIndex === i}
							key={field.key}
							label={field.label}
							theme={theme}
							value={valueFor(field.key)}
						/>
					) : field.kind === "sampling" ? (
						<PickerField
							action="Enter to edit"
							focused={focused && fieldIndex === i}
							key={field.key}
							label="sampling"
							theme={theme}
							value={samplingSummary}
						/>
					) : field.kind === "identity" || field.kind === "access" ? (
						<PickerField
							action={
								remotePeer
									? "Remote peer"
									: field.kind === "identity"
										? "Enter to change"
										: "Enter to edit"
							}
							focused={focused && fieldIndex === i}
							key={field.key}
							label={field.label}
							theme={theme}
							value={valueFor(field.key)}
						/>
					) : field.kind === "picker" ? (
						<PickerField
							focused={focused && fieldIndex === i}
							key={field.key}
							label={field.label}
							theme={theme}
							value={valueFor(field.key)}
						/>
					) : (
						<EditField
							focused={focused && fieldIndex === i}
							key={field.key}
							label={field.label}
							onChange={setterFor(field.key)}
							placeholder={field.placeholder}
							theme={theme}
							value={valueFor(field.key)}
						/>
					)
				)}
				{remotePeer ? (
					<text fg={theme.colors.mutedForeground}>
						{REMOTE_PEER_IDENTITY_NOTE.description}
					</text>
				) : null}
				{error ? <StatusMessage variant="error">{error}</StatusMessage> : null}
				{saving ? (
					<StatusMessage variant="loading">saving…</StatusMessage>
				) : null}
			</box>
		</box>
	);
}
