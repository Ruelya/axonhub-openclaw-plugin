/**
 * Standalone credential helper entry for Codex command-auth.
 *
 * The helper validates embedded arguments (agentDir, optional profileId),
 * resolves the AxonHub credential through OpenClaw's public provider-auth
 * runtime, writes exactly the resolved token plus a newline to stdout, and
 * writes concise errors to stderr with a non-zero exit code.
 *
 * It must never log the token, source value, or config payload.
 *
 * Design.md § Codex Runtime Bridge, subsection 4: Credential helper.
 *
 * Usage:
 *   node dist/codex-auth-helper.js <agentDir> [profileId]
 */

import { pathToFileURL } from "node:url";
import { resolveApiKeyForProvider } from "openclaw/plugin-sdk/provider-auth-runtime";

const PROVIDER_ID = "axonhub";

/** Minimal shape of the auth resolver so the core is testable in isolation. */
export type CodexAuthResolver = (input: {
  provider: string;
  agentDir?: string;
  profileId?: string;
}) => Promise<{ apiKey?: string; profileId?: string } | undefined>;

/** IO/dependency surface injected into the helper core for testing. */
export type CodexAuthHelperDeps = {
  resolveApiKey: CodexAuthResolver;
  writeStdout: (text: string) => void;
  writeStderr: (text: string) => void;
};

/**
 * Core helper logic. Parses argv, resolves the credential, and writes exactly
 * the token to stdout on success. Returns the process exit code (0 = success).
 * Never throws; all failures return a non-zero code with a stderr message.
 *
 * @param argv - Arguments after the node/script prefix: [agentDir, profileId?]
 */
export async function runCodexAuthHelper(
  argv: readonly string[],
  deps: CodexAuthHelperDeps,
): Promise<number> {
  if (argv.length === 0 || argv.length > 2) {
    deps.writeStderr("Usage: codex-auth-helper <agentDir> [profileId]\n");
    return 1;
  }

  const agentDir = argv[0];
  const profileId = argv[1];
  if (!agentDir || agentDir.trim() === "") {
    deps.writeStderr("Error: agentDir is required\n");
    return 1;
  }

  try {
    const auth = await deps.resolveApiKey({
      provider: PROVIDER_ID,
      agentDir,
      profileId: profileId && profileId.trim() !== "" ? profileId : undefined,
    });

    if (!auth?.apiKey) {
      deps.writeStderr(
        `Error: No AxonHub API key found for agent (profile: ${profileId ?? "default"})\n`,
      );
      return 1;
    }

    // Write ONLY the token plus newline to stdout (Codex command-auth contract).
    deps.writeStdout(`${auth.apiKey}\n`);
    return 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    deps.writeStderr(`Error: ${message}\n`);
    return 1;
  }
}

/** Real entry point wiring stdio and the public provider-auth runtime. */
async function main(): Promise<void> {
  const code = await runCodexAuthHelper(process.argv.slice(2), {
    resolveApiKey: (input) => resolveApiKeyForProvider(input),
    writeStdout: (text) => process.stdout.write(text),
    writeStderr: (text) => process.stderr.write(text),
  });
  process.exit(code);
}

// Only run when invoked directly (node dist/codex-auth-helper.js ...), not when
// imported by tests or other modules.
const invokedDirectly =
  typeof process.argv[1] === "string" &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  void main();
}
