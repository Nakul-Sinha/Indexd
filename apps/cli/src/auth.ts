import { TOKEN_PREFIX } from "@farlands/contracts";
import { CliError, EXIT } from "./errors.ts";

/**
 * Credentials, and the one rule that has no exception: this binary has no
 * password.
 *
 * There is no prompt, no readline, no hidden-input helper, no keychain lookup
 * and no login subcommand anywhere in the CLI. Authentication is a machine token
 * that a person or a CI system put in the environment or in a config file, and
 * the only thing this module does is find it and check its prefix. A password
 * path would mean the CLI could mint a human session, and a human session is
 * what mints approval tokens, which would make the binary a privilege
 * escalation rather than a client.
 *
 * Tokens are read from the environment and from a config file, never from a
 * command line flag. Argument vectors are visible to every process on the
 * machine, so a --token flag would leak the credential to anything running ps.
 */

export const MACHINE_TOKEN_ENV = "FARLANDS_TOKEN";
export const MACHINE_TOKEN_FILE_ENV = "FARLANDS_TOKEN_FILE";
export const APPROVAL_TOKEN_ENV = "FARLANDS_APPROVAL_TOKEN";
export const CONFIG_PATH_ENV = "FARLANDS_CONFIG";
export const BASE_URL_ENV = "FARLANDS_API";

export const DEFAULT_BASE_URL = "http://127.0.0.1:4000";

export interface CredentialSources {
  env: Record<string, string | undefined>;
  /** Returns null when the path does not exist. Injected so tests stay off disk. */
  readTextFile: (path: string) => string | null;
  homeDir: string | null;
}

export interface Credential {
  token: string;
  /** Where it came from, for the diagnostic when the prefix is wrong. */
  origin: string;
}

interface ConfigFile {
  api?: string;
  token?: string;
}

function configPath(sources: CredentialSources): string | null {
  const explicit = sources.env[CONFIG_PATH_ENV];
  if (explicit) return explicit;
  if (!sources.homeDir) return null;
  return `${sources.homeDir}/.config/farlands/config.json`;
}

function readConfig(sources: CredentialSources): { config: ConfigFile; path: string } | null {
  const path = configPath(sources);
  if (!path) return null;
  const raw = sources.readTextFile(path);
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) {
      throw new CliError(`${path} is not a JSON object.`);
    }
    return { config: parsed as ConfigFile, path };
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError(`${path} is not valid JSON.`, {
      hint: "Fix or remove the config file. The CLI will not guess at a malformed credential store.",
    });
  }
}

export function resolveBaseUrl(sources: CredentialSources): string {
  const fromEnv = sources.env[BASE_URL_ENV];
  if (fromEnv) return fromEnv.replace(/\/+$/, "");
  const file = readConfig(sources);
  if (file?.config.api) return file.config.api.replace(/\/+$/, "");
  return DEFAULT_BASE_URL;
}

/**
 * The machine token, or null when none is configured.
 *
 * Null is returned rather than thrown so a command can decide: reads fail with a
 * clear message, and deploy and rollback still reach their refusal, which is the
 * more useful answer than "no credentials".
 */
export function resolveMachineToken(sources: CredentialSources): Credential | null {
  const direct = sources.env[MACHINE_TOKEN_ENV];
  if (direct) return checkMachineToken({ token: direct.trim(), origin: MACHINE_TOKEN_ENV });

  const path = sources.env[MACHINE_TOKEN_FILE_ENV];
  if (path) {
    const contents = sources.readTextFile(path);
    if (contents === null) {
      throw new CliError(`${MACHINE_TOKEN_FILE_ENV} points at ${path}, which does not exist.`);
    }
    return checkMachineToken({
      token: contents.trim(),
      origin: `${MACHINE_TOKEN_FILE_ENV} (${path})`,
    });
  }

  const file = readConfig(sources);
  if (file?.config.token) {
    return checkMachineToken({ token: file.config.token.trim(), origin: file.path });
  }
  return null;
}

function checkMachineToken(credential: Credential): Credential {
  if (credential.token.startsWith(TOKEN_PREFIX.machine)) return credential;

  // The two token kinds are not interchangeable and confusing them is the most
  // likely mistake here, so it is named rather than left as a 401 later.
  const looksLikeApproval = credential.token.startsWith(TOKEN_PREFIX.approval);
  throw new CliError(
    looksLikeApproval
      ? `${credential.origin} holds an approval token, not a machine token.`
      : `${credential.origin} does not hold a machine token.`,
    {
      exitCode: EXIT.error,
      hint: looksLikeApproval
        ? `An approval token authorises one deployment and belongs in ${APPROVAL_TOKEN_ENV}. A machine token authenticates the caller and starts with ${TOKEN_PREFIX.machine}.`
        : `Machine tokens start with ${TOKEN_PREFIX.machine}. Issue one from the dashboard; the CLI never accepts a password.`,
    },
  );
}

/**
 * The approval token for one act command, or null.
 *
 * Environment only, and never prompted for. An agent that cannot find one is
 * meant to stop and ask a human, which is exactly what the refusal says.
 */
export function resolveApprovalToken(sources: CredentialSources): string | null {
  const token = sources.env[APPROVAL_TOKEN_ENV]?.trim();
  return token ? token : null;
}
