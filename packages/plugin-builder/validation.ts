import type { PluginBuilderBody, PotionEffect, StartingItem } from "./types";

export const MAX_PLUGIN_BUILDER_BODY_BYTES = 20 * 1024;

const PLUGIN_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
const MINECRAFT_VERSION_PATTERN = /^[a-zA-Z0-9_.-]{0,32}$/;
const MATERIAL_PATTERN = /^[a-zA-Z0-9_:.-]{0,64}$/;

type ValidationResult =
  | { ok: true; value: PluginBuilderBody; pluginName: string }
  | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalRecord(value: unknown, field: string): Record<string, unknown> | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isRecord(value)) {
    throw new Error(`${field} must be an object`);
  }

  return value;
}

function optionalString(
  value: unknown,
  field: string,
  maxLength: number,
  pattern?: RegExp,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string") {
    throw new Error(`${field} must be a string`);
  }

  if (value.length > maxLength) {
    throw new Error(`${field} is too long`);
  }

  if (pattern && !pattern.test(value)) {
    throw new Error(`${field} has invalid characters`);
  }

  return value;
}

function requiredString(
  value: unknown,
  field: string,
  maxLength: number,
  pattern?: RegExp,
): string {
  if (value === undefined) {
    throw new Error(`${field} is required`);
  }

  const result = optionalString(value, field, maxLength, pattern);

  if (!result) {
    throw new Error(`${field} is required`);
  }

  return result;
}

function optionalInteger(
  value: unknown,
  field: string,
  min: number,
  max: number,
): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${field} must be an integer from ${min} to ${max}`);
  }

  return value;
}

function requiredInteger(value: unknown, field: string, min: number, max: number): number {
  if (value === undefined) {
    throw new Error(`${field} is required`);
  }

  const result = optionalInteger(value, field, min, max);

  if (result === undefined) {
    throw new Error(`${field} is required`);
  }

  return result;
}

function validateStartingItems(value: unknown): StartingItem[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value) || value.length > 20) {
    throw new Error("onPlayerJoin.startingItems must contain up to 20 items");
  }

  return value.map((item, index) => {
    if (!isRecord(item)) {
      throw new Error(`onPlayerJoin.startingItems.${index} must be an object`);
    }

    return {
      material: requiredString(
        item.material,
        `onPlayerJoin.startingItems.${index}.material`,
        64,
        MATERIAL_PATTERN,
      ),
      amount: requiredInteger(item.amount, `onPlayerJoin.startingItems.${index}.amount`, 1, 64),
    };
  });
}

function validatePotionEffects(value: unknown): PotionEffect[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value) || value.length > 20) {
    throw new Error("onPlayerJoin.potionEffects must contain up to 20 effects");
  }

  return value.map((effect, index) => {
    if (!isRecord(effect)) {
      throw new Error(`onPlayerJoin.potionEffects.${index} must be an object`);
    }

    return {
      type: requiredString(
        effect.type,
        `onPlayerJoin.potionEffects.${index}.type`,
        64,
        MATERIAL_PATTERN,
      ),
      durationTicks: requiredInteger(
        effect.durationTicks,
        `onPlayerJoin.potionEffects.${index}.durationTicks`,
        1,
        72000,
      ),
      amplifier: requiredInteger(
        effect.amplifier,
        `onPlayerJoin.potionEffects.${index}.amplifier`,
        0,
        255,
      ),
    };
  });
}

export function validatePluginBuilderBody(body: unknown): ValidationResult {
  try {
    if (!isRecord(body)) {
      throw new Error("Request body must be an object");
    }

    const metadata = optionalRecord(body.metadata, "metadata");
    const onPlayerJoin = optionalRecord(body.onPlayerJoin, "onPlayerJoin");
    const onPlayerQuit = optionalRecord(body.onPlayerQuit, "onPlayerQuit");
    const onPlayerAction = optionalRecord(body.onPlayerAction, "onPlayerAction");
    const achievement = optionalRecord(onPlayerAction?.achievement, "onPlayerAction.achievement");

    const pluginName =
      optionalString(metadata?.pluginName, "metadata.pluginName", 64, PLUGIN_NAME_PATTERN) ??
      "FarlandsPlugin";

    const value: PluginBuilderBody = {
      metadata: {
        pluginName,
        minecraftVersion: optionalString(
          metadata?.minecraftVersion,
          "metadata.minecraftVersion",
          32,
          MINECRAFT_VERSION_PATTERN,
        ),
      },
      onPlayerJoin: {
        privateMessage: optionalString(
          onPlayerJoin?.privateMessage,
          "onPlayerJoin.privateMessage",
          500,
        ),
        broadcastMessage: optionalString(
          onPlayerJoin?.broadcastMessage,
          "onPlayerJoin.broadcastMessage",
          500,
        ),
        startingItems: validateStartingItems(onPlayerJoin?.startingItems),
        potionEffects: validatePotionEffects(onPlayerJoin?.potionEffects),
      },
      onPlayerQuit: {
        broadcastMessage: optionalString(
          onPlayerQuit?.broadcastMessage,
          "onPlayerQuit.broadcastMessage",
          500,
        ),
      },
      onPlayerAction: {
        triggerAction: optionalString(
          onPlayerAction?.triggerAction,
          "onPlayerAction.triggerAction",
          64,
          MATERIAL_PATTERN,
        ),
        achievement: {
          title: optionalString(achievement?.title, "onPlayerAction.achievement.title", 100),
          description: optionalString(
            achievement?.description,
            "onPlayerAction.achievement.description",
            300,
          ),
          soundEffect: optionalString(
            achievement?.soundEffect,
            "onPlayerAction.achievement.soundEffect",
            64,
            MATERIAL_PATTERN,
          ),
        },
      },
    };

    return { ok: true, value, pluginName };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Invalid request body",
    };
  }
}
