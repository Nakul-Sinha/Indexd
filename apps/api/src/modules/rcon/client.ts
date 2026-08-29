import { createConnection, type Socket } from "node:net";

const RCON_PORT = 25575;

function encode(id: number, type: number, body: string): Buffer {
  const payload = Buffer.alloc(4 + 4 + Buffer.byteLength(body) + 2);
  payload.writeInt32LE(id, 0);
  payload.writeInt32LE(type, 4);
  payload.write(body, 8, "utf8");
  const frame = Buffer.alloc(4 + payload.length);
  frame.writeInt32LE(payload.length, 0);
  payload.copy(frame, 4);
  return frame;
}

function readPacket(socket: Socket): Promise<{ id: number; type: number; body: string }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let needed: number | null = null;

    const onData = (data: Buffer) => {
      chunks.push(data);
      const buf = Buffer.concat(chunks);
      if (needed === null) {
        if (buf.length < 4) return;
        needed = buf.readInt32LE(0);
      }
      if (buf.length >= 4 + needed) {
        socket.off("data", onData);
        socket.off("error", onError);
        const id = buf.readInt32LE(4);
        const type = buf.readInt32LE(8);
        const body = buf.slice(12, 4 + needed - 2).toString("utf8");
        resolve({ id, type, body });
      }
    };
    const onError = (err: Error) => {
      socket.off("data", onData);
      reject(err);
    };
    socket.on("data", onData);
    socket.on("error", onError);
  });
}

export type RconClient = {
  send(command: string): Promise<string>;
  close(): void;
};

/**
 * Minecraft RCON. Callers must issue freeze commands in this order:
 * save-off -> save-all flush -> (delta) -> save-on.
 */
export async function connectRcon(opts: {
  host: string;
  port?: number;
  password: string;
}): Promise<RconClient> {
  const socket = await new Promise<Socket>((resolve, reject) => {
    const s = createConnection({ host: opts.host, port: opts.port ?? RCON_PORT }, () => resolve(s));
    s.on("error", reject);
  });

  let nextId = 1;
  socket.write(encode(nextId, 3, opts.password));
  const auth = await readPacket(socket);
  if (auth.id === -1) {
    socket.destroy();
    throw new Error("RCON authentication failed");
  }

  return {
    async send(command: string) {
      const id = ++nextId;
      socket.write(encode(id, 2, command));
      const res = await readPacket(socket);
      if (res.id !== id) {
        throw new Error(`RCON id mismatch: expected ${id} got ${res.id}`);
      }
      return res.body;
    },
    close() {
      socket.end();
    },
  };
}

export const FREEZE_COMMANDS = ["save-off", "save-all flush", "save-on"] as const;

export async function runFreezeSequence(
  client: RconClient,
  delta: () => Promise<void>,
): Promise<void> {
  await client.send("save-off");
  await client.send("save-all flush");
  await delta();
  await client.send("save-on");
}
