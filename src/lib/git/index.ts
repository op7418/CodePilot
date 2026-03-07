/**
 * Git module exports
 */

export { GitService, createGitService, isGitRepo, findGitRoot, cloneRepository } from './git-service';
export {
  scanDirectory,
  addRepository,
  removeRepository,
  getRepositories,
  getRepositoryById,
  getDefaultRepository,
  setDefaultRepository,
  updateLastOpened,
  getRepositoriesWithStatus,
  addScanRoot,
  removeScanRoot,
  getScanRoots,
  scanAllRoots,
} from './repo-scanner';
export type { ScanOptions } from './repo-scanner';
export {
  validateGitUrl,
  validatePath,
  validateRemoteName,
  validateBranchName,
} from './security';
