---
name: review
description: Prepare a file-scoped code review for a read-only Plan Board Dispatch worker in Termina.
---

# Review

Prepare a review assignment for the existing Plan Board Dispatch action.
Use the user's requested scope and concrete project file paths. When given a
whole diff without paths, use Change Review to select files or ask for the
files to review. Do not create repository-wide or directory claims.

Produce a Plan heading with one unchecked task containing the paths and the
`@review` marker, for example:

```markdown
Plan:
- [ ] Review src/auth.ts src/session.ts for session isolation regressions @review
```

Each task can name at most five existing files. Include the requested comparison
or risk in the task text. The user starts it through Dispatch. The worker can
read related files for context, but cannot edit, run commands, browse, use MCP,
or spawn children. Do not replace it with a writable worker.

In the worker, report actionable defects with file and line, the failing
scenario, and supporting evidence. Distinguish observed defects from concerns.
If comparison context or test execution is unavailable, say so. If there are
no findings, state that and the limits of the review. Leave the report in the
worker terminal; the owner chooses fixes and runs Verify. Do not treat the
review report as completion of implementation work.
