"use client";

import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import {
  Check,
  CircleAlert,
  Copy,
  HelpCircle,
  Power,
  RefreshCw,
  Send,
  Server,
  X,
} from "lucide-react";
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  type AllayChatTurn,
  type AllayCreateToolArguments,
  type AllayToolProposal,
  allayFallbackMessage,
  appendAllayExchange,
  askAllay,
  executeAllayTool,
  shouldUseAllayModel,
} from "@/lib/allay-chat";
import {
  type AllayCreateIntent,
  type AllayCreateTemplate,
  type AllayIntent,
  type AllayPowerAction,
  classifyConfirmationReply,
  createTemplateLabel,
  findMentionedServer,
  parseAllayIntent,
} from "@/lib/allay-intent";
import { joinAddress, type LiveServer } from "@/lib/api";
import { AllaySprite } from "./allay-sprite";

type ConnectorState = "checking" | "connected" | "unavailable";
type TargetIntent = Extract<AllayIntent, { kind: "status" | "copy" | "power" }>;

type AllayMessage = {
  id: number;
  from: "allay" | "operator";
  text: string;
  tone?: "normal" | "success" | "error";
};

type PowerActionResult = {
  success: boolean;
  action: AllayPowerAction;
  status: string;
  server_id: string;
};

type CreateServerResult = {
  server_id: string;
  name: string;
  state: string;
};

type PendingConfirmation = {
  action: AllayPowerAction;
  serverId: string;
};

type AllayCompanionProps = {
  connectorState: ConnectorState;
  operatorName: string;
  refreshServers: () => Promise<unknown>;
  servers: LiveServer[] | undefined;
  serversLoading: boolean;
};

const TRANSITIONAL_STATES = new Set(["provisioning", "starting", "stopping", "restarting"]);

