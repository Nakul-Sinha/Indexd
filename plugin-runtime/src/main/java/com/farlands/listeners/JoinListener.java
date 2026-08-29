package com.farlands.listeners;

import org.bukkit.Bukkit;
import org.bukkit.entity.Player;
import org.bukkit.event.EventHandler;
import org.bukkit.event.Listener;
import org.bukkit.event.player.PlayerJoinEvent;
import org.bukkit.plugin.java.JavaPlugin;

import org.bukkit.Material;
import org.bukkit.inventory.ItemStack;

import java.util.List;
import java.util.Map;

import org.bukkit.potion.PotionEffect;
import org.bukkit.potion.PotionEffectType;

public class JoinListener implements Listener {

    private final JavaPlugin plugin;

    public JoinListener(JavaPlugin plugin) {
        this.plugin = plugin;
    }

    @EventHandler
    public void onJoin(PlayerJoinEvent event) {

        Player player = event.getPlayer();

        String privateMessage =
            plugin.getConfig().getString(
                "onPlayerJoin.privateMessage",
                ""
            );

        String broadcastMessage =
            plugin.getConfig().getString(
                "onPlayerJoin.broadcastMessage",
                ""
            );

        if (!privateMessage.isBlank()) {
            player.sendMessage(
                privateMessage.replace(
                    "{player}",
                    player.getName()
                )
            );
        }

        if (!broadcastMessage.isBlank()) {
            Bukkit.broadcastMessage(
                broadcastMessage.replace(
                    "{player}",
                    player.getName()
                )
            );
        }

        List<Map<?, ?>> items =
            plugin.getConfig().getMapList(
                "onPlayerJoin.startingItems"
            );

        for (Map<?, ?> item : items) {

            String materialName =
                String.valueOf(item.get("material"));

            int amount =
                ((Number)item.get("amount"))
                    .intValue();

            try {

                Material material =
                    Material.valueOf(materialName);

                player.getInventory().addItem(
                    new ItemStack(material, amount)
                );

            } catch (IllegalArgumentException ignored) {
                plugin.getLogger().warning(
                    "Invalid material: " + materialName
                );
            }
        }

        List<Map<?, ?>> potionEffects =
            plugin.getConfig().getMapList(
                "onPlayerJoin.potionEffects"
            );

        for (Map<?, ?> effect : potionEffects) {

            String typeName =
                String.valueOf(effect.get("type"));

            int duration =
                ((Number) effect.get("durationTicks"))
                    .intValue();

            int amplifier =
                ((Number) effect.get("amplifier"))
                    .intValue();

            PotionEffectType type =
                PotionEffectType.getByName(typeName);

            if (type != null) {

                player.addPotionEffect(
                    new PotionEffect(
                        type,
                        duration,
                        amplifier
                    )
                );

            } else {

                plugin.getLogger().warning(
                    "Invalid potion effect: " + typeName
                );
            }
        }
    }
}