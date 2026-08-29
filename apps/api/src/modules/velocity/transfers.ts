import { randomUUID } from "node:crypto";
import type { VelocityTransfer, VelocityTransferAck } from "@farlands/contracts";

type TransferRow = VelocityTransfer & {
  ack: VelocityTransferAck | null;
};

const transfers = new Map<string, TransferRow>();

export async function issueTransfer(input: {
  fromRoute: string;
  toRoute: string;
  message: string;
}): Promise<string> {
  const transferId = randomUUID();
  transfers.set(transferId, {
    transferId,
    fromRoute: input.fromRoute,
    toRoute: input.toRoute,
    message: input.message,
    ack: null,
  });
  return transferId;
}

export function listPendingTransfers(): VelocityTransfer[] {
  return [...transfers.values()]
    .filter((row) => row.ack === null)
    .map(({ ack: _a, ...rest }) => rest);
}

export function ackTransfer(id: string, ack: VelocityTransferAck): VelocityTransferAck {
  const row = transfers.get(id);
  if (!row) throw new Error("Unknown transfer");
  row.ack = ack;
  return ack;
}

export async function waitForAck(id: string, timeoutMs = 60_000): Promise<VelocityTransferAck> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const row = transfers.get(id);
    if (row?.ack) return row.ack;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Timed out waiting for transfer ack ${id}`);
}
