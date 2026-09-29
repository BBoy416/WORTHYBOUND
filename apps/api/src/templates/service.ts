import {
  type AssetCategory,
  isDatabaseError,
  type Prisma,
  type PrismaClient,
  type VerificationTemplateVersion,
} from "@worthybound/database";
import { assertTransition, TEMPLATE_VERSION_LIFECYCLE } from "@worthybound/shared";
import type {
  TemplateCreateInput,
  TemplateRequirementsInput,
  TemplateVersionStatusInput,
} from "@worthybound/validation";
import { writeAudit } from "../audit.js";
import type { Actor } from "../assets/service.js";
import { ApiError, fromDomainError, notFound } from "../errors.js";
import { closeRequestsAsSystem } from "../verification/requests.js";

type Tx = Prisma.TransactionClient;

export interface TemplateServiceOptions {
  prisma: PrismaClient;
  now: () => Date;
}

const UNIQUE_VIOLATION = "23505";
const isUniqueViolation = (error: unknown) =>
  isDatabaseError(error, UNIQUE_VIOLATION) || (error as { code?: string })?.code === "P2002";

const withVersions = {
  versions: { orderBy: { version: "asc" as const } },
} satisfies Prisma.VerificationTemplateInclude;

export function createTemplateService({ prisma, now }: TemplateServiceOptions) {
  /** Retires a published version and cancels the requests still open against it. */
  async function retire(tx: Tx, version: VerificationTemplateVersion, actor: Actor, at: Date) {
    await tx.verificationTemplateVersion.update({
      where: { id: version.id },
      data: { status: "RETIRED" },
    });
    await closeRequestsAsSystem(
      tx,
      { templateVersionId: version.id },
      "CANCELLED",
      "template_retired",
      at,
    );
    await writeAudit(
      tx,
      {
        actorId: actor.userId,
        action: "template.version_retired",
        targetType: "template_version",
        targetId: version.id,
        metadata: { templateId: version.templateId, version: version.version },
      },
      actor.fp,
    );
  }

  return {
    async list() {
      return prisma.verificationTemplate.findMany({
        include: withVersions,
        orderBy: [{ category: "asc" }, { code: "asc" }],
      });
    },

    async create(input: TemplateCreateInput, actor: Actor) {
      try {
        return await prisma.$transaction(async (tx) => {
          const at = now();
          const template = await tx.verificationTemplate.create({
            data: {
              code: input.code,
              category: input.category,
              name: input.name,
              description: input.description ?? null,
              createdAt: at,
              updatedAt: at,
            },
            include: withVersions,
          });
          await writeAudit(
            tx,
            {
              actorId: actor.userId,
              action: "template.created",
              targetType: "template",
              targetId: template.id,
              metadata: { code: input.code, category: input.category },
            },
            actor.fp,
          );
          return template;
        });
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new ApiError(409, "template_code_taken", "A template with this code exists");
        }
        throw error;
      }
    },

    /** Adds a draft version numbered after the template's latest version. */
    async createVersion(templateId: string, input: TemplateRequirementsInput, actor: Actor) {
      return prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT 1 FROM "verification_templates" WHERE "id" = ${templateId}::uuid FOR UPDATE`;
        const template = await tx.verificationTemplate.findUnique({
          where: { id: templateId },
          include: withVersions,
        });
        if (!template) throw notFound("Template");
        const at = now();
        const version = await tx.verificationTemplateVersion.create({
          data: {
            templateId,
            version: (template.versions.at(-1)?.version ?? 0) + 1,
            requiredClaims: input.requiredClaims,
            requiredEvidence: input.requiredEvidence,
            allowedMethods: input.allowedMethods,
            minVerifiers: input.minVerifiers,
            createdById: actor.userId,
            createdAt: at,
          },
        });
        await writeAudit(
          tx,
          {
            actorId: actor.userId,
            action: "template.version_created",
            targetType: "template_version",
            targetId: version.id,
            metadata: { templateId, version: version.version },
          },
          actor.fp,
        );
        return version;
      });
    },

    /**
     * Publishes a draft (by an administrator other than its creator), retiring the template's
     * previously published version, or retires a published version. Requests still open against
     * a retired version are cancelled.
     */
    async changeVersionStatus(versionId: string, input: TemplateVersionStatusInput, actor: Actor) {
      return prisma.$transaction(async (tx) => {
        const found = await tx.verificationTemplateVersion.findUnique({
          where: { id: versionId },
          select: { templateId: true },
        });
        if (!found) throw notFound("Template version");
        await tx.$queryRaw`SELECT 1 FROM "verification_templates" WHERE "id" = ${found.templateId}::uuid FOR UPDATE`;
        const version = await tx.verificationTemplateVersion.findUniqueOrThrow({
          where: { id: versionId },
        });
        try {
          assertTransition(TEMPLATE_VERSION_LIFECYCLE, version.status, input.status, "ADMIN");
        } catch (error) {
          throw fromDomainError(error);
        }
        const at = now();
        if (input.status === "RETIRED") {
          await retire(tx, version, actor, at);
        } else {
          if (version.createdById === actor.userId) {
            throw new ApiError(
              403,
              "four_eyes",
              "A template version must be published by an administrator other than its creator",
            );
          }
          const current = await tx.verificationTemplateVersion.findFirst({
            where: { templateId: version.templateId, status: "PUBLISHED" },
          });
          if (current) await retire(tx, current, actor, at);
          await tx.verificationTemplateVersion.update({
            where: { id: versionId },
            data: { status: "PUBLISHED", publishedAt: at, publishedById: actor.userId },
          });
          await writeAudit(
            tx,
            {
              actorId: actor.userId,
              action: "template.version_published",
              targetType: "template_version",
              targetId: versionId,
              metadata: { templateId: version.templateId, version: version.version },
            },
            actor.fp,
          );
        }
        return tx.verificationTemplateVersion.findUniqueOrThrow({ where: { id: versionId } });
      });
    },

    /** Published versions, which owners can request verification against. */
    async published(category?: AssetCategory) {
      return prisma.verificationTemplateVersion.findMany({
        where: { status: "PUBLISHED", ...(category ? { template: { category } } : {}) },
        include: { template: true },
        orderBy: [{ template: { category: "asc" } }, { template: { code: "asc" } }],
      });
    },
  };
}

export type TemplateService = ReturnType<typeof createTemplateService>;
