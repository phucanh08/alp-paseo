---
name: xia
description: Research an unfamiliar implementation, reuse opportunity, or version-sensitive integration using local artifacts and primary sources. Return an evidence-backed recommendation before implementation; do not expand the assigned scope.
---

# Research before building

Start with a named question that affects a decision. Use a short local inspection
when the relevant seam is clear; broaden to upstream sources only when the question
requires it. Research is read-only with respect to project artifacts. Temporary
experiments require an available isolated scratch location and appropriate authority.

1. Establish the actual stack from manifests, lockfiles, configuration, and commands.
   Read ALP.md and relevant project guidance. Do not infer a stack from folder names.
2. Search nearby code, tests, configuration, scripts, and docs for existing behavior
   and reusable parts. Record the scope searched before saying something is absent.
3. For external behavior, inspect primary upstream source/examples and official
   documentation matching the installed version. Distinguish current guidance from
   the version this project actually uses.
4. Compare viable approaches only where the choice matters. Prefer an existing
   local capability, then a supported dependency capability, then a small adaptation.
   Explain what evidence would change the recommendation.

Label significant findings by evidence type:

- Local: file path, command output, test, or repository revision.
- Upstream: repository URL and revision when available.
- Docs: official source and applicable version.
- Inference: a conclusion drawn from the cited evidence, with uncertainty stated.

If browsing is unavailable, return the local findings and the unresolved external
question. Do not invent a source or claim version compatibility without evidence.
Research does not authorize installing dependencies, editing code, or deploying.

Return the question, findings/sources, reuse candidates, recommendation, alternatives
if material, unknowns, and the next decision. Include actual inspection commands and
results in the handoff. A peer returns this to lead; lead returns unresolved scope
decisions to main. Main can decide technical matters within the user's authorization.

Use available synchronous delegation for a separate research assignment only when
helpful. Do not assume a Scout role or parallel session exists; research is a peer
disposition. An agent can inspect evidence itself without spawning another agent.
