---
name: skill-builder
description: "Creates, refines, and audits production-grade AI Agent Skills from natural language descriptions, workflows, or documents. Generates standard SKILL.md files with YAML frontmatter, execution SOPs, checklists, concrete code examples, and test evaluation criteria. Trigger when users ask to create a new skill, author a skill, turn a workflow into a skill, or improve an existing skill."
license: MIT
---

# Skill Builder: Meta-Skill for AI Agent Skills

Empowers developers and coding agents to author, evaluate, and package high-quality, reusable agent skills following the standard `SKILL.md` open format.

## Standard Skill Architecture

Every production-grade skill must be housed in a directory with a `SKILL.md` file:

```text
skills/
└── <category>/
    └── <skill-name>/
        ├── SKILL.md             # Required: Primary instruction & SOP
        ├── examples/            # Optional: Reference fixtures or outputs
        └── scripts/             # Optional: Helper validation scripts
```

### Required Frontmatter Specification

```yaml
---
name: kebab-case-name
description: "Concise summary of what the skill does AND exact keywords/scenarios that should trigger it. Must be specific enough for the context engine to match intent accurately."
license: MIT
---
```

## Step-by-Step Skill Authoring SOP

1. **Identify the Trigger Surface**:
   - What exact questions, tasks, or file types should activate this skill?
   - List trigger phrases (e.g. "run security review", "design database schema").
2. **Define the Standard Operating Procedure (SOP)**:
   - Break the complex task into sequential, deterministic phases (e.g. Discovery → Analysis → Execution → Verification).
   - Require explicit checkpoints where the agent must check its work before declaring success.
3. **Include Before & After Code Examples**:
   - Never provide vague guidelines like "make the code secure".
   - Provide concrete, copy-pasteable ❌ Vulnerable vs ✅ Remediated code blocks so the LLM has unambiguous few-shot guidance.
4. **Specify Output Templates**:
   - Provide standard report formats or file templates (e.g. Markdown tables, YAML specs, structured JSON).
5. **Establish Verification Criteria**:
   - How does the agent or user verify that the skill was executed correctly? (e.g. Running test suites, schema validation, lint checks).

