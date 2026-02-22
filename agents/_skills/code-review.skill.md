---
name: code-review
description: Perform a thorough code review
tags: [coding, review, quality]
---

# Code Review Skill

When reviewing code, follow this structured approach:

## Checklist
1. **Correctness**: Does the code do what it's supposed to?
2. **Edge Cases**: Are boundary conditions handled?
3. **Security**: Any injection, XSS, or auth issues?
4. **Performance**: Any obvious N+1 queries, unnecessary loops?
5. **Readability**: Clear naming, reasonable complexity?
6. **Tests**: Are critical paths tested?

## Output Format
Provide feedback in these categories:
- **Critical**: Must fix before merge
- **Important**: Should fix, but not blocking
- **Suggestion**: Nice to have improvements
- **Praise**: What's done well (always include at least one)
