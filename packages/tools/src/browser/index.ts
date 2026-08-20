/**
 * @agentic/tools/browser — session-based computer-use tools driving the
 * system Chrome/Chromium via playwright-core (design §G5).
 */
export {
  browserOpenSession,
  browserNavigate,
  browserRead,
  browserClick,
  browserFill,
  browserScreenshot,
  browserCloseSession,
} from "./tools";
export {
  BrowserSessionManager,
  browserSessions,
  browserToolsAvailable,
  resolveBrowserExecutable,
  BROWSER_SESSION_MAX,
  BROWSER_SESSION_TTL_MS,
  type BrowserSession,
} from "./session-manager";
