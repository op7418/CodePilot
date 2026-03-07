/**
 * Git Security Utilities
 * Provides validation and sanitization for Git operations
 */

import path from 'path';

/**
 * Valid Git URL patterns
 */
const VALID_GIT_URL_PATTERNS = [
  // HTTPS URLs
  /^https?:\/\/[\w.-]+(:\d+)?\/[\w.-]+\/[\w.-]+(\.git)?$/i,
  // SSH URLs (git@)
  /^git@[\w.-]+:[\w.-]+\/[\w.-]+(\.git)?$/i,
  // SSH URLs (ssh://)
  /^ssh:\/\/git@[\w.-]+(:\d+)?\/[\w.-]+\/[\w.-]+(\.git)?$/i,
  // Git protocol
  /^git:\/\/[\w.-]+\/[\w.-]+\/[\w.-]+(\.git)?$/i,
];

/**
 * Validate Git remote URL
 * Prevents SSRF and malicious repository URLs
 */
export function validateGitUrl(url: string): { valid: boolean; error?: string } {
  if (!url || typeof url !== 'string') {
    return { valid: false, error: 'URL is required' };
  }

  const trimmedUrl = url.trim();

  // Check length
  if (trimmedUrl.length > 2048) {
    return { valid: false, error: 'URL is too long' };
  }

  // Check for dangerous patterns
  const dangerousPatterns = [
    /\.\./,           // Directory traversal
    /[;<>&|`$]/,      // Shell injection characters
    /\0/,             // Null bytes
    /javascript:/i,   // JavaScript protocol
    /data:/i,         // Data protocol
    /file:/i,         // File protocol (local files)
    /localhost/i,     // Localhost
    /127\./,          // Loopback
    /192\.168\./,     // Private network
    /10\./,           // Private network
    /172\.(1[6-9]|2\d|3[01])\./, // Private network
  ];

  for (const pattern of dangerousPatterns) {
    if (pattern.test(trimmedUrl)) {
      return { valid: false, error: 'Invalid URL: contains disallowed pattern' };
    }
  }

  // Validate URL format
  const isValidPattern = VALID_GIT_URL_PATTERNS.some(pattern => pattern.test(trimmedUrl));
  if (!isValidPattern) {
    return { valid: false, error: 'Invalid Git URL format. Expected: https://..., git@..., or ssh://...' };
  }

  return { valid: true };
}

/**
 * Validate and normalize a file system path
 * Prevents directory traversal attacks
 */
export function validatePath(inputPath: string): { valid: boolean; normalized?: string; error?: string } {
  if (!inputPath || typeof inputPath !== 'string') {
    return { valid: false, error: 'Path is required' };
  }

  // Normalize the path (resolves .., ., and multiple slashes)
  const normalized = path.normalize(inputPath);

  // Check for null bytes
  if (normalized.includes('\0')) {
    return { valid: false, error: 'Invalid path: contains null bytes' };
  }

  // Check if normalized path tries to escape (should not start with ..)
  if (normalized.startsWith('..') || path.isAbsolute(inputPath) !== path.isAbsolute(normalized)) {
    return { valid: false, error: 'Invalid path: potential directory traversal' };
  }

  // Check for reasonable length
  if (normalized.length > 4096) {
    return { valid: false, error: 'Path is too long' };
  }

  return { valid: true, normalized };
}

/**
 * Validate remote name
 * Only allows alphanumeric, hyphen, and underscore
 */
export function validateRemoteName(name: string): { valid: boolean; error?: string } {
  if (!name || typeof name !== 'string') {
    return { valid: false, error: 'Remote name is required' };
  }

  const trimmed = name.trim();

  if (trimmed.length > 64) {
    return { valid: false, error: 'Remote name is too long' };
  }

  // Only allow safe characters
  if (!/^[a-zA-Z0-9_-]+$/.test(trimmed)) {
    return { valid: false, error: 'Remote name can only contain alphanumeric characters, hyphens, and underscores' };
  }

  return { valid: true };
}

/**
 * Validate branch name
 * Follows Git branch naming rules
 */
export function validateBranchName(name: string): { valid: boolean; error?: string } {
  if (!name || typeof name !== 'string') {
    return { valid: false, error: 'Branch name is required' };
  }

  const trimmed = name.trim();

  if (trimmed.length > 250) {
    return { valid: false, error: 'Branch name is too long' };
  }

  // Git branch naming rules
  // Cannot start with . or -
  // Cannot contain .., ~, ^, :, space, ?, *, [, \\, or control characters
  // Cannot end with . or /
  // Cannot end with .lock
  const invalidPattern = /^[-]|[\.\.~^:\s?*\[\\]|\.lock$|\/$|\.$/;

  if (invalidPattern.test(trimmed)) {
    return { valid: false, error: 'Invalid branch name format' };
  }

  return { valid: true };
}
