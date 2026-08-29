package com.farlands.listeners;

import org.bukkit.Material;
import org.bukkit.Sound;
import org.bukkit.entity.Player;
import org.bukkit.event.EventHandler;
import org.bukkit.event.Listener;
import org.bukkit.event.block.BlockBreakEvent;
import org.bukkit.plugin.java.JavaPlugin;

public class ActionListener implements Listener {

    private final JavaPlugin plugin;

    public ActionListener(JavaPlugin plugin) {
        this.plugin = plugin;
    }

    @EventHandler
    public void onBlockBreak(BlockBreakEvent event) {

        String triggerAction =
            plugin.getConfig().getString(
                "onPlayerAction.triggerAction",
                ""
            );

        if (triggerAction.isBlank()) {
            return;
        }

        String expectedMaterial =
            triggerAction.replace("BREAK_", "");

        Material material;

        try {
            material = Material.valueOf(expectedMaterial);
        } catch (IllegalArgumentException e) {
            return;
        }

        if (event.getBlock().getType() != material) {
            return;
        }

        Player player = event.getPlayer();

        String title =
            plugin.getConfig().getString(
                "onPlayerAction.achievement.title",
                ""
            );

        String description =
            plugin.getConfig().getString(
                "onPlayerAction.achievement.description",
                ""
            );

        String soundName =
            plugin.getConfig().getString(
                "onPlayerAction.achievement.soundEffect",
                ""
            );

        if (!title.isBlank()) {
            player.sendMessage("§a§l[Achievement] " + title);
        }

        if (!description.isBlank()) {
            player.sendMessage("§7" + description);
        }

        try {
            Sound sound = Sound.valueOf(soundName);

            player.playSound(
                player.getLocation(),
                sound,
                1.0f,
                1.0f
            );
        } catch (Exception ignored) {
        }
    }
}