---
name: route-to-openapi
description: "Generates RESTful API documentation (OpenAPI 3.0 / Swagger spec) by scanning route definitions, handler functions, and schema validators (Zod, Pydantic, Joi) in code. Trigger when users ask for API documentation, OpenAPI, Swagger, endpoint docs, or generating API contracts from source code."
license: MIT
---

# Route to OpenAPI 3.0 Spec Generator

Inspects route files across Node.js (Express, Fastify, Next.js App Router), Python (FastAPI, Flask), and Go (Gin, Chi) to generate a complete, valid OpenAPI 3.0 specification in YAML or JSON.

## Workflow

1. **Route Discovery**:
   - Find route registrations (`app.get`, `app.post`, `router.route`, `@app.route`).
   - Extract HTTP method, path parameters, and query parameters.
2. **Schema Extraction**:
   - Map request body validation schemas (Zod, Joi, Pydantic, TypeScript interfaces) to OpenAPI Component Schemas.
   - Extract response types and status codes (200, 201, 400, 401, 404, 500).
3. **Security Schemes**:
   - Identify authentication middleware (Bearer JWT, API Key, Session Cookie).
   - Define `securitySchemes` in the components object and attach `security` blocks to protected routes.
4. **Output Generation**:
   - Emit standard OpenAPI 3.0.3 specification with tags, operationIds, descriptions, and example payloads.

