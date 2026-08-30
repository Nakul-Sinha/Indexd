export type AllayPowerAction = "start" | "stop" | "restart";

export type AllayCreateTemplate = "minecraft_paper" | "minecraft_vanilla";

export type CreateMinecraftBody = {
  name: string;
  game: "minecraft";
  type: "paper" | "vanilla";
  version: string;
  cpuCores: number;
  ramMb: number;
  storageGb: number;
  gameConfigJson: {
    maxPlayers: number;
    difficulty: "peaceful" | "easy" | "normal" | "hard";
    pvp: boolean;
    seed?: string;
    motd?: string;
  };
};

export type AllayCreateIntent = {
  kind: "create";
  template: AllayCreateTemplate;
  body: CreateMinecraftBody;
};

export type AllayIntent =
  | { kind: "greeting" }
  | { kind: "help" }
  | { kind: "list" }
  | { kind: "status" }
  | { kind: "copy" }
  | { kind: "power"; action: AllayPowerAction }
  | AllayCreateIntent
  | { kind: "unknown" };

type CreateTemplateDefinition = {
  id: AllayCreateTemplate;
  label: string;
  aliases: string[];
  defaultName: string;
  body: Omit<CreateMinecraftBody, "name">;
};

type NamedServer = {
  id: string;
  name: string;
};

const MINECRAFT_CONFIG = {
  maxPlayers: 20,
  difficulty: "normal" as const,
  pvp: true,
};

const CREATE_TEMPLATES: CreateTemplateDefinition[] = [
  {
    id: "minecraft_vanilla",
    label: "Minecraft Vanilla",
    aliases: ["minecraft vanilla", "vanilla minecraft", "vanilla server", "vanilla realm"],
    defaultName: "Vanilla Realm",
    body: {
      game: "minecraft",
      type: "vanilla",
      version: "1.21.8",
      cpuCores: 1,
      ramMb: 2048,
      storageGb: 5,
      gameConfigJson: MINECRAFT_CONFIG,
    },
  },
  {
    id: "minecraft_paper",
    label: "Minecraft Paper",
    aliases: [
      "minecraft paper",
      "paper minecraft",
      "paper server",
      "paper realm",
      "minecraft server",
      "minecraft realm",
      "minecraft",
    ],
    defaultName: "Minecraft Realm",
    body: {
      game: "minecraft",
      type: "paper",
      version: "1.21.8",
      cpuCores: 1,
      ramMb: 2048,
      storageGb: 5,
      gameConfigJson: MINECRAFT_CONFIG,
    },
  },
];

const CREATE_PHRASES = [
  "create",
  "make",
  "provision",
  "host",
  "set up",
  "spin up",
  "launch",
  "new",
];

const MUTATION_WORDS =
  "(?:start|wake|boot|stop|sleep|restart|reboot|create|make|provision|host|launch)";

