import pg from "pg";

// Explicit confirmation prevents this demo-only script from running accidentally.
if (process.env.CONFIRM_DEV_SEED !== "farlands_dev") {
  throw new Error("Set CONFIRM_DEV_SEED=farlands_dev to run this demo seed");
}

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is required");
}

const userEmail = process.env.SEED_USER_EMAIL?.trim().toLowerCase();
if (!userEmail) {
  throw new Error("SEED_USER_EMAIL is required");
}

const client = new pg.Client({ connectionString });
await client.connect();

try {
  await client.query("BEGIN");

  // Demo servers attach to an existing authenticated user rather than creating auth data.
  const userResult = await client.query<{ id: string }>(
    "SELECT id FROM users WHERE lower(email) = $1 LIMIT 1",
    [userEmail],
  );
  const userId = userResult.rows[0]?.id;

  if (!userId) {
    throw new Error(`No user found for ${userEmail}`);
  }

  const userSuffix = userId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 8);

  // Deterministic records exercise server, configuration, and routing API fields.
  const demoServers = [
    {
      id: `demo-minecraft-${userSuffix}`,
      name: "Demo Minecraft SMP",
      game: "minecraft",
      currentState: "running",
      desiredState: "running",
      statusMessage: "Demo server is ready",
      version: "1.21.1",
      cpuCores: "1",
      ramMb: 2048,
      storageGb: 5,
      storageClass: "farlands-gp3",
      hostname: `minecraft-${userSuffix}.demo.farlands.test`,
      proxyTarget: "minecraft-smp-local:25565",
      ip: "127.0.0.1",
      port: 25565,
    },
    {
      id: `demo-rust-${userSuffix}`,
      name: "Demo Rust Sandbox",
      game: "rust",
      currentState: "stopped",
      desiredState: "stopped",
      statusMessage: "Demo server is intentionally stopped",
      version: "latest",
      cpuCores: "2",
      ramMb: 4096,
      storageGb: 10,
      storageClass: "farlands-gp3",
      hostname: `rust-${userSuffix}.demo.farlands.test`,
      proxyTarget: "rust-demo:28015",
      ip: "127.0.0.1",
      port: 28015,
    },
  ] as const;

  for (const server of demoServers) {
    await client.query(
      `INSERT INTO game_servers
        (id, name, user_id, game, current_state, desired_state, status_message)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (id) DO UPDATE SET
         name = excluded.name,
         user_id = excluded.user_id,
         game = excluded.game,
         current_state = excluded.current_state,
         desired_state = excluded.desired_state,
         status_message = excluded.status_message,
         updated_at = now()`,
      [
        server.id,
        server.name,
        userId,
        server.game,
        server.currentState,
        server.desiredState,
        server.statusMessage,
      ],
    );

    await client.query(
      `INSERT INTO server_configs
        (id, server_id, version, game_config_json, cpu_cores, ram_mb, storage_gb, storage_class)
       VALUES ($1, $2, $3, '{}'::jsonb, $4, $5, $6, $7)
       ON CONFLICT (server_id) DO UPDATE SET
         version = excluded.version,
         cpu_cores = excluded.cpu_cores,
         ram_mb = excluded.ram_mb,
         storage_gb = excluded.storage_gb,
         storage_class = excluded.storage_class,
         updated_at = now()`,
      [
        `config-${server.id}`,
        server.id,
        server.version,
        server.cpuCores,
        server.ramMb,
        server.storageGb,
        server.storageClass,
      ],
    );

    await client.query(
      `INSERT INTO server_routes
        (id, server_id, hostname, proxy_target, ip, port)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (server_id) DO UPDATE SET
         hostname = excluded.hostname,
         proxy_target = excluded.proxy_target,
         ip = excluded.ip,
         port = excluded.port,
         updated_at = now()`,
      [
        `route-${server.id}`,
        server.id,
        server.hostname,
        server.proxyTarget,
        server.ip,
        server.port,
      ],
    );
  }

  await client.query("COMMIT");
  console.log(`Seeded ${demoServers.length} demo servers for ${userEmail}`);
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  await client.end();
}
