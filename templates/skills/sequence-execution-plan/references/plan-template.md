# Proportional plan format

Use the relevant fields; a plan is a decision aid, not a form-completion exercise.

```text
Outcome and acceptance evidence:
User constraints and their sources:
Current facts / technical assumptions:

ID | Result | Owner | Owned/excluded scope | Prerequisites | Verification | State

Now:
Next (and what unlocks it):
Later:
Writer/resource allocation:
Open decisions and blockers:
Replan reason, when applicable:
```

States can be ready, blocked, running, candidate, accepted, or rejected. An item is
accepted based on artifacts and verification; a successful process exit is not an
acceptance criterion by itself. Omit branch/SHA fields in non-Git projects.