function normalize(value: string) {
  return value
    .toLocaleLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function containsPhrase(input: string, phrases: string[]) {
  return phrases.some((phrase) =>
    new RegExp(`\\b${escapeRegExp(phrase).replaceAll(" ", "\\s+")}\\b`, "i").test(input),
  );
}

function hasNegatedMutation(input: string): boolean {
  return new RegExp(
    `\\b(?:do\\s+not|don\\s+t|never|avoid|without)\\s+(?:\\w+\\s+){0,2}${MUTATION_WORDS}\\b`,
  ).test(input);
}

function asksAboutMutation(input: string): boolean {
  return new RegExp(
    `^(?:how\\s+(?:do|can|would|should)\\s+i|how\\s+to|what\\s+happens\\s+if|should\\s+i|can\\s+i|would\\s+it)\\b.*\\b${MUTATION_WORDS}\\b`,
  ).test(input);
}

export type ConfirmationReply = "confirm" | "cancel" | "other";

export function classifyConfirmationReply(value: string): ConfirmationReply {
  const input = normalize(value);
  if (
    [
      "yes",
      "yes please",
      "yep",
      "confirm",
      "continue",
      "do it",
      "please do",
      "create it",
      "go ahead",
    ].includes(input)
  ) {
    return "confirm";
  }
  if (
    [
      "no",
      "nope",
      "cancel",
      "never mind",
      "nevermind",
      "leave it",
      "do not",
      "don t",
      "abort",
      "stop",
    ].includes(input)
  ) {
    return "cancel";
  }
  return "other";
}

function createName(value: string, fallback: string): string {
  const match = value.match(/\b(?:named|called|name\s+it)\s+["'“”]?(.+?)["'“”]?\s*[.!?]*$/i);
  const requested = match?.[1]
    ?.replace(/\s+(?:please|for me)$/i, "")
    .replace(/^["'“”]+|["'“”]+$/g, "")
    .trim();
  return (requested || fallback).replace(/\s+/g, " ").slice(0, 50);
}

function parseCreateIntent(value: string, input: string): AllayCreateIntent | null {
  if (!containsPhrase(input, CREATE_PHRASES)) return null;

  const template = CREATE_TEMPLATES.find((candidate) => containsPhrase(input, candidate.aliases));
  if (!template) return null;

  return {
    kind: "create",
    template: template.id,
    body: {
      name: createName(value, template.defaultName),
      ...template.body,
    },
  };
}

export function createTemplateLabel(template: AllayCreateTemplate): string {
  return (
    CREATE_TEMPLATES.find((candidate) => candidate.id === template)?.label ?? "Minecraft realm"
  );
}

export function parseAllayIntent(value: string): AllayIntent {
  const input = normalize(value);

  if (!input) return { kind: "unknown" };
  if (hasNegatedMutation(input)) return { kind: "unknown" };
  if (asksAboutMutation(input)) return { kind: "help" };

  const createIntent = parseCreateIntent(value, input);
  if (createIntent) return createIntent;

  if (containsPhrase(input, ["restart", "reboot", "cycle", "re launch", "relaunch"])) {
    return { kind: "power", action: "restart" };
  }

  if (
    containsPhrase(input, [
      "stop",
      "sleep",
      "shut down",
      "shutdown",
      "turn off",
      "power off",
      "take offline",
    ])
  ) {
    return { kind: "power", action: "stop" };
  }

  if (
    containsPhrase(input, [
      "start",
      "wake",
      "boot",
      "spin up",
      "turn on",
      "power on",
      "bring online",
    ])
  ) {
    return { kind: "power", action: "start" };
  }

  if (containsPhrase(input, ["copy", "address", "join code", "hostname", "ip", "endpoint"])) {
    return { kind: "copy" };
  }

  if (
    containsPhrase(input, ["status", "state", "health", "online", "offline", "running", "how is"])
  ) {
    return { kind: "status" };
  }

  if (
    containsPhrase(input, [
      "list",
      "show realms",
      "show servers",
      "my realms",
      "my servers",
      "my workloads",
    ])
  ) {
    return { kind: "list" };
  }

  if (containsPhrase(input, ["help", "commands", "what can you do", "options"])) {
    return { kind: "help" };
  }

  if (containsPhrase(input, ["hi", "hello", "hey", "allay", "thanks", "thank you"])) {
    return { kind: "greeting" };
  }

  return { kind: "unknown" };
}

export function findMentionedServer<T extends NamedServer>(
  servers: T[],
  value: string,
  fallbackServerId?: string | null,
): T | null {
  if (servers.length === 0) return null;

  const input = normalize(value);
  const mentioned = [...servers]
    .sort((a, b) => b.name.length - a.name.length)
    .find((server) => {
      const name = normalize(server.name);
      return (
        name.length > 0 && new RegExp(`(?:^|\\s)${escapeRegExp(name)}(?:$|\\s)`, "i").test(input)
      );
    });

  if (mentioned) return mentioned;

  const ordinal = input.match(/^(?:(?:realm|server|workload)\s+)?(\d+)(?:\s+please)?$/);
  if (ordinal) {
    const index = Number(ordinal[1]) - 1;
    if (servers[index]) return servers[index];
  }

  const usesContext = containsPhrase(input, [
    "it",
    "that one",
    "that realm",
    "that server",
    "the realm",
    "the server",
  ]);

  if (usesContext && fallbackServerId) {
    return servers.find((server) => server.id === fallbackServerId) ?? null;
  }

  const genericSoleTarget = new RegExp(
    `^(?:please\\s+)?(?:${MUTATION_WORDS.slice(3, -1)}|status|state|check|copy)\\s+(?:(?:my|the|that)\\s+)?(?:realm|server|workload|it)(?:\\s+please)?$`,
  ).test(input);
  if (servers.length === 1 && genericSoleTarget) return servers[0];

  return null;
}
