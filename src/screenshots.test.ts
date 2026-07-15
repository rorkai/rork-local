import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { normalizeShotName, sanitizeShotName } from "./screenshots.js";

describe("screenshot names", () => {
  test("normalizes a user-supplied screenshot name without inventing a fallback", () => {
    assert.equal(normalizeShotName("  Home / Dashboard  "), "home-dashboard");
    assert.equal(normalizeShotName("!!!"), "");
  });

  test("keeps the generated fallback for capture flows where the name is optional", () => {
    assert.match(sanitizeShotName("!!!"), /^shot-\d+$/);
  });
});
