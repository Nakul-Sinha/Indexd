package com.farlands.listeners;

import org.bukkit.Bukkit;
import org.bukkit.entity.Player;
import org.bukkit.event.EventHandler;
import org.bukkit.event.Listener;
import org.bukkit.event.player.PlayerQuitEvent;
import org.bukkit.plugin.java.JavaPlugin;

public class QuitListener implements Listener {

    private final JavaPlugin plugin;

    public QuitListener(JavaPlugin plugin) {
        this.plugin = plugin;
    }

    @EventHandler
    public void onQuit(PlayerQuitEvent event) {

        Player player = event.getPlayer();

        String broadcastMessage =
            plugin.getConfig().getString(
                "onPlayerQuit.broadcastMessage",
                ""
            );

        if (!broadcastMessage.isBlank()) {
            Bukkit.broadcastMessage(
                broadcastMessage.replace(
                    "{player}",
                    player.getName()
                )
            );
        }
    }
}