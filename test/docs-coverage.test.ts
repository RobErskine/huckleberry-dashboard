/**
 * Verifies that every Hono route is documented in the OpenAPI spec and vice-versa.
 *
 * If this test fails after you add a new route, update src/openapi.ts to match.
 * If it fails after removing a route, remove the stale path from src/openapi.ts.
 *
 * /mcp is the one exception: it is documented in the spec but handled by the raw
 * fetch handler before Hono, so it never appears in app.routes.
 */

import { describe, it, expect } from "vitest";
import { app } from "../src/index.js";
import { openapiSpec } from "../src/openapi.js";

// Paths that live in the spec but are NOT registered in Hono (handled by the
// raw fetch handler in the default export before app.fetch is called).
const SPEC_ONLY_PATHS = new Set(["/mcp"]);

describe("API docs coverage", () => {
  // Deduplicate by path (GET /api/tokens and POST /api/tokens → one entry).
  // Convert Hono :param notation to OpenAPI {param} notation.
  const honoUniquePaths = [
    ...new Set(
      app.routes
        .filter((r) => r.method !== "ALL") // skip middleware registrations
        .map((r) => r.path.replace(/:(\w+)/g, "{$1}")),
    ),
  ];

  const specPaths = Object.keys(openapiSpec.paths);
  const specPathSet = new Set(specPaths);
  const honoPathSet = new Set(honoUniquePaths);

  it("every Hono route is documented in the spec", () => {
    const missing = honoUniquePaths.filter((p) => !specPathSet.has(p));
    expect(
      missing,
      `Undocumented Hono routes — add them to src/openapi.ts:\n  ${missing.join("\n  ")}`,
    ).toEqual([]);
  });

  it("no stale paths exist in the spec", () => {
    const stale = specPaths.filter((p) => !honoPathSet.has(p) && !SPEC_ONLY_PATHS.has(p));
    expect(
      stale,
      `Stale spec paths with no matching Hono route — remove from src/openapi.ts:\n  ${stale.join("\n  ")}`,
    ).toEqual([]);
  });
});
