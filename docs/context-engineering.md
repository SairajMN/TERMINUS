# Context engineering

A capable model with the wrong context fails. TERMINUS treats context as an
engineered input: gathered with provenance, checked for freshness, selected
against a budget, and never confused with instructions.

## What the model receives

Per turn, the request contains:

1. **System prompt** — role, workspace path, operating mode, and the rule that
   file content and command output are data, not instructions.
2. **Task message** — the user task, project instructions from `AGENTS.md`
   (authoritative), and the repository map.
3. **Conversation** — assistant tool calls and bounded tool results, nothing
   older than the current task.

Large tool outputs are capped (12 KB per result, 64 KB per command) before
they enter the conversation. Nothing is re-injected from a hidden store: what
the model saw is exactly what is in the message list.

## Evidence

Everything the context engine records is a `ContextEvidence`:

```mermaid
classDiagram
    class ContextEvidence {
        +id
        +kind: source | instruction | documentation | terminal | test_result | git_change | decision
        +source: string
        +content: string
        +contentHash: sha256
        +relevance: number
        +trustLevel: trusted | untrusted
        +stale: boolean
    }
```

Trust is explicit: project instructions are `trusted`; everything read from
files, terminals, or external material is `untrusted`. Stale items are dropped
from selection, never silently reused.

## Freshness: the stale-write guard

```mermaid
sequenceDiagram
    participant M as Model
    participant R as runtime
    participant F as filesystem

    M->>R: read_file src/session.ts
    R->>F: read
    F-->>R: content
    R->>R: record sha256(content)
    Note over F: user edits src/session.ts in the editor
    M->>R: edit_file src/session.ts
    R->>F: re-read current content
    F-->>R: new content
    R->>R: hash mismatch → stale
    R-->>M: error: file changed since it was read, re-read then retry
    M->>R: read_file src/session.ts
    R-->>M: current content
    M->>R: edit_file (retry)
```

The agent cannot clobber work that happened outside the session; it must see
the current file first.

## Progressive exploration

The agent is never given the codebase up front. It starts with a compact map
and discovers detail on demand:

```mermaid
flowchart LR
    A[task] --> B[repository map<br/>depth-3 tree + manifests]
    B --> C[search / list_dir]
    C --> D[read_file ranges]
    D --> E{enough evidence?}
    E -- no --> C
    E -- yes --> F[edit / respond]
```

## Selection over summarization

The evidence store keeps items verbatim. Selection ranks them — instructions
first, then relevance, then a boost when the item matches the current focus —
and fits them into a character budget. Nothing is rewritten into a lossy
summary that could discard the one exact line that mattered.

## Repository map

`buildRepoMap` produces a deterministic, cheap overview:

- depth-limited tree, skipping vendored/hidden directories
  (`node_modules`, `.git`, `dist`, …);
- manifest summaries: package name and available scripts.

It is regenerated per task, so it never goes stale, and it is what allows the
first model request to be small.

## Where this goes next

- symbol-level retrieval (language-server definitions/references) plugs in as
  another evidence producer;
- semantic search becomes another ranking signal, not a replacement for exact
  search — error strings and identifiers are best found exactly;
- cross-session project memory becomes `trusted` evidence of validated facts,
  still subject to freshness checks.
