package com.farlands;

import org.bukkit.plugin.java.JavaPlugin;

import com.farlands.listeners.JoinListener;
import com.farlands.listeners.QuitListener;
import com.farlands.listeners.ActionListener;
import com.farlands.telemetry.TelemetryListener;
import com.farlands.telemetry.TelemetryService;

public class PluginMain extends JavaPlugin {

    private TelemetryService telemetry;

    @Override
    public void onEnable() {
        saveDefaultConfig();

        getServer().getPluginManager().registerEvents(
            new JoinListener(this),
            this
        );

        getServer().getPluginManager().registerEvents(
            new QuitListener(this),
            this
        );

        getServer().getPluginManager().registerEvents(
            new ActionListener(this),
            this
        );

        enableTelemetry();

        getLogger().info("Farlands Plugin Enabled");
    }

    @Override
    public void onDisable() {
        if (telemetry != null) {
            telemetry.close();
        }

        getLogger().info("Farlands Plugin Disabled");
    }

    /**
     * Telemetry is off unless config.yml carries a server id, so a JAR built or
     * run outside a deployment registers nothing and costs nothing.
     */
    private void enableTelemetry() {
        telemetry = TelemetryService.create(this);

        if (!telemetry.isEnabled()) {
            return;
        }

        telemetry.start();

        TelemetryListener listener = new TelemetryListener(this, telemetry);

        getServer().getPluginManager().registerEvents(
            listener,
            this
        );

        // Region sampling reads player locations, which is only safe on the main
        // thread. The task itself does no I/O: it touches an in-memory tracker
        // that the emitter's own thread drains later.
        long period = telemetry.config().regionSampleTicks();

        getServer().getScheduler().runTaskTimer(
            this,
            listener::sampleRegions,
            period,
            period
        );
    }
}
