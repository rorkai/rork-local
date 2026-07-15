type PbxObject = {
  id: string;
  body: string;
  offset: number;
};

export type XcodeBuildSettings = {
  bundleId: string;
  version: string;
};

const PBX_OBJECT_START = /^\s*([A-F0-9]{24})\b[^=]*=\s*\{/gm;

function readObjectBody(source: string, braceOffset: number): string {
  let depth = 0;
  let quoted = false;
  let escaped = false;

  for (let index = braceOffset; index < source.length; index += 1) {
    const char = source[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === "{") depth += 1;
    else if (char === "}" && --depth === 0) return source.slice(braceOffset + 1, index);
  }
  return "";
}

function parseObjects(source: string): PbxObject[] {
  const objects: PbxObject[] = [];
  for (const match of source.matchAll(PBX_OBJECT_START)) {
    const braceOffset = match.index + match[0].lastIndexOf("{");
    const body = readObjectBody(source, braceOffset);
    if (body) objects.push({ id: match[1], body, offset: match.index });
  }
  return objects;
}

function readSetting(body: string, name: string): string {
  const value = body.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|([^;]*));`));
  return (value?.[1] || value?.[2] || "").trim();
}

function fallbackBundleId(source: string): string {
  const ids = [...source.matchAll(/PRODUCT_BUNDLE_IDENTIFIER\s*=\s*(?:"([^"]+)"|([^;"]+));/g)]
    .map((match) => (match[1] || match[2] || "").trim())
    .filter((id) => id && !id.includes("$("));
  const unique = [...new Set(ids)];
  const nonTest = unique.filter((id) => {
    const last = id.split(".").pop() || "";
    return !/^(ui)?tests?$/i.test(last) && !/Tests$/i.test(last);
  });
  return nonTest
    .map((id) => ({
      id,
      children: nonTest.filter((other) => other !== id && other.startsWith(`${id}.`)).length,
    }))
    .sort((left, right) =>
      right.children - left.children || left.id.length - right.id.length || left.id.localeCompare(right.id)
    )[0]?.id || "";
}

/** Reads settings from an application target rather than whichever build
 * configuration appears first. Test and extension targets also declare
 * bundle IDs, and their ordering in a pbxproj is not a stable contract. */
export function detectXcodeBuildSettings(source: string): XcodeBuildSettings {
  const objects = parseObjects(source);
  const byId = new Map(objects.map((object) => [object.id, object]));
  const applicationTargets = objects.filter(
    ({ body }) =>
      /\bisa\s*=\s*PBXNativeTarget\s*;/.test(body) &&
      readSetting(body, "productType") === "com.apple.product-type.application",
  );

  for (const target of applicationTargets) {
    const configurationListId = readSetting(target.body, "buildConfigurationList").match(
      /[A-F0-9]{24}/,
    )?.[0];
    const configurationList = configurationListId ? byId.get(configurationListId) : undefined;
    const configurationIds = configurationList?.body
      .match(/buildConfigurations\s*=\s*\(([\s\S]*?)\);/)?.[1]
      ?.match(/[A-F0-9]{24}/g);

    for (const configurationId of configurationIds || []) {
      const configuration = byId.get(configurationId);
      if (!configuration || !/\bisa\s*=\s*XCBuildConfiguration\s*;/.test(configuration.body)) continue;
      const bundleId = readSetting(configuration.body, "PRODUCT_BUNDLE_IDENTIFIER");
      if (!bundleId || bundleId.includes("$(")) continue;
      return {
        bundleId,
        version: readSetting(configuration.body, "MARKETING_VERSION"),
      };
    }
  }

  return {
    bundleId: fallbackBundleId(source),
    version: source.match(/MARKETING_VERSION\s*=\s*(?:"([^"]+)"|([^;"]+));/)?.slice(1).find(Boolean)?.trim() || "",
  };
}
