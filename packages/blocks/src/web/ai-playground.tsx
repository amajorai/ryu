"use client";

import { Button } from "@ryu/ui/components/button";
import { Input } from "@ryu/ui/components/input";
import { Send } from "lucide-react";
import type { ChangeEvent, FormEvent, ReactNode, RefObject } from "react";

export interface AiPlaygroundMessagePart {
	text?: string;
	type: string;
}

export interface AiPlaygroundMessage {
	id: string;
	parts?: AiPlaygroundMessagePart[];
	role: "user" | "assistant" | string;
}

export interface AiPlaygroundProps {
	/** Current composer value. */
	input?: string;
	/** The conversation so far. */
	messages?: AiPlaygroundMessage[];
	/** Scroll anchor ref the live page uses to keep the latest reply in view. */
	messagesEndRef?: RefObject<HTMLDivElement | null>;
	/** Composer change handler. */
	onInputChange?: (e: ChangeEvent<HTMLInputElement>) => void;
	/** Submit handler. */
	onSubmit?: (e: FormEvent<HTMLFormElement>) => void;
	/**
	 * Renderer for a text part. The live page renders Streamdown here; the
	 * storyboard passes a plain text renderer.
	 */
	renderText?: (text: string, isAnimating: boolean) => ReactNode;
	/** useChat-style status; `streaming` animates the assistant reply. */
	status?: string;
}

const noop = () => {
	// presentational default; the live app injects real handlers
};

const defaultRenderText = (text: string) => text;

/**
 * Presentational AI playground shell. Live pages own transport + markdown
 * rendering; storyboard can pass static messages.
 */
export default function AiPlayground({
	messages = [],
	input = "",
	status,
	onInputChange = noop,
	onSubmit = noop,
	messagesEndRef,
	renderText = defaultRenderText,
}: AiPlaygroundProps) {
	return (
		<div className="mx-auto grid w-full grid-rows-[auto_1fr_auto] overflow-hidden p-4">
			<div className="mb-3 rounded-lg border border-muted-foreground/30 border-dashed bg-muted/30 px-3 py-2 text-muted-foreground text-xs">
				Playground shell for lightweight chat demos. Production chat runs
				through Ryu Core (<code>/api/chat/stream</code>) with agents, tools, and
				memory.
			</div>
			<div className="space-y-4 overflow-y-auto pb-4">
				{messages.length === 0 ? (
					<div className="mt-8 text-center text-muted-foreground">
						Ask me anything to get started!
					</div>
				) : (
					messages.map((message) => (
						<div
							className={`rounded-lg p-3 ${
								message.role === "user"
									? "ml-8 bg-primary/10"
									: "mr-8 bg-secondary/20"
							}`}
							key={message.id}
						>
							<p className="mb-1 font-semibold text-sm">
								{message.role === "user" ? "You" : "AI Assistant"}
							</p>
							{message.parts?.map((part) => {
								if (part.type === "text") {
									const partKey = `${message.id}-${part.type}-${part.text ?? ""}`;
									return (
										<div key={partKey}>
											{renderText(
												part.text ?? "",
												status === "streaming" && message.role === "assistant"
											)}
										</div>
									);
								}
								return null;
							})}
						</div>
					))
				)}
				<div ref={messagesEndRef} />
			</div>

			<form
				className="flex w-full items-center space-x-2 border-t pt-2"
				onSubmit={onSubmit}
			>
				<Input
					autoComplete="off"
					className="flex-1"
					name="prompt"
					onChange={onInputChange}
					placeholder="Type your message..."
					value={input}
				/>
				<Button size="icon" type="submit">
					<Send size={18} />
				</Button>
			</form>
		</div>
	);
}
