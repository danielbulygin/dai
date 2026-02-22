import type { Skill } from "./loader.js";

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Validate that a skill has all required fields and correct types.
 */
export function validateSkill(skill: Skill): ValidationResult {
  const errors: string[] = [];

  // Required fields
  if (!skill.name || typeof skill.name !== "string") {
    errors.push("Skill must have a non-empty 'name' string.");
  }

  if (!skill.description || typeof skill.description !== "string") {
    errors.push("Skill must have a non-empty 'description' string.");
  }

  if (!skill.content || typeof skill.content !== "string") {
    errors.push("Skill must have non-empty 'content'.");
  }

  // Tags validation
  if (!Array.isArray(skill.tags)) {
    errors.push("Skill 'tags' must be an array.");
  } else {
    for (let i = 0; i < skill.tags.length; i++) {
      if (typeof skill.tags[i] !== "string") {
        errors.push(`Tag at index ${i} must be a string.`);
      }
    }
  }

  // Name format check (kebab-case recommended)
  if (skill.name && /[A-Z\s]/.test(skill.name)) {
    errors.push(
      "Skill name should use kebab-case (no uppercase or spaces).",
    );
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
