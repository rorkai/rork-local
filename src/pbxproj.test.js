import { describe, expect, test } from "bun:test";

import { detectXcodeBuildSettings } from "./pbxproj.js";

function object(id, body) {
  return `${id} = { ${body} };`;
}

describe("detectXcodeBuildSettings", () => {
  test("follows the application target instead of choosing a shorter extension bundle ID", () => {
    const source = [
      object(
        "AAAAAAAAAAAAAAAAAAAAAAAA",
        'isa = PBXNativeTarget; buildConfigurationList = BBBBBBBBBBBBBBBBBBBBBBBB; productType = "com.apple.product-type.application";',
      ),
      object(
        "CCCCCCCCCCCCCCCCCCCCCCCC",
        'isa = PBXNativeTarget; buildConfigurationList = DDDDDDDDDDDDDDDDDDDDDDDD; productType = "com.apple.product-type.app-extension";',
      ),
      object(
        "BBBBBBBBBBBBBBBBBBBBBBBB",
        "isa = XCConfigurationList; buildConfigurations = (EEEEEEEEEEEEEEEEEEEEEEEE,);",
      ),
      object(
        "DDDDDDDDDDDDDDDDDDDDDDDD",
        "isa = XCConfigurationList; buildConfigurations = (FFFFFFFFFFFFFFFFFFFFFFFF,);",
      ),
      object(
        "EEEEEEEEEEEEEEEEEEEEEEEE",
        'isa = XCBuildConfiguration; buildSettings = { PRODUCT_BUNDLE_IDENTIFIER = "com.example.long-app"; MARKETING_VERSION = 2.4; };',
      ),
      object(
        "FFFFFFFFFFFFFFFFFFFFFFFF",
        "isa = XCBuildConfiguration; buildSettings = { PRODUCT_BUNDLE_IDENTIFIER = io.x; };",
      ),
    ].join("\n");

    expect(detectXcodeBuildSettings(source)).toEqual({
      bundleId: "com.example.long-app",
      version: "2.4",
    });
  });

  test("falls back for minimal projects without target linkage and skips test bundles", () => {
    const source = `
      PRODUCT_BUNDLE_IDENTIFIER = com.example.app.tests;
      PRODUCT_BUNDLE_IDENTIFIER = com.example.app;
      MARKETING_VERSION = 1.2.3;
    `;

    expect(detectXcodeBuildSettings(source)).toEqual({
      bundleId: "com.example.app",
      version: "1.2.3",
    });
  });

  test("does not report a test target as an application", () => {
    const source = `
      PRODUCT_BUNDLE_IDENTIFIER = com.example.app.TESTS;
      PRODUCT_BUNDLE_IDENTIFIER = com.example.appSnapshotTests;
    `;

    expect(detectXcodeBuildSettings(source).bundleId).toBe("");
  });

  test("ranks fallback candidates independently of source order", () => {
    const source = `
      PRODUCT_BUNDLE_IDENTIFIER = com.example.app.widget;
      PRODUCT_BUNDLE_IDENTIFIER = com.example.app;
    `;

    expect(detectXcodeBuildSettings(source).bundleId).toBe("com.example.app");
  });
});
