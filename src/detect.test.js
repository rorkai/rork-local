import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { detectFromXcode } from "./detect.js";

const roots = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

function object(id, body) {
  return `${id} = { ${body} };`;
}

function projectFixture({ targetSettings, projectSettings = {}, extraTargets = [] }) {
  const settings = (values) =>
    Object.entries(values)
      .map(([key, value]) => `${key} = ${JSON.stringify(value)};`)
      .join(" ");

  const targets = [
    ...extraTargets,
    {
      id: "AAAAAAAAAAAAAAAAAAAAAAAA",
      configurationListId: "BBBBBBBBBBBBBBBBBBBBBBBB",
      configurationId: "CCCCCCCCCCCCCCCCCCCCCCCC",
      name: "Demo App",
      productType: "com.apple.product-type.application",
      settings: targetSettings,
    },
  ];

  const objects = [
    object(
      "DDDDDDDDDDDDDDDDDDDDDDDD",
      `isa = PBXProject; buildConfigurationList = EEEEEEEEEEEEEEEEEEEEEEEE; targets = (${targets.map(({ id }) => id).join(", ")},);`,
    ),
    object(
      "EEEEEEEEEEEEEEEEEEEEEEEE",
      "isa = XCConfigurationList; buildConfigurations = (FFFFFFFFFFFFFFFFFFFFFFFF,); defaultConfigurationName = Release;",
    ),
    object(
      "FFFFFFFFFFFFFFFFFFFFFFFF",
      `isa = XCBuildConfiguration; buildSettings = { ${settings(projectSettings)} }; name = Release;`,
    ),
  ];

  for (const target of targets) {
    objects.push(
      object(
        target.id,
        `isa = PBXNativeTarget; buildConfigurationList = ${target.configurationListId}; name = ${JSON.stringify(target.name)}; productType = ${JSON.stringify(target.productType)};`,
      ),
      object(
        target.configurationListId,
        `isa = XCConfigurationList; buildConfigurations = (${target.configurationId},); defaultConfigurationName = Release;`,
      ),
      object(
        target.configurationId,
        `isa = XCBuildConfiguration; buildSettings = { ${settings(target.settings)} }; name = Release;`,
      ),
    );
  }

  return `// !$*UTF8*$!\n{ archiveVersion = 1; classes = {}; objectVersion = 77; objects = {\n${objects.join("\n")}\n}; rootObject = DDDDDDDDDDDDDDDDDDDDDDDD; }`;
}

function detectProject(source) {
  const root = mkdtempSync(path.join(tmpdir(), "rork-local-detect-"));
  roots.push(root);
  const projectDir = path.join(root, "Demo.xcodeproj");
  mkdirSync(projectDir);
  writeFileSync(path.join(projectDir, "project.pbxproj"), source);
  return detectFromXcode(root);
}

describe("detectFromXcode", () => {
  test("selects the application instead of test and extension targets", () => {
    const source = projectFixture({
      targetSettings: {
        IPHONEOS_DEPLOYMENT_TARGET: "18.0",
        MARKETING_VERSION: "2.4",
        PRODUCT_BUNDLE_IDENTIFIER: "com.example.demo",
      },
      extraTargets: [
        {
          id: "111111111111111111111111",
          configurationListId: "222222222222222222222222",
          configurationId: "333333333333333333333333",
          name: "DemoTests",
          productType: "com.apple.product-type.bundle.unit-test",
          settings: { PRODUCT_BUNDLE_IDENTIFIER: "com.example.demo.tests" },
        },
        {
          id: "444444444444444444444444",
          configurationListId: "555555555555555555555555",
          configurationId: "666666666666666666666666",
          name: "DemoWidget",
          productType: "com.apple.product-type.app-extension",
          settings: { PRODUCT_BUNDLE_IDENTIFIER: "com.example.demo.widget" },
        },
      ],
    });

    expect(detectProject(source)).toEqual({
      bundleId: "com.example.demo",
      source: "Demo.xcodeproj/project.pbxproj",
      version: "2.4",
    });
  });

  test("inherits project-level build settings", () => {
    const source = projectFixture({
      projectSettings: {
        MARKETING_VERSION: "4.2.0",
        PRODUCT_BUNDLE_IDENTIFIER: "com.example.inherited",
      },
      targetSettings: { IPHONEOS_DEPLOYMENT_TARGET: "18.0" },
    });

    expect(detectProject(source)).toMatchObject({
      bundleId: "com.example.inherited",
      version: "4.2.0",
    });
  });

  test("expands referenced build settings and target-name operators", () => {
    const source = projectFixture({
      projectSettings: { BUNDLE_PREFIX: "com.example" },
      targetSettings: {
        IPHONEOS_DEPLOYMENT_TARGET: "18.0",
        MARKETING_VERSION: "1.0",
        PRODUCT_BUNDLE_IDENTIFIER: "$(BUNDLE_PREFIX).$(TARGET_NAME:rfc1034identifier)",
      },
    });

    expect(detectProject(source)).toMatchObject({
      bundleId: "com.example.Demo-App",
      version: "1.0",
    });
  });

  test("does not return a bundle identifier with unresolved references", () => {
    const source = projectFixture({
      targetSettings: {
        IPHONEOS_DEPLOYMENT_TARGET: "18.0",
        PRODUCT_BUNDLE_IDENTIFIER: "com.example.demo${SAMPLE_CODE_DISAMBIGUATOR}",
      },
    });

    expect(detectProject(source)).toEqual({});
  });
});
