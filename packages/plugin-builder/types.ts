export type PluginBuilderBody = {
  metadata?: {
    pluginName?: string;
    minecraftVersion?: string;
  };
  onPlayerJoin?: {
    privateMessage?: string;
    broadcastMessage?: string;
    startingItems?: StartingItem[];
    potionEffects?: PotionEffect[];
  };
  onPlayerQuit?: {
    broadcastMessage?: string;
  };
  onPlayerAction?: {
    triggerAction?: string;
    achievement?: {
      title?: string;
      description?: string;
      soundEffect?: string;
    };
  };
};

export type StartingItem = {
  material: string;
  amount: number;
};

export type PotionEffect = {
  type: string;
  durationTicks: number;
  amplifier: number;
};
