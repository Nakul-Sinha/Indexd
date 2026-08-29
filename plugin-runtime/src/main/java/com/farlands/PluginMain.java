package com.farlands;

import org.bukkit.plugin.java.JavaPlugin;

import com.farlands.listeners.JoinListener;
import com.farlands.listeners.QuitListener;
import com.farlands.listeners.ActionListener;

public class PluginMain extends JavaPlugin {

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

        getLogger().info("Farlands Plugin Enabled");
    }

    @Override
    public void onDisable() {
        getLogger().info("Farlands Plugin Disabled");
    }
}