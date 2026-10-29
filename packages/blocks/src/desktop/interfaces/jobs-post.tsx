import { Button } from "@ryu/ui/components/button.tsx";
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ryu/ui/components/dialog.tsx";
import {
	Field,
	FieldDescription,
	FieldGroup,
	FieldLabel,
} from "@ryu/ui/components/field.tsx";
import {
	NativeSelect,
	NativeSelectOption,
} from "@ryu/ui/components/native-select.tsx";
import { Textarea } from "@ryu/ui/components/textarea.tsx";
import type { InterfaceAgent } from "@ryuhq/protocol/interfaces";
import {
	type FormEvent,
	type KeyboardEvent,
	type RefObject,
	useId,
	useRef,
	useState,
} from "react";
import { type JobCompany, PERSONAL_COMPANY_ID } from "./jobs-model.ts";

const MAX_DESCRIPTION_LENGTH = 8000;

export interface JobPostInput {
	agentId: string | undefined;
	companyId: string;
	prompt: string;
}

/** The form inside "Post a job": freelancer, company, and the brief. */
function PostJobForm({
	agents,
	companies,
	defaultAgentId,
	defaultCompanyId,
	descriptionRef,
	onSubmit,
}: {
	agents: InterfaceAgent[];
	companies: JobCompany[];
	defaultAgentId: string | undefined;
	defaultCompanyId: string;
	descriptionRef: RefObject<HTMLTextAreaElement | null>;
	onSubmit: (input: JobPostInput) => void;
}) {
	const id = useId();
	const [agentId, setAgentId] = useState(defaultAgentId ?? agents[0]?.id);
	const [companyId, setCompanyId] = useState(defaultCompanyId);
	const [prompt, setPrompt] = useState("");
	const trimmed = prompt.trim();
	// Only send to a freelancer the picker can still show.
	const resolvedAgentId = agents.some((agent) => agent.id === agentId)
		? agentId
		: agents[0]?.id;
	const resolvedCompanyId = companies.some(
		(company) => company.id === companyId
	)
		? companyId
		: PERSONAL_COMPANY_ID;

	const submit = () => {
		if (!trimmed) {
			return;
		}
		onSubmit({
			agentId: resolvedAgentId,
			companyId: resolvedCompanyId,
			prompt: trimmed,
		});
	};
	const onFormSubmit = (event: FormEvent) => {
		event.preventDefault();
		submit();
	};
	const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
		if (
			event.key === "Enter" &&
			(event.metaKey || event.ctrlKey) &&
			!event.nativeEvent.isComposing
		) {
			event.preventDefault();
			submit();
		}
	};

	return (
		<form className="flex flex-col gap-6" onSubmit={onFormSubmit}>
			<FieldGroup className="gap-4">
				<div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
					<Field>
						<FieldLabel htmlFor={`${id}-freelancer`}>Freelancer</FieldLabel>
						<NativeSelect
							disabled={agents.length === 0}
							id={`${id}-freelancer`}
							onChange={(event) => setAgentId(event.target.value)}
							value={resolvedAgentId ?? ""}
						>
							{agents.map((agent) => (
								<NativeSelectOption key={agent.id} value={agent.id}>
									{agent.name}
									{agent.status === "working" ? " (working now)" : ""}
								</NativeSelectOption>
							))}
						</NativeSelect>
					</Field>
					<Field>
						<FieldLabel htmlFor={`${id}-company`}>Company</FieldLabel>
						<NativeSelect
							id={`${id}-company`}
							onChange={(event) => setCompanyId(event.target.value)}
							value={resolvedCompanyId}
						>
							{companies.map((company) => (
								<NativeSelectOption key={company.id} value={company.id}>
									{company.name}
								</NativeSelectOption>
							))}
						</NativeSelect>
					</Field>
				</div>
				<Field>
					<FieldLabel htmlFor={`${id}-brief`}>Job description</FieldLabel>
					<Textarea
						aria-describedby={`${id}-brief-hint`}
						className="min-h-32 resize-none focus-visible:ring-0"
						id={`${id}-brief`}
						maxLength={MAX_DESCRIPTION_LENGTH}
						onChange={(event) => setPrompt(event.target.value)}
						onKeyDown={onKeyDown}
						placeholder="What needs to be done, and what does done look like?"
						ref={descriptionRef}
						value={prompt}
					/>
					<FieldDescription id={`${id}-brief-hint`}>
						Posting sends this as the first message, and the freelancer starts
						right away.
					</FieldDescription>
				</Field>
			</FieldGroup>
			<DialogFooter>
				<DialogClose render={<Button type="button" variant="ghost" />}>
					Cancel
				</DialogClose>
				<Button
					data-testid="jobs-post-submit"
					disabled={!(trimmed && resolvedAgentId)}
					type="submit"
				>
					Post job
				</Button>
			</DialogFooter>
		</form>
	);
}

export interface PostJobDialogProps {
	agents: InterfaceAgent[];
	companies: JobCompany[];
	defaultAgentId: string | undefined;
	defaultCompanyId: string;
	onOpenChange: (open: boolean) => void;
	onSubmit: (input: JobPostInput) => void;
	open: boolean;
}

/** "Post a job": a short brief to a chosen freelancer, filed under a company. */
export function PostJobDialog({
	agents,
	companies,
	defaultAgentId,
	defaultCompanyId,
	onOpenChange,
	onSubmit,
	open,
}: PostJobDialogProps) {
	const descriptionRef = useRef<HTMLTextAreaElement>(null);
	return (
		<Dialog onOpenChange={onOpenChange} open={open}>
			<DialogContent
				className="gap-6 bg-card p-6 text-card-foreground backdrop-blur-none sm:max-w-lg"
				data-testid="jobs-post-dialog"
				initialFocus={descriptionRef}
				// A plain scrim: the shared overlay frosts the app behind it.
				overlayClassName="[-webkit-backdrop-filter:none]! [backdrop-filter:none]!"
			>
				<DialogHeader>
					<DialogTitle className="font-sans font-semibold! text-lg leading-7">
						Post a job
					</DialogTitle>
					<DialogDescription>
						Each job gets its own thread with the freelancer you hire.
					</DialogDescription>
				</DialogHeader>
				{open ? (
					<PostJobForm
						agents={agents}
						companies={companies}
						defaultAgentId={defaultAgentId}
						defaultCompanyId={defaultCompanyId}
						descriptionRef={descriptionRef}
						onSubmit={onSubmit}
					/>
				) : null}
			</DialogContent>
		</Dialog>
	);
}
