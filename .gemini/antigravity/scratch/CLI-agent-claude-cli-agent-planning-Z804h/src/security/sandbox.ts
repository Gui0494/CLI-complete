/**
 * sandbox.ts — Workspace sandbox for AurexAI CLI Agent
 *
 * Ensures file operations stay within the workspace boundary.
 *
 * Reference: docs/architecture-reference/hooks/workspace-sandbox.md
 */

import * as path from "path";

// ─── Workspace Sandbox ──────────────────────────────────

export class WorkspaceSandbox {
  private workspaceRoot: string;

  constructor(workspaceRoot?: string) {
    this.workspaceRoot = path.resolve(workspaceRoot ?? process.cwd());
  }

  /**
   * Get the workspace root path.
   */
  getRoot(): string {
    return this.workspaceRoot;
  }

  /**
   * Check if a file path is inside the workspace.
   * Resolves the path and checks if it starts with the workspace root.
   */
  isInsideWorkspace(filePath: string): boolean {
    const resolved = path.resolve(filePath);
    const normalizedRoot = this.normalizePath(this.workspaceRoot);
    const normalizedPath = this.normalizePath(resolved);

    // Check that the resolved path is within workspace root
    return normalizedPath.startsWith(normalizedRoot + path.sep) ||
           normalizedPath === normalizedRoot;
  }

  /**
   * Validate a file path. Returns an error message if outside workspace, null if OK.
   */
  validate(filePath: string): string | null {
    if (!this.isInsideWorkspace(filePath)) {
      const resolved = path.resolve(filePath);
      return (
        `Acesso bloqueado: "${resolved}" está fora do workspace.\n` +
        `Workspace: "${this.workspaceRoot}"\n` +
        `O agent só pode acessar arquivos dentro do workspace.`
      );
    }
    return null;
  }

  /**
   * Get the relative path from workspace root.
   */
  relativePath(filePath: string): string {
    return path.relative(this.workspaceRoot, path.resolve(filePath));
  }

  /**
   * Normalize path for consistent comparisons (lowercase on Windows).
   */
  private normalizePath(p: string): string {
    const normalized = path.normalize(p);
    // On Windows, normalize case for comparison
    if (process.platform === 'win32') {
      return normalized.toLowerCase();
    }
    return normalized;
  }
}

// ─── Singleton for the current workspace ─────────────────

let defaultSandbox: WorkspaceSandbox | null = null;

export function getWorkspaceSandbox(root?: string): WorkspaceSandbox {
  if (!defaultSandbox || root) {
    defaultSandbox = new WorkspaceSandbox(root);
  }
  return defaultSandbox;
}
