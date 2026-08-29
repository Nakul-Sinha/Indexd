/**
 * Structural invariant: pod A is untouchable until cutover.
 * Destructive operations on A exist only on the draining client.
 */
export class AuthClient {
  constructor(private readonly phase: "pre-cutover" | "draining") {}

  assertCannotTouchA(): void {
    if (this.phase !== "pre-cutover") {
      throw new Error("pre-cutover client used after cutover");
    }
  }

  stopA(): never {
    throw new Error("INVARIANT: refusing to stop/unmount/modify pod A before cutover");
  }

  deleteA(): never {
    throw new Error("INVARIANT: refusing to delete pod A before cutover");
  }

  assertCanRetireA(): void {
    if (this.phase !== "draining") {
      throw new Error("INVARIANT: retiring A is only legal in draining");
    }
  }
}
