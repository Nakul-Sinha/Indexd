import { serverRules } from "@repo/db";
import { and, eq } from "drizzle-orm";
import { status } from "elysia";
import { db } from "../../db";
import { type RuleCreateInput, type RuleUpdateInput, ruleDto } from "./model";

export abstract class RulesService {
  static async create(userId: string, data: RuleCreateInput) {
    data = ruleDto.parse(data);
    const [newRule] = await db
      .insert(serverRules)
      .values({
        id: crypto.randomUUID(),
        createdBy: userId,
        ...data,
      })
      .returning();

    return newRule;
  }

  static async getAllByUser(userId: string) {
    return await db.select().from(serverRules).where(eq(serverRules.createdBy, userId));
  }

  static async update(id: string, userId: string, data: RuleUpdateInput) {
    data = ruleDto.partial().parse(data);
    const [updatedRule] = await db
      .update(serverRules)
      .set({ ...data, updatedAt: new Date() })
      .where(and(eq(serverRules.id, id), eq(serverRules.createdBy, userId)))
      .returning();

    if (!updatedRule) throw status(404, "Rule not found");
    return updatedRule;
  }

  static async delete(id: string, userId: string) {
    const [deletedRule] = await db
      .delete(serverRules)
      .where(and(eq(serverRules.id, id), eq(serverRules.createdBy, userId)))
      .returning();

    if (!deletedRule) throw status(404, "Rule not found");
    return deletedRule;
  }
}
