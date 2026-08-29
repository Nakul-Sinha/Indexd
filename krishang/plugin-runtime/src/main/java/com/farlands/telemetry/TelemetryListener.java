package com.farlands.telemetry;

import java.util.Locale;

import org.bukkit.World;
import org.bukkit.entity.Player;
import org.bukkit.event.EventHandler;
import org.bukkit.event.EventPriority;
import org.bukkit.event.Listener;
import org.bukkit.event.block.BlockBreakEvent;
import org.bukkit.event.block.BlockPlaceEvent;
import org.bukkit.event.entity.EntityDamageByEntityEvent;
import org.bukkit.event.entity.EntityDamageEvent;
import org.bukkit.event.entity.PlayerDeathEvent;
import org.bukkit.event.player.PlayerJoinEvent;
import org.bukkit.event.player.PlayerQuitEvent;
import org.bukkit.plugin.java.JavaPlugin;

import io.papermc.paper.event.player.AsyncChatEvent;

/**
 * The emitter's only contact with Bukkit.
 *
 * Every handler is MONITOR and, where the event can be cancelled, ignores
 * cancelled ones. Telemetry observes what happened; it never gets a vote, and a
 * plugin ordered after it must not see an event this class has touched.
 *
 * Every handler body goes through safely(), so nothing that happens in here can
 * reach the server's event dispatcher. An exception escaping a MONITOR handler
 * does not undo the event, but it does fill the console and, on Paper, can get
 * the listener unregistered, which would silently end telemetry for the world.
 *
 * onChat is the one to read twice. It reads the player's name and stops. The
 * message is a Component on the event and this class never asks for it: nothing
 * downstream can leak text the emitter never picked up.
 */
public final class TelemetryListener implements Listener {

    private final JavaPlugin plugin;
    private final TelemetryService telemetry;

    public TelemetryListener(JavaPlugin plugin, TelemetryService telemetry) {
        this.plugin = plugin;
        this.telemetry = telemetry;
    }

    @EventHandler(priority = EventPriority.MONITOR)
    public void onJoin(PlayerJoinEvent event) {
        safely(() -> {
            Player player = event.getPlayer();
            telemetry.recordJoin(player.getName());
            telemetry.observeRegion(player.getName(), regionOf(player.getWorld()));
        });
    }

    @EventHandler(priority = EventPriority.MONITOR)
    public void onQuit(PlayerQuitEvent event) {
        safely(() -> telemetry.recordLeave(event.getPlayer().getName()));
    }

    @EventHandler(priority = EventPriority.MONITOR)
    public void onDeath(PlayerDeathEvent event) {
        safely(() -> {
            Player player = event.getEntity();
            telemetry.recordDeath(player.getName(), regionOf(player.getWorld()), causeOf(player));
        });
    }

    @EventHandler(priority = EventPriority.MONITOR, ignoreCancelled = true)
    public void onBlockPlace(BlockPlaceEvent event) {
        safely(() -> {
            Player player = event.getPlayer();
            telemetry.recordBlockPlaced(
                    player.getName(),
                    regionOf(event.getBlock().getWorld()),
                    event.getBlock().getType().getKey().getKey());
        });
    }

    @EventHandler(priority = EventPriority.MONITOR, ignoreCancelled = true)
    public void onBlockBreak(BlockBreakEvent event) {
        safely(() -> {
            Player player = event.getPlayer();
            telemetry.recordBlockBroken(
                    player.getName(),
                    regionOf(event.getBlock().getWorld()),
                    event.getBlock().getType().getKey().getKey());
        });
    }

    /**
     * Chat, counted.
     *
     * Fires on Paper's chat thread, which is why the counter behind this is
     * synchronized. Note the single call: the name, and nothing else.
     */
    @EventHandler(priority = EventPriority.MONITOR, ignoreCancelled = true)
    public void onChat(AsyncChatEvent event) {
        safely(() -> telemetry.recordChat(event.getPlayer().getName()));
    }

    /**
     * Sample where everybody is. Main thread only.
     *
     * Reading a player's world off the main thread is not safe, so this is
     * scheduled as a synchronous task in PluginMain. It does no I/O: it updates
     * an in-memory tracker that the shipping thread drains later, so the cost on
     * the tick is one map lookup per online player.
     */
    public void sampleRegions() {
        safely(() -> {
            for (Player player : plugin.getServer().getOnlinePlayers()) {
                telemetry.observeRegion(player.getName(), regionOf(player.getWorld()));
            }
        });
    }

    private String regionOf(World world) {
        return world == null ? null : telemetry.regionFor(world.getName());
    }

    /**
     * What killed the player, as the rollup's subject.
     *
     * The killer's entity type when there was one, otherwise the damage cause,
     * both lowercased into the same snake_case shape the rest of the vocabulary
     * uses. Never the death message: that is assembled from player-authored
     * text and is exactly the kind of string this emitter does not carry.
     */
    private static String causeOf(Player player) {
        EntityDamageEvent damage = player.getLastDamageCause();
        if (damage == null) {
            return null;
        }
        if (damage instanceof EntityDamageByEntityEvent byEntity && byEntity.getDamager() != null) {
            return byEntity.getDamager().getType().getKey().getKey();
        }
        return damage.getCause().name().toLowerCase(Locale.ROOT);
    }

    private void safely(Runnable action) {
        try {
            action.run();
        } catch (Throwable ignored) {
            // Deliberately total. The one rule this component has is that a
            // world keeps playing normally, and an emitter that lets anything
            // through has already broken it.
        }
    }
}
