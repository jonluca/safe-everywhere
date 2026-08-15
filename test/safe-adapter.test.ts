import { describe, expect, it } from "vitest";
import {
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionData,
  getAbiItem,
  parseAbiParameters,
  type Abi,
  type Address,
  type Hex,
  type Log,
} from "viem";
import { safeSetupAbi, zeroAddress } from "../src/contracts.js";
import { buildChainRegistry } from "../src/registry.js";
import { decodeFactoryLog, decodeSafeSetup, fingerprintCreation } from "../src/safe-adapter.js";

const proxy = "0x1111111111111111111111111111111111111111" as Address;
const singleton = "0x2222222222222222222222222222222222222222" as Address;
const owner = "0x3333333333333333333333333333333333333333" as Address;
const transactionHash = `0x${"4".repeat(64)}` as Hex;
const blockHash = `0x${"5".repeat(64)}` as Hex;

function factory(version: "1.3.0" | "1.5.0") {
  const match = [...buildChainRegistry(1).factories.values()].find(
    (candidate) => candidate.version === version,
  );
  if (!match) throw new Error(`Missing ${version} factory fixture`);
  return match;
}

describe("Safe factory decoding", () => {
  it("decodes the non-indexed v1.3 ProxyCreation layout", () => {
    const deployment = factory("1.3.0");
    const event = getAbiItem({ abi: deployment.abi as Abi, name: "ProxyCreation" });
    const topics = encodeEventTopics({ abi: [event], eventName: "ProxyCreation" });
    const data = encodeAbiParameters(parseAbiParameters("address, address"), [proxy, singleton]);
    const observation = decodeFactoryLog(1, deployment, {
      address: deployment.address,
      topics,
      data,
      blockNumber: 123n,
      blockHash,
      transactionHash,
      transactionIndex: 0,
      logIndex: 1,
      removed: false,
    } as Log);
    expect(observation).toMatchObject({
      safeAddress: proxy,
      singleton,
      eventName: "ProxyCreation",
    });
  });

  it("decodes the rich v1.5 ProxyCreationL2 layout", () => {
    const deployment = factory("1.5.0");
    const event = getAbiItem({ abi: deployment.abi as Abi, name: "ProxyCreationL2" });
    const initializer = "0x1234" as Hex;
    const topics = encodeEventTopics({
      abi: [event],
      eventName: "ProxyCreationL2",
      args: { proxy },
    });
    const data = encodeAbiParameters(parseAbiParameters("address, bytes, uint256"), [
      singleton,
      initializer,
      42n,
    ]);
    const observation = decodeFactoryLog(1, deployment, {
      address: deployment.address,
      topics,
      data,
      blockNumber: 124n,
      blockHash,
      transactionHash,
      transactionIndex: 0,
      logIndex: 2,
      removed: false,
    } as Log);
    expect(observation).toMatchObject({
      safeAddress: proxy,
      singleton,
      eventInitializer: initializer,
      eventSaltNonce: 42n,
    });
  });
});

describe("Safe initializer policy material", () => {
  it("decodes owners, threshold, handler, and payment fields", () => {
    const initializer = encodeFunctionData({
      abi: safeSetupAbi,
      functionName: "setup",
      args: [[owner], 1n, zeroAddress, "0x", zeroAddress, zeroAddress, 0n, zeroAddress],
    });
    expect(decodeSafeSetup(initializer)).toEqual({
      owners: [owner],
      threshold: 1n,
      to: zeroAddress,
      data: "0x",
      fallbackHandler: zeroAddress,
      paymentToken: zeroAddress,
      payment: 0n,
      paymentReceiver: zeroAddress,
    });
  });

  it("rejects empty initializers", () => {
    expect(() => decodeSafeSetup("0x")).toThrow("Empty initializer");
  });

  it("fingerprints the salt and byte-identical initializer", () => {
    const first = fingerprintCreation(proxy, singleton, "0x1234", 1n);
    expect(fingerprintCreation(proxy, singleton, "0x1234", 1n)).toBe(first);
    expect(fingerprintCreation(proxy, singleton, "0x1234", 2n)).not.toBe(first);
    expect(fingerprintCreation(proxy, singleton, "0x1235", 1n)).not.toBe(first);
  });
});
