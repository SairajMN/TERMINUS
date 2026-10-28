---
name: api-shape-explorer
description: "Generates multiple radically different interface designs for a module or backend service ('Design It Twice'). Explores ergonomic trade-offs, type safety, backwards compatibility, and failure modes before writing code. Trigger when users ask to design an API, compare interface options, explore module shapes, or mention 'design it twice'."
license: MIT
---

# API Shape Explorer ("Design It Twice")

A foundational software engineering skill: never commit to the first API design that comes to mind. Generate 2 to 3 distinct architectural shapes, evaluate their ergonomics, and select the optimal contract.

## Design Philosophy

When designing a new module, function, or service interface, explore across multiple paradigms:

1. **Shape A: Minimal & Functional (Explicit)**
   - Pure functions, simple object inputs, explicit return types.
   - Lowest cognitive overhead, easiest to unit test, zero hidden state.
   - Example:
     ```typescript
     export function verifyToken(token: string, secret: string, options?: VerifyOptions): Result<Session, AuthError>;
     ```

2. **Shape B: Object-Oriented / Class-Based (Stateful & Encapsulated)**
   - Encapsulated resources, dependency injection, reusable configuration, lifecycle hooks.
   - Ideal for clients with connection pools, caches, or state machines.
   - Example:
     ```typescript
     export class TokenVerifier {
       constructor(private config: AuthConfig, private cache: KeyCache) {}
       async verify(token: string): Promise<Session>;
     }
     ```

3. **Shape C: Fluent / Builder / Middleware Pattern (Composability)**
   - Method chaining, extensible middleware pipeline, customizable interception.
   - Ideal for complex request building, data transformation pipelines, or web frameworks.
   - Example:
     ```typescript
     const session = await auth()
       .withSecret(secret)
       .requireClaims(["admin"])
       .verify(token);
     ```

---

## Evaluation Scorecard

For each proposed shape, evaluate against:

| Metric | Criteria |
|---|---|
| **Ergonomics** | Is the common use case 1–2 lines of intuitive code? |
| **Type Safety** | Does TypeScript infer types cleanly without requiring manual casting? |
| **Failure Modes** | Are errors returned as typed unions/results or thrown exceptions? |
| **Testability** | Can dependencies be mocked with zero boilerplate? |
| **Evolution** | Can new optional parameters be added without breaking existing callers? |

