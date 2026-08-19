/** Commit-safe projection of a local sandbox compatibility result. */

import type { SandboxCompatibilityVerification } from './manager.ts'

/** Portable evidence safe to commit; excludes machine paths, diagnostics, and logs. */
export interface SandboxCompatibilityAttestation {
  format: SandboxCompatibilityVerification['format']
  kind: SandboxCompatibilityVerification['kind']
  repository: SandboxCompatibilityVerification['repository']
  commit: SandboxCompatibilityVerification['commit']
  checkedAt: SandboxCompatibilityVerification['checkedAt']
  profileMode: SandboxCompatibilityVerification['profileMode']
  result: SandboxCompatibilityVerification['result']
  plugin: SandboxCompatibilityVerification['plugin']
}

export function portableCompatibilityAttestation(verification: SandboxCompatibilityVerification): SandboxCompatibilityAttestation {
  return {
    format: verification.format,
    kind: verification.kind,
    repository: verification.repository,
    commit: verification.commit,
    checkedAt: verification.checkedAt,
    profileMode: verification.profileMode,
    result: verification.result,
    plugin: verification.plugin,
  }
}
