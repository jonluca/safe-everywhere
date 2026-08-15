import { describe, expect, it } from "vitest";
import { buildChainRegistry } from "../src/registry.js";
import { supportedSafeVersions } from "../src/types.js";

const defaultChainIds = [
  1, 10, 56, 100, 137, 5_000, 8_453, 42_161, 42_220, 43_114, 59_144, 534_352,
];

describe("official Safe deployment registry", () => {
  it.each(defaultChainIds)("has factories and singletons for configured chain %s", (chainId) => {
    const registry = buildChainRegistry(chainId);
    const factoryVersions = new Set([...registry.factories.values()].map((entry) => entry.version));
    const singletonVersions = new Set(
      [...registry.singletons.values()].map((entry) => entry.version),
    );
    expect(factoryVersions).toEqual(new Set(supportedSafeVersions));
    expect(singletonVersions).toEqual(new Set(supportedSafeVersions));
  });

  it("keeps all v1.3 deployment variants instead of selecting only the default", () => {
    const registry = buildChainRegistry(1);
    expect(
      [...registry.factories.values()].filter((entry) => entry.version === "1.3.0"),
    ).toHaveLength(2);
    expect(
      [...registry.singletons.values()].filter((entry) => entry.version === "1.3.0").length,
    ).toBeGreaterThan(2);
  });
});
