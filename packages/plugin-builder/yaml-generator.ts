import YAML from "yaml";
import type { PluginBuilderBody } from "./types";

export function generateYaml(body: PluginBuilderBody): string {
  const config = {
    metadata: {
      pluginName: body.metadata?.pluginName ?? "",
      minecraftVersion: body.metadata?.minecraftVersion ?? "",
    },

    onPlayerJoin: {
      privateMessage: body.onPlayerJoin?.privateMessage ?? "",
      broadcastMessage: body.onPlayerJoin?.broadcastMessage ?? "",
      startingItems: body.onPlayerJoin?.startingItems ?? [],
      potionEffects: body.onPlayerJoin?.potionEffects ?? [],
    },

    onPlayerQuit: {
      broadcastMessage: body.onPlayerQuit?.broadcastMessage ?? "",
    },

    onPlayerAction: {
      triggerAction: body.onPlayerAction?.triggerAction ?? "",
      achievement: {
        title: body.onPlayerAction?.achievement?.title ?? "",
        description: body.onPlayerAction?.achievement?.description ?? "",
        soundEffect: body.onPlayerAction?.achievement?.soundEffect ?? "",
      },
    },
  };

  return YAML.stringify(config);
}