function humanize(value: string) {
  return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function actionLabel(action: AllayPowerAction) {
  if (action === "start") return "start";
  if (action === "stop") return "stop";
  return "restart";
}

function actionProgress(action: AllayPowerAction) {
  if (action === "start") return "Starting";
  if (action === "stop") return "Stopping";
  return "Restarting";
}

function workloadNoun(server: LiveServer): "realm" | "server" | "site" {
  const game = server.game.toLocaleLowerCase();
  if (game === "node") return "site";
  if (game === "minecraft" || game === "minecraft_bedrock") return "realm";
  return "server";
}

function accessNoun(server: LiveServer): string {
  if (workloadNoun(server) === "site") return "site URL";
  if (workloadNoun(server) === "realm") return "join address";
  return "server address";
}

function copiedAccessMessage(server: LiveServer): string {
  const address = joinAddress(server);
  const game = server.game.toLocaleLowerCase();
  if (game === "node") return `${address} is copied. Open ${server.name} in a browser.`;
  if (game === "minecraft" || game === "minecraft_bedrock") {
    return `${address} is copied. Paste it into Minecraft to join ${server.name}.`;
  }
  return `${address} is copied. Use it to connect to ${server.name}.`;
}

function createSummary(intent: AllayCreateIntent): string {
  const { body } = intent;
  const seed = body.gameConfigJson.seed ? ` Seed: ${body.gameConfigJson.seed}.` : "";
  const motd = body.gameConfigJson.motd ? ` MOTD: ${body.gameConfigJson.motd}.` : "";
  return `${createTemplateLabel(intent.template)} named ${body.name}: version ${body.version}, ${body.cpuCores} CPU, ${body.ramMb} MB memory, ${body.storageGb} GB storage, ${body.gameConfigJson.maxPlayers} players, ${body.gameConfigJson.difficulty} difficulty, and PvP ${body.gameConfigJson.pvp ? "on" : "off"}.${seed}${motd}`;
}

function createToolArguments(intent: AllayCreateIntent): AllayCreateToolArguments {
  const { body } = intent;
  return {
    name: body.name,
    type: body.type,
    version: body.version,
    cpu_cores: body.cpuCores,
    ram_mb: body.ramMb,
    storage_gb: body.storageGb,
    max_players: body.gameConfigJson.maxPlayers,
    difficulty: body.gameConfigJson.difficulty,
    pvp: body.gameConfigJson.pvp,
    ...(body.gameConfigJson.seed ? { seed: body.gameConfigJson.seed } : {}),
    ...(body.gameConfigJson.motd ? { motd: body.gameConfigJson.motd } : {}),
  };
}

function createIntentFromTool(arguments_: AllayCreateToolArguments): AllayCreateIntent {
  const template: AllayCreateTemplate =
    arguments_.type === "vanilla" ? "minecraft_vanilla" : "minecraft_paper";
  return {
    kind: "create",
    template,
    body: {
      name: arguments_.name,
      game: "minecraft",
      type: arguments_.type,
      version: arguments_.version,
      cpuCores: arguments_.cpu_cores,
      ramMb: arguments_.ram_mb,
      storageGb: arguments_.storage_gb,
      gameConfigJson: {
        maxPlayers: arguments_.max_players,
        difficulty: arguments_.difficulty,
        pvp: arguments_.pvp,
        ...(arguments_.seed ? { seed: arguments_.seed } : {}),
        ...(arguments_.motd ? { motd: arguments_.motd } : {}),
      },
    },
  };
}

function stateSummary(server: LiveServer, connectorState: ConnectorState) {
  const address = server.hostname
    ? ` Its ${accessNoun(server)} is ${joinAddress(server)}.`
    : ` Its ${accessNoun(server)} is pending.`;
  const freshness =
    connectorState === "unavailable"
      ? " The connector is offline, so this is the last loaded state."
      : "";
  return `${server.name} is ${humanize(server.currentState).toLocaleLowerCase()}.${address}${freshness}`;
}

function listSummary(servers: LiveServer[], connectorState: ConnectorState) {
  const summary = servers
    .map((server, index) => `${index + 1}. ${server.name}: ${humanize(server.currentState)}`)
    .join("\n");
  const freshness =
    connectorState === "unavailable"
      ? "\nThese are the last loaded states because the connector is offline."
      : "";
  return `${summary}${freshness}`;
}

function controlErrorMessage(error: unknown) {
  if (!(error instanceof Error)) return "The control plane did not accept that command.";
  const raw = error.message.replace(/^\d{3}\s+/, "");

  try {
    const parsed = JSON.parse(raw) as { error?: string; message?: string };
    return parsed.message ?? parsed.error ?? "The control plane did not accept that command.";
  } catch {
    if (/^\d{3}\b/.test(error.message)) {
      return "The control plane did not accept that command.";
    }
    return raw || "The control plane did not accept that command.";
  }
}

export function AllayCompanion({
  connectorState,
  operatorName,
  refreshServers,
  servers,
  serversLoading,
}: AllayCompanionProps) {
  const reducedMotion = useReducedMotion();
  const [open, setOpen] = useState(true);
  const [draft, setDraft] = useState("");
  const [messages, setMessages] = useState<AllayMessage[]>([
    {
      id: 1,
      from: "allay",
      text: `Hi ${operatorName}. I can create Minecraft realms, then check, start, stop, restart, or copy their join addresses.`,
    },
  ]);
  const [activeServerId, setActiveServerId] = useState<string | null>(null);
  const [pendingSelection, setPendingSelection] = useState<TargetIntent | null>(null);
  const [pendingConfirmation, setPendingConfirmation] = useState<PendingConfirmation | null>(null);
  const [pendingCreate, setPendingCreate] = useState<AllayCreateIntent | null>(null);
  const [busyAction, setBusyAction] = useState<{
    action: AllayPowerAction;
    serverId: string;
  } | null>(null);
  const [busyCreate, setBusyCreate] = useState<AllayCreateIntent | null>(null);
  const [busyChat, setBusyChat] = useState(false);
  const [allayHistory, setAllayHistory] = useState<AllayChatTurn[]>([]);
  const messageId = useRef(2);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLInputElement>(null);
  const confirmationButtonRef = useRef<HTMLButtonElement>(null);
  const petButtonRef = useRef<HTMLButtonElement>(null);
  const chatRequestRef = useRef<AbortController | null>(null);
  const wasBusy = useRef(false);

  const availableServers = servers ?? [];
  const busyServer = busyAction
    ? availableServers.find((server) => server.id === busyAction.serverId)
    : null;
  const busy = Boolean(busyAction || busyCreate);

  const connectionLabel =
    connectorState === "connected"
      ? "Control plane connected"
      : connectorState === "unavailable"
        ? "Connector unavailable"
        : "Checking connection";
  const transcriptRevision =
    messages.length +
    Number(Boolean(pendingSelection)) +
    Number(Boolean(pendingConfirmation)) +
    Number(Boolean(pendingCreate)) +
    Number(busy) +
    Number(busyChat);

  const quickCommands = useMemo(() => {
    const commands: Array<{ label: string; prompt: string; icon: typeof Server }> = [];
    const stopped = availableServers.find((server) =>
      ["stopped", "ready", "failed"].includes(server.currentState.toLocaleLowerCase()),
    );
    const running = availableServers.find(
      (server) => server.currentState.toLocaleLowerCase() === "running",
    );

    if (stopped) {
      commands.push({ label: `Wake ${stopped.name}`, prompt: `Wake ${stopped.name}`, icon: Power });
    }
    if (running) {
      commands.push({
        label: `Copy ${running.name}`,
        prompt: `Copy the ${accessNoun(running)} for ${running.name}`,
        icon: Copy,
      });
    }
    commands.push({ label: "Realm status", prompt: "Show my realms", icon: Server });
    if (!running && !stopped) {
      commands.push({
        label: "New Paper realm",
        prompt: "Create a Paper server named survival",
        icon: Power,
      });
      commands.push({
        label: "New Vanilla realm",
        prompt: "Create a Vanilla realm called block party",
        icon: HelpCircle,
      });
    }
    return commands.slice(0, 3);
  }, [availableServers]);

  useEffect(() => {
    void transcriptRevision;
    const transcript = transcriptRef.current;
    if (!transcript) return;
    transcript.scrollTo({
      top: transcript.scrollHeight,
      behavior: reducedMotion ? "auto" : "smooth",
    });
  }, [transcriptRevision, reducedMotion]);

  useEffect(() => {
    if (busy) {
      wasBusy.current = true;
      return;
    }
    if (wasBusy.current && open) {
      wasBusy.current = false;
      window.requestAnimationFrame(() => composerRef.current?.focus());
    }
  }, [busy, open]);

  useEffect(() => {
    if (!pendingConfirmation && !pendingCreate) return;
    window.requestAnimationFrame(() => confirmationButtonRef.current?.focus());
  }, [pendingConfirmation, pendingCreate]);

  useEffect(
    () => () => {
      chatRequestRef.current?.abort();
    },
    [],
  );

  function appendMessage(from: AllayMessage["from"], text: string, tone?: AllayMessage["tone"]) {
    setMessages((items) => [...items, { id: messageId.current++, from, text, tone }]);
  }

  function cancelChatRequest() {
    chatRequestRef.current?.abort();
    chatRequestRef.current = null;
    setBusyChat(false);
  }

  function closeChat() {
    cancelChatRequest();
    setOpen(false);
    window.requestAnimationFrame(() => petButtonRef.current?.focus());
  }

  function toggleChat() {
    const nextOpen = !open;
    if (!nextOpen) cancelChatRequest();
    setOpen((value) => !value);
    window.requestAnimationFrame(() => {
      if (nextOpen) composerRef.current?.focus();
      else petButtonRef.current?.focus();
    });
  }

  function selectedServer(serverId: string) {
    return availableServers.find((server) => server.id === serverId) ?? null;
  }

  function explainNoServers() {
    if (serversLoading) {
      appendMessage("allay", "I’m still checking which workloads belong to this account.");
      return;
    }
    if (connectorState === "unavailable") {
      appendMessage(
        "allay",
        "I can’t reach the control plane right now, so I can’t safely inspect or change a workload.",
        "error",
      );
      return;
    }
    appendMessage(
      "allay",
      "I don’t see any workloads assigned to this account yet. I can create one when you are ready.",
    );
  }

  function validatePowerAction(server: LiveServer, action: AllayPowerAction) {
    const state = server.currentState.toLocaleLowerCase();

    if (action === "start" && ["running", "starting", "restarting"].includes(state)) {
      appendMessage("allay", `${server.name} is already ${humanize(state).toLocaleLowerCase()}.`);
      return false;
    }
    if (action === "stop" && ["stopped", "ready", "stopping"].includes(state)) {
      appendMessage("allay", `${server.name} is already ${humanize(state).toLocaleLowerCase()}.`);
      return false;
    }
    if (action === "restart" && state !== "running") {
      appendMessage(
        "allay",
        `${server.name} is ${humanize(state).toLocaleLowerCase()}, so the control plane will not restart it.`,
      );
      return false;
    }
    if (TRANSITIONAL_STATES.has(state)) {
      appendMessage(
        "allay",
        `${server.name} is ${humanize(state).toLocaleLowerCase()}. Let that finish before sending another power command.`,
      );
      return false;
    }
    return true;
  }

  function requestCreate(intent: AllayCreateIntent) {
    setPendingSelection(null);
    setPendingConfirmation(null);
    setPendingCreate(intent);
    appendMessage(
      "allay",
      `Please confirm this create request before I send it. ${createSummary(intent)}`,
    );
  }

  async function runCreate(intent: AllayCreateIntent) {
    if (connectorState === "unavailable") {
      appendMessage(
        "allay",
        "I can’t create that workload while the control-plane connector is unavailable.",
        "error",
      );
      return;
    }

    setBusyCreate(intent);
    appendMessage("allay", `Creating ${intent.body.name}. I’ll wait for the control plane.`);

    try {
      const result = await executeAllayTool<CreateServerResult>({
        tool: "create_server",
        arguments: createToolArguments(intent),
      });
      await refreshServers().catch(() => undefined);
      const reference = result.server_id ? ` Its workload ID is ${result.server_id}.` : "";
      if (result.server_id) setActiveServerId(result.server_id);
      appendMessage(
        "allay",
        `${intent.body.name} was created successfully.${reference}`,
        "success",
      );
    } catch (error) {
      appendMessage(
        "allay",
        `I couldn’t create ${intent.body.name}. ${controlErrorMessage(error)}`,
        "error",
      );
      await refreshServers().catch(() => undefined);
    } finally {
      setBusyCreate(null);
    }
  }

  async function runPowerAction(server: LiveServer, action: AllayPowerAction) {
    if (connectorState === "unavailable") {
      appendMessage(
        "allay",
        "I can’t send that command while the control-plane connector is unavailable.",
        "error",
      );
      return;
    }
    if (!validatePowerAction(server, action)) return;

    setBusyAction({ action, serverId: server.id });
    setActiveServerId(server.id);
    appendMessage(
      "allay",
      `${actionProgress(action)} ${server.name}. I’ll wait for the live result.`,
    );

    try {
      const result = await executeAllayTool<PowerActionResult>({
        tool: "power_action",
        arguments: { server_id: server.id, action },
      });
      await refreshServers();
      const finalState = humanize(result.status).toLocaleLowerCase();
      const address =
        action === "start" && server.hostname
          ? ` Its ${accessNoun(server)} is ${joinAddress(server)}.`
          : "";
      appendMessage(
        "allay",
        `${server.name} is ${finalState}. The control plane confirmed the change.${address}`,
        "success",
      );
    } catch (error) {
      appendMessage(
        "allay",
        `I couldn’t ${actionLabel(action)} ${server.name}. ${controlErrorMessage(error)}`,
        "error",
      );
      await refreshServers().catch(() => undefined);
    } finally {
      setBusyAction(null);
    }
  }

  async function copyServerAddress(server: LiveServer) {
    setActiveServerId(server.id);
    if (!server.hostname) {
      appendMessage("allay", `${server.name} does not have a ${accessNoun(server)} yet.`);
      return;
    }

    try {
      await navigator.clipboard.writeText(joinAddress(server));
      appendMessage("allay", copiedAccessMessage(server), "success");
    } catch {
      appendMessage(
        "allay",
        `I couldn’t access the clipboard. The ${accessNoun(server)} is ${joinAddress(server)}.`,
        "error",
      );
    }
  }

  function targetIntent(intent: TargetIntent, server: LiveServer) {
    setActiveServerId(server.id);
    setPendingSelection(null);

    if (intent.kind === "status") {
      appendMessage("allay", stateSummary(server, connectorState));
      return;
    }
    if (intent.kind === "copy") {
      void copyServerAddress(server);
      return;
    }

    if (!validatePowerAction(server, intent.action)) return;
    setPendingConfirmation({ action: intent.action, serverId: server.id });
    const impact =
      intent.action === "start"
        ? `Start ${server.name}? This sends a live command to the control plane.`
        : intent.action === "stop"
          ? `Stop ${server.name}? The ${workloadNoun(server)} will become unavailable.`
          : `Restart ${server.name}? The ${workloadNoun(server)} will be briefly unavailable.`;
    appendMessage("allay", `${impact} Please confirm or cancel.`);
  }

  function resolveTarget(intent: TargetIntent, value: string) {
    if (availableServers.length === 0) {
      explainNoServers();
      return;
    }

    const server = findMentionedServer(availableServers, value, activeServerId);
    if (!server) {
      setPendingSelection(intent);
      appendMessage(
        "allay",
        `Which workload should I ${intent.kind === "power" ? actionLabel(intent.action) : intent.kind}?`,
      );
      return;
    }
    targetIntent(intent, server);
  }

  async function talkToAllay(value: string, fallback: string) {
    chatRequestRef.current?.abort();
    const controller = new AbortController();
    chatRequestRef.current = controller;
    setBusyChat(true);

    try {
      const result = await askAllay(value, allayHistory, controller.signal);
      if (controller.signal.aborted) return;
      appendMessage("allay", result.reply);
      setAllayHistory((history) => appendAllayExchange(history, value, result.reply));
      if (result.proposal) stageToolProposal(result.proposal);
    } catch (error) {
      if (!controller.signal.aborted) {
        appendMessage("allay", allayFallbackMessage(error, fallback), "error");
      }
    } finally {
      if (chatRequestRef.current === controller) {
        chatRequestRef.current = null;
        setBusyChat(false);
      }
    }
  }

  function stageToolProposal(proposal: AllayToolProposal) {
    setPendingSelection(null);

    if (proposal.tool === "create_server") {
      setPendingConfirmation(null);
      setPendingCreate(createIntentFromTool(proposal.arguments));
      return;
    }

    setPendingCreate(null);
    const server = availableServers.find(
      (candidate) => candidate.id === proposal.arguments.server_id,
    );
    if (!server) {
      appendMessage(
        "allay",
        "I couldn’t match that proposed action to one of your current workloads, so nothing will run.",
        "error",
      );
      return;
    }
    if (!validatePowerAction(server, proposal.arguments.action)) return;

    setActiveServerId(server.id);
    setPendingConfirmation({ action: proposal.arguments.action, serverId: server.id });
  }

  function respond(value: string) {
    const confirmationReply = classifyConfirmationReply(value);

    if (pendingCreate) {
      if (confirmationReply === "confirm") {
        const intent = pendingCreate;
        setPendingCreate(null);
        void runCreate(intent);
        return;
      }
      if (confirmationReply === "cancel") {
        const name = pendingCreate.body.name;
        setPendingCreate(null);
        appendMessage("allay", `${name} will not be created.`);
        return;
      }
      appendMessage("allay", "Please confirm or cancel the pending create request first.");
      return;
    }

    if (pendingConfirmation) {
      if (confirmationReply === "confirm") {
        const server = selectedServer(pendingConfirmation.serverId);
        const action = pendingConfirmation.action;
        setPendingConfirmation(null);
        if (server) void runPowerAction(server, action);
        else explainNoServers();
        return;
      }
      if (confirmationReply === "cancel") {
        const server = selectedServer(pendingConfirmation.serverId);
        setPendingConfirmation(null);
        appendMessage("allay", `${server?.name ?? "The workload"} will stay as it is.`);
        return;
      }
      appendMessage(
        "allay",
        "I need a clear “confirm” or “cancel” before I handle another command.",
      );
      return;
    }

    let parsedIntent: AllayIntent | null = null;
    if (pendingSelection) {
      if (confirmationReply === "cancel") {
        setPendingSelection(null);
        appendMessage("allay", "Okay, I cancelled that realm selection.");
        return;
      }

      parsedIntent = parseAllayIntent(value);
      if (parsedIntent.kind === "unknown") {
        const server = findMentionedServer(availableServers, value, activeServerId);
        if (server) {
          targetIntent(pendingSelection, server);
          return;
        }
        appendMessage("allay", "Choose a realm by name or number, or say “cancel”.");
        return;
      }
      setPendingSelection(null);
    }

    const intent = parsedIntent ?? parseAllayIntent(value);
    if (shouldUseAllayModel(intent)) {
      const fallback =
        intent.kind === "greeting"
          ? `Hi ${operatorName}. Tell me what you want to create or manage.`
          : intent.kind === "help"
            ? "I can create Minecraft Paper or Vanilla realms, list them, report state, start, stop, restart, and copy a join address. Try “create a Paper server named survival” or “restart Creative”."
            : "I didn’t catch a realm command there. Ask me to create a Paper or Vanilla realm, or to list, inspect, start, stop, restart, or copy a join address.";
      void talkToAllay(value, fallback);
      return;
    }
    if (intent.kind === "create") {
      requestCreate(intent);
      return;
    }
    if (intent.kind === "list") {
      if (availableServers.length === 0) explainNoServers();
      else appendMessage("allay", listSummary(availableServers, connectorState));
      return;
    }
    if (intent.kind === "status") {
      if (availableServers.length === 0) {
        explainNoServers();
        return;
      }
      const server = findMentionedServer(availableServers, value, activeServerId);
      appendMessage(
        "allay",
        server
          ? stateSummary(server, connectorState)
          : listSummary(availableServers, connectorState),
      );
      if (server) setActiveServerId(server.id);
      return;
    }
    if (intent.kind === "copy" || intent.kind === "power") {
      resolveTarget(intent, value);
      return;
    }
  }

  function submit(value: string) {
    const message = value.trim();
    if (!message || busy) return;
    cancelChatRequest();
    appendMessage("operator", message);
    setDraft("");
    respond(message);
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    submit(draft);
  }

  function chooseServer(server: LiveServer) {
    if (!pendingSelection) return;
    appendMessage("operator", server.name);
    targetIntent(pendingSelection, server);
  }

  function confirmAction() {
    if (!pendingConfirmation) return;
    const server = selectedServer(pendingConfirmation.serverId);
    const action = pendingConfirmation.action;
    setPendingConfirmation(null);
    appendMessage("operator", `Yes, ${actionLabel(action)} ${server?.name ?? "the workload"}.`);
    if (server) void runPowerAction(server, action);
    else explainNoServers();
  }

  function cancelAction() {
    if (!pendingConfirmation) return;
    const server = selectedServer(pendingConfirmation.serverId);
    setPendingConfirmation(null);
    appendMessage("operator", "Leave it as it is.");
    appendMessage("allay", `${server?.name ?? "The workload"} will stay as it is.`);
    window.requestAnimationFrame(() => composerRef.current?.focus());
  }

  function confirmCreate() {
    if (!pendingCreate) return;
    const intent = pendingCreate;
    setPendingCreate(null);
    appendMessage("operator", `Create ${intent.body.name} with those settings.`);
    void runCreate(intent);
  }

  function cancelCreate() {
    if (!pendingCreate) return;
    const name = pendingCreate.body.name;
    setPendingCreate(null);
    appendMessage("operator", "Cancel that create request.");
    appendMessage("allay", `${name} will not be created.`);
    window.requestAnimationFrame(() => composerRef.current?.focus());
  }

  return (
    <aside className={open ? "allay-companion is-open" : "allay-companion"}>
      <AnimatePresence initial={false}>
        {open ? (
          <motion.section
            animate={{ opacity: 1, scale: 1, y: 0 }}
            aria-label="Allay manual control chat"
            className="allay-chat pixel-border"
            exit={reducedMotion ? { opacity: 0 } : { opacity: 0, scale: 0.98, y: 8 }}
            initial={reducedMotion ? { opacity: 0 } : { opacity: 0, scale: 0.98, y: 8 }}
            id="allay-chat-panel"
            transition={{ duration: reducedMotion ? 0 : 0.18, ease: [0.22, 1, 0.36, 1] }}
          >
            <header className="allay-chat-header">
              <div>
                <span className="allay-title-row">
                  <span className="allay-chat-title">Allay</span>
                  <span className="allay-model">Luna · low</span>
                </span>
                <span className={`allay-connection ${connectorState}`}>
                  <span aria-hidden="true" /> {connectionLabel}
                </span>
              </div>
              <button aria-label="Close Allay chat" onClick={closeChat} type="button">
                <X aria-hidden="true" size={16} />
              </button>
            </header>

            <div className="allay-transcript" ref={transcriptRef} role="log">
              {messages.map((message) => (
                <div
                  className={`allay-message ${message.from} ${message.tone ?? "normal"}`}
                  key={message.id}
                  role={message.tone === "error" ? "alert" : undefined}
                >
                  <span>{message.from === "allay" ? "Allay" : "You"}</span>
                  <p>{message.text}</p>
                </div>
              ))}

              {pendingSelection ? (
                <fieldset className="allay-server-choices">
                  <legend className="sr-only">Choose a workload</legend>
                  {availableServers.map((server, index) => (
                    <button key={server.id} onClick={() => chooseServer(server)} type="button">
                      <span>{index + 1}</span>
                      <strong>{server.name}</strong>
                      <small>{humanize(server.currentState)}</small>
                    </button>
                  ))}
                </fieldset>
              ) : null}

              {pendingCreate ? (
                <div className="allay-confirmation">
                  <CircleAlert aria-hidden="true" size={17} />
                  <div>
                    <strong>Confirm workload creation</strong>
                    <span>{createSummary(pendingCreate)}</span>
                  </div>
                  <div className="allay-confirmation-actions">
                    <button
                      className="confirm"
                      onClick={confirmCreate}
                      ref={confirmationButtonRef}
                      type="button"
                    >
                      <Check aria-hidden="true" size={15} /> Create
                    </button>
                    <button onClick={cancelCreate} type="button">
                      Cancel
                    </button>
                  </div>
                </div>
              ) : null}

              {pendingConfirmation ? (
                <div className="allay-confirmation">
                  <CircleAlert aria-hidden="true" size={17} />
                  <div>
                    <strong>
                      Confirm {actionLabel(pendingConfirmation.action)}{" "}
                      {selectedServer(pendingConfirmation.serverId)?.name ?? "realm"}
                    </strong>
                    <span>This sends a live power command to the control plane.</span>
                  </div>
                  <div className="allay-confirmation-actions">
                    <button
                      className="confirm"
                      onClick={confirmAction}
                      ref={confirmationButtonRef}
                      type="button"
                    >
                      <Check aria-hidden="true" size={15} /> {humanize(pendingConfirmation.action)}
                    </button>
                    <button onClick={cancelAction} type="button">
                      Cancel
                    </button>
                  </div>
                </div>
              ) : null}

              {busyAction ? (
                <div className="allay-working" role="status">
                  <RefreshCw aria-hidden="true" size={15} />
                  {actionProgress(busyAction.action)} {busyServer?.name ?? "the workload"}…
                </div>
              ) : null}

              {busyCreate ? (
                <div className="allay-working" role="status">
                  <RefreshCw aria-hidden="true" size={15} />
                  Creating {busyCreate.body.name}…
                </div>
              ) : null}

              {busyChat ? (
                <div className="allay-working" role="status">
                  <RefreshCw aria-hidden="true" size={15} />
                  Allay is thinking with Luna…
                </div>
              ) : null}
            </div>

            <fieldset className="allay-quick-actions">
              <legend className="sr-only">Suggested commands</legend>
              {quickCommands.map(({ label, prompt, icon: Icon }) => (
                <button disabled={busy} key={prompt} onClick={() => submit(prompt)} type="button">
                  <Icon aria-hidden="true" size={14} /> {label}
                </button>
              ))}
            </fieldset>

            <form className="allay-composer" onSubmit={handleSubmit}>
              <label className="sr-only" htmlFor="allay-command">
                Tell Allay what to do
              </label>
              <input
                autoComplete="off"
                ref={composerRef}
                disabled={busy}
                id="allay-command"
                maxLength={180}
                onChange={(event) => setDraft(event.target.value)}
                placeholder={
                  busyChat
                    ? "Send another message to interrupt Luna…"
                    : busy
                      ? "Waiting for the control plane…"
                      : "Try “create a Paper server named survival”"
                }
                value={draft}
              />
              <button aria-label="Send command" disabled={!draft.trim() || busy} type="submit">
                <Send aria-hidden="true" size={17} />
              </button>
              <p className="allay-minecraft-notice">
                Not an official Minecraft service. Not approved by or associated with Mojang or
                Microsoft.
              </p>
            </form>
          </motion.section>
        ) : null}
      </AnimatePresence>

      <div className="allay-anchor">
        {!open ? (
          <motion.span
            animate={{ opacity: 1, x: 0 }}
            className="allay-nudge"
            initial={reducedMotion ? false : { opacity: 0, x: 6 }}
          >
            Need a hand?
          </motion.span>
        ) : null}
        <button
          aria-controls="allay-chat-panel"
          aria-expanded={open}
          aria-label={open ? "Close Allay chat" : "Open Allay manual control chat"}
          className="allay-pet-button"
          onClick={toggleChat}
          ref={petButtonRef}
          type="button"
        >
          <AllaySprite busy={busy} />
          <span className="allay-pet-state" aria-hidden="true">
            {busy ? (
              <RefreshCw size={12} />
            ) : connectorState === "unavailable" ? (
              <CircleAlert size={12} />
            ) : (
              <Power size={12} />
            )}
          </span>
        </button>
      </div>
    </aside>
  );
}
