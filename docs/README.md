# SimpleMindsAI documentation

This is the documentation index. The [root README](../README.md) is the project
landing page and quickstart; the articles below go deeper.

## Start here

- [Project README](../README.md) — what SimpleMindsAI is, current status, and a
  verified quickstart.
- [Architecture](ARCHITECTURE.md) — the two planes, subsystem responsibilities,
  data flow, chat and the loss gate, and the project invariants.

## Understand the system

- [Architecture](ARCHITECTURE.md) — how a collected article becomes a training
  example, how a chat turn is answered, and how promotion is decided.
- [Proof obligations and the Phase 1 gate](PROOF.md) — the random-initialisation
  invariant, the six proof obligations, and the twelve checks.
- [Roadmap](ROADMAP.md) — completed milestones, current priorities, longer-term
  direction, known limitations and open research questions.

## Operate and deploy

- [Deployment and artifacts](DEPLOYMENT.md) — the `$SMA_STORE` layout, what goes
  in git versus out of it, artifact naming, export, the `active.json` pointer, and
  environment configuration.
- [Verified empirical findings](FINDINGS.md) — measured behaviours (bf16 masters
  freezing parameters, 220× bf16-on-CPU penalty, tensor-hash shape) that shaped
  the design.

## Contribute

- [Development](DEVELOPMENT.md) — prerequisites, repository map, environment
  setup, the subprocess contract, and how to run the tests.

## Documentation conventions

- Use relative Markdown links so they resolve on GitHub and from a local clone.
- Keep architecture and data-flow diagrams in Mermaid only where they clarify.
- Keep a single authoritative location for each substantial piece of information
  and cross-link rather than duplicate.
- Do not describe planned work as implemented; distinguish the two explicitly.
