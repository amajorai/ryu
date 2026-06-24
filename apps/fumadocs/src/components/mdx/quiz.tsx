"use client";

import { Check, RotateCcw, X } from "lucide-react";
import { useMemo, useState } from "react";
import { twMerge } from "tailwind-merge";

/**
 * A single multiple-choice question. `answer` is the zero-based index of the
 * correct option. `explain` is shown after the learner answers, regardless of
 * whether they got it right, so the quiz teaches rather than just grades.
 */
export type QuizQuestion = {
  q: string;
  options: string[];
  answer: number;
  explain?: string;
};

/**
 * An interactive knowledge check for Academy lessons. It is a recognition-level
 * complement to the open reflection prompts each lesson already carries, not a
 * replacement for them. Scoring stays soft on purpose: the value is the reveal
 * and the explanation, in keeping with the Academy's "no grading, just be honest
 * with yourself" framing.
 */
export function Quiz({ questions }: { questions: QuizQuestion[] }) {
  // Per-question selected option index, or null when unanswered.
  const [picked, setPicked] = useState<(number | null)[]>(() =>
    questions.map(() => null),
  );

  const answeredCount = picked.filter((p) => p !== null).length;
  const allAnswered = answeredCount === questions.length;
  const correctCount = useMemo(
    () =>
      picked.reduce<number>(
        (sum, p, i) => sum + (p === questions[i].answer ? 1 : 0),
        0,
      ),
    [picked, questions],
  );

  const reset = () => setPicked(questions.map(() => null));

  return (
    <section
      aria-label="Knowledge check quiz"
      className="not-prose my-6 rounded-xl bg-fd-secondary p-4 sm:p-5"
    >
      <div className="mb-4 flex items-center justify-between gap-3">
        <h4 className="m-0 font-medium text-fd-card-foreground text-sm">
          Check yourself
        </h4>
        <span className="text-fd-muted-foreground text-xs tabular-nums">
          {answeredCount} / {questions.length} answered
        </span>
      </div>

      <ol className="m-0 list-none space-y-5 p-0">
        {questions.map((question, qi) => {
          const selected = picked[qi];
          const isAnswered = selected !== null;
          return (
            <li className="m-0" key={question.q}>
              <fieldset className="m-0 border-0 p-0">
                <legend className="mb-2 font-medium text-fd-card-foreground text-sm">
                  {qi + 1}. {question.q}
                </legend>
                <div className="flex flex-col gap-2">
                  {question.options.map((option, oi) => {
                    const isCorrect = oi === question.answer;
                    const isPicked = selected === oi;
                    return (
                      <button
                        aria-pressed={isPicked}
                        className={twMerge(
                          "flex items-center gap-2.5 rounded-lg bg-fd-background px-3 py-2 text-left text-sm transition-colors",
                          !isAnswered && "hover:bg-fd-accent",
                          isAnswered &&
                            isCorrect &&
                            "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
                          isAnswered &&
                            isPicked &&
                            !isCorrect &&
                            "bg-red-500/10 text-red-700 dark:text-red-300",
                          isAnswered &&
                            !(isCorrect || isPicked) &&
                            "opacity-60",
                        )}
                        disabled={isAnswered}
                        key={option}
                        onClick={() =>
                          setPicked((prev) => {
                            const next = [...prev];
                            next[qi] = oi;
                            return next;
                          })
                        }
                        type="button"
                      >
                        <span
                          aria-hidden="true"
                          className="flex size-4 shrink-0 items-center justify-center"
                        >
                          {isAnswered && isCorrect && (
                            <Check className="size-4" />
                          )}
                          {isAnswered && isPicked && !isCorrect && (
                            <X className="size-4" />
                          )}
                        </span>
                        <span>{option}</span>
                      </button>
                    );
                  })}
                </div>
                {isAnswered && question.explain && (
                  <p className="mt-2 mb-0 rounded-lg bg-fd-background px-3 py-2 text-fd-muted-foreground text-sm">
                    {question.explain}
                  </p>
                )}
              </fieldset>
            </li>
          );
        })}
      </ol>

      {allAnswered && (
        <div className="mt-5 flex items-center justify-between gap-3 pt-4">
          <p className="m-0 text-fd-card-foreground text-sm">
            You got{" "}
            <span className="font-medium tabular-nums">
              {correctCount} of {questions.length}
            </span>
            . Re-read anything you missed before moving on.
          </p>
          <button
            className="inline-flex items-center gap-1.5 rounded-lg bg-fd-background px-3 py-1.5 text-fd-muted-foreground text-xs transition-colors hover:bg-fd-accent"
            onClick={reset}
            type="button"
          >
            <RotateCcw className="size-3.5" />
            Try again
          </button>
        </div>
      )}
    </section>
  );
}
