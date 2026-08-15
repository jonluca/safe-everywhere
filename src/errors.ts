export class UnsupportedCreationError extends Error {
  override name = "UnsupportedCreationError";
}

export class PolicyRejectionError extends Error {
  override name = "PolicyRejectionError";
}

export class IncompatibleTargetError extends Error {
  override name = "IncompatibleTargetError";
}

export class DeploymentConflictError extends Error {
  override name = "DeploymentConflictError";
}

export class SafeConfigurationMismatchError extends Error {
  override name = "SafeConfigurationMismatchError";
}
