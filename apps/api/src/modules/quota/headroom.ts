const reservations = new Map<string, { userId: string; serverId: string }>();

export async function reserveDeploymentHeadroom(
  userId: string,
  serverId: string,
  deploymentId: string,
): Promise<void> {
  reservations.set(deploymentId, { userId, serverId });
}

export async function releaseDeploymentHeadroom(deploymentId: string): Promise<void> {
  reservations.delete(deploymentId);
}

export function headroomHeldByUser(userId: string): number {
  let n = 0;
  for (const row of reservations.values()) {
    if (row.userId === userId) n += 1;
  }
  return n;
}
