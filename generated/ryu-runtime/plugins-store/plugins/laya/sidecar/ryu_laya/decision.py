"""Pure validation and normalization for Shadow's Laya decision adapter."""

from __future__ import annotations

import math
from typing import Any


def _choice(answer: Any, allowed: set[str]) -> str:
    if not isinstance(answer, dict):
        raise ValueError("planner answer must be an object")
    choice = answer.get("choice")
    probabilities = answer.get("probabilities")
    if (
        not isinstance(choice, str)
        or choice not in allowed
        or not isinstance(probabilities, dict)
        or not probabilities
        or not set(probabilities).issubset(allowed)
    ):
        raise ValueError("planner returned an invalid choice")
    checked: dict[str, float] = {}
    for key, value in probabilities.items():
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ValueError("planner returned an invalid probability")
        probability = float(value)
        if not math.isfinite(probability) or not 0.0 <= probability <= 1.0:
            raise ValueError("planner returned an invalid probability")
        checked[key] = probability
    if abs(sum(checked.values()) - 1.0) >= 0.02 or checked.get(choice, -1.0) < max(checked.values()) - 1e-6:
        raise ValueError("planner probabilities failed validation")
    return choice


def parse_computer_use_result(result: Any, questions: dict[str, Any]) -> dict[str, Any]:
    answers = result.get("answers") if isinstance(result, dict) else None
    operation_question = questions.get("operation")
    operation_criteria = operation_question.get("criteria") if isinstance(operation_question, dict) else None
    if not isinstance(answers, dict) or not isinstance(operation_criteria, dict):
        raise ValueError("planner response is missing its operation answer")
    operation = _choice(answers.get("operation"), set(operation_criteria))
    target = None
    if operation in {"CLICK", "TYPE_TEXT"}:
        target_key = "click_target" if operation == "CLICK" else "type_text_target"
        target_question = questions.get(target_key)
        criteria = target_question.get("criteria") if isinstance(target_question, dict) else None
        if not isinstance(criteria, dict) or not criteria:
            raise ValueError("planner selected a target action with no candidates")
        target = _choice(answers.get(target_key), set(criteria))
    return {"operation": operation, "target": target}
