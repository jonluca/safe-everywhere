import { parseAbi } from "viem";

export const safeSetupAbi = parseAbi([
  "function setup(address[] _owners, uint256 _threshold, address to, bytes data, address fallbackHandler, address paymentToken, uint256 payment, address payable paymentReceiver)",
]);

export const safeReadAbi = parseAbi([
  "function getOwners() view returns (address[])",
  "function getThreshold() view returns (uint256)",
]);

export const replayFactoryAbi = parseAbi([
  "function createProxyWithNonce(address _singleton, bytes initializer, uint256 saltNonce) returns (address proxy)",
  "function createProxyWithNonceL2(address _singleton, bytes initializer, uint256 saltNonce) returns (address proxy)",
]);

export const zeroAddress = "0x0000000000000000000000000000000000000000" as const;
