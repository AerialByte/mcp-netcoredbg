/**
 * SessionManager - Manages multiple debug sessions.
 *
 * Provides:
 * - Creation and tracking of multiple concurrent debug sessions
 * - Default session handling for backward compatibility
 * - Auto-detection of session IDs from project paths
 */

import { DebugSession, SessionConfig, SessionStatus } from "./session.js";
import * as path from "path";

export type SessionId = string;

// Info returned when listing sessions
export interface SessionInfo {
  id: SessionId;
  isDefault: boolean;
  mode: "launch" | "attach" | "watch";
  program: string;
  status: SessionStatus;
}

/**
 * Manages multiple debug sessions and routes tool calls to the appropriate session.
 */
export class SessionManager {
  private sessions = new Map<SessionId, DebugSession>();
  private defaultSessionId: SessionId | null = null;
  private sessionCounter = 0;

  /**
   * Create a new session with the given ID (or auto-generate one).
   * If a session with the same ID already exists, throws an error.
   */
  createSession(id?: SessionId): DebugSession {
    const sessionId = id || this.generateSessionId();

    if (this.sessions.has(sessionId)) {
      throw new Error(
        `Session '${sessionId}' already exists. Use a different name or terminate it first.`
      );
    }

    const session = new DebugSession(sessionId);
    this.sessions.set(sessionId, session);

    // First session becomes default
    if (this.defaultSessionId === null) {
      this.defaultSessionId = sessionId;
    }

    return session;
  }

  /**
   * Get a session by ID, or the default session if no ID specified.
   * Throws if no session found.
   */
  getSession(id?: SessionId): DebugSession {
    const sessionId = id || this.defaultSessionId;

    if (!sessionId) {
      throw new Error(
        "No active debug session. Use 'launch', 'attach', or 'launch_watch' to start one."
      );
    }

    const session = this.sessions.get(sessionId);
    if (!session) {
      const available = this.listSessionIds();
      if (available.length === 0) {
        throw new Error(
          `Session '${sessionId}' not found. No active sessions. Use 'launch' or 'launch_watch' to start one.`
        );
      }
      throw new Error(
        `Session '${sessionId}' not found. Available: ${available.join(", ")}`
      );
    }

    return session;
  }

  /**
   * Try to get a session, returning null if not found instead of throwing.
   */
  tryGetSession(id?: SessionId): DebugSession | null {
    try {
      return this.getSession(id);
    } catch {
      return null;
    }
  }

  /**
   * Check if a session exists with the given ID.
   */
  hasSession(id: SessionId): boolean {
    return this.sessions.has(id);
  }

  /**
   * Set which session is the default for tool calls without sessionId.
   */
  setDefaultSession(id: SessionId): void {
    if (!this.sessions.has(id)) {
      throw new Error(`Session '${id}' not found`);
    }
    this.defaultSessionId = id;
  }

  /**
   * Get the default session ID.
   */
  getDefaultSessionId(): SessionId | null {
    return this.defaultSessionId;
  }

  /**
   * Remove and terminate a session.
   */
  async removeSession(id: SessionId): Promise<void> {
    const session = this.sessions.get(id);
    if (session) {
      await session.terminate();
      this.sessions.delete(id);

      // Update default if removed
      if (this.defaultSessionId === id) {
        const remaining = Array.from(this.sessions.keys());
        this.defaultSessionId = remaining.length > 0 ? remaining[0] : null;
      }
    }
  }

  /**
   * List all sessions with their status.
   */
  listSessions(): SessionInfo[] {
    return Array.from(this.sessions.values()).map((s) => {
      const config = s.getConfig();
      return {
        id: s.id,
        isDefault: s.id === this.defaultSessionId,
        mode: config?.mode || "launch",
        program: config?.program || "unknown",
        status: s.getStatus(),
      };
    });
  }

  /**
   * List just the session IDs.
   */
  listSessionIds(): SessionId[] {
    return Array.from(this.sessions.keys());
  }

  /**
   * Get the count of active sessions.
   */
  sessionCount(): number {
    return this.sessions.size;
  }

  /**
   * Terminate all sessions.
   */
  async terminateAll(): Promise<void> {
    for (const session of this.sessions.values()) {
      await session.terminate();
    }
    this.sessions.clear();
    this.defaultSessionId = null;
  }

  /**
   * Derive a session ID from a project path.
   * Extracts meaningful suffix like 'api', 'worker', 'web' from project names.
   *
   * Examples:
   *   TopServer.Service.Api -> api
   *   TopServer.Service.Worker -> worker
   *   MyApp.Web -> web
   *   SomeProject -> someproject
   */
  deriveSessionIdFromPath(projectPath: string): SessionId {
    // Extract project name from path
    const projectName = path.basename(projectPath); // e.g., "TopServer.Service.Api"

    // Try to extract meaningful suffix
    const parts = projectName.split(".");
    const lastPart = parts[parts.length - 1].toLowerCase(); // "api", "worker", "web"

    // Common meaningful suffixes
    const meaningful = ["api", "worker", "web", "service", "server", "client", "app", "host"];
    if (meaningful.includes(lastPart)) {
      // Check if this ID is already taken
      if (!this.sessions.has(lastPart)) {
        return lastPart;
      }
      // Add number suffix if taken
      let counter = 2;
      while (this.sessions.has(`${lastPart}-${counter}`)) {
        counter++;
      }
      return `${lastPart}-${counter}`;
    }

    // Fallback to full project name (kebab-case)
    const kebabName = projectName.toLowerCase().replace(/\./g, "-");
    if (!this.sessions.has(kebabName)) {
      return kebabName;
    }

    // Add number suffix if taken
    let counter = 2;
    while (this.sessions.has(`${kebabName}-${counter}`)) {
      counter++;
    }
    return `${kebabName}-${counter}`;
  }

  /**
   * Derive a session ID from a program path (DLL path).
   * Works for launch mode where we have the DLL path, not project path.
   */
  deriveSessionIdFromProgram(programPath: string): SessionId {
    // Get just the filename without extension
    const filename = path.basename(programPath, path.extname(programPath)); // e.g., "TopServer.Service.Api"
    return this.deriveSessionIdFromPath(filename);
  }

  /**
   * Generate a unique session ID (session-1, session-2, etc.)
   */
  private generateSessionId(): SessionId {
    return `session-${++this.sessionCounter}`;
  }
}

// Global singleton manager
export const sessionManager = new SessionManager();
