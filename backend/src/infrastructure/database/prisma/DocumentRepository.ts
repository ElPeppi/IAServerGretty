import { Prisma } from '@prisma/client';
import { prisma } from './client';
import { Document, DocumentWithLawyer } from '../../../domain/entities/Document';
import {
  IDocumentRepository,
  CreateDocumentDTO,
  UpdateDocumentDTO,
  DocumentFilters,
  PaginatedDocuments,
  DashboardStats,
} from '../../../domain/repositories/IDocumentRepository';
import { startOfDay, startOfWeek, startOfMonth, subDays, format } from 'date-fns';
import { es } from 'date-fns/locale';

export class PrismaDocumentRepository implements IDocumentRepository {
  async findById(id: string): Promise<DocumentWithLawyer | null> {
    const doc = await prisma.document.findUnique({
      where: { id },
      include: {
        lawyer: { select: { id: true, name: true, email: true, signatureUrl: true } },
      },
    });
    return doc as DocumentWithLawyer | null;
  }

  async findAll(filters?: DocumentFilters): Promise<PaginatedDocuments> {
    const where: Prisma.DocumentWhereInput = {
      ...(filters?.lawyerId && { lawyerId: filters.lawyerId }),
      ...(filters?.status && { status: filters.status }),
      ...((filters?.from || filters?.to) && {
        createdAt: {
          ...(filters?.from && { gte: filters.from }),
          ...(filters?.to && { lte: filters.to }),
        },
      }),
      ...(filters?.search && {
        OR: [
          { clientName: { contains: filters.search, mode: 'insensitive' } },
          { clientCedula: { contains: filters.search, mode: 'insensitive' } },
          { title: { contains: filters.search, mode: 'insensitive' } },
          { clientRfc: { contains: filters.search, mode: 'insensitive' } },
        ],
      }),
    };

    const page = Math.max(1, filters?.page ?? 1);
    const pageSize = Math.min(100, Math.max(1, filters?.pageSize ?? 24));

    // Dos LECTURAS para paginar: NO necesitan atomicidad. Usar $transaction aquí
    // abría una transacción real que, bajo ráfaga (cada demanda generada 1-a-1
    // dispara refetch + los writes de persistirDemanda), agotaba el pool y fallaba
    // con "Unable to start a transaction in the given time". Promise.all corre las
    // dos queries en paralelo sin transacción → sin ese error.
    const [items, total] = await Promise.all([
      prisma.document.findMany({
        where,
        include: {
          lawyer: { select: { id: true, name: true, email: true, signatureUrl: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.document.count({ where }),
    ]);

    return { items: items as DocumentWithLawyer[], total };
  }

  async create(data: CreateDocumentDTO): Promise<Document> {
    const { metadata, notes, ...rest } = data;
    return prisma.document.create({
      data: {
        ...rest,
        ...(metadata !== undefined && { metadata: metadata as Prisma.InputJsonValue }),
        ...(notes !== undefined && { notes: notes as unknown as Prisma.InputJsonValue }),
      },
    }) as Promise<Document>;
  }

  async update(id: string, data: UpdateDocumentDTO): Promise<Document> {
    const { notes, ...rest } = data;
    return prisma.document.update({
      where: { id },
      data: {
        ...rest,
        ...(notes !== undefined && { notes: notes as unknown as Prisma.InputJsonValue }),
      },
    }) as Promise<Document>;
  }

  async getDashboardStats(lawyerId?: string): Promise<DashboardStats> {
    const where = lawyerId ? { lawyerId } : {};
    const now = new Date();
    const todayStart = startOfDay(now);
    const weekStart = startOfWeek(now, { weekStartsOn: 1 });
    const monthStart = startOfMonth(now);

    const [total, today, thisWeek, thisMonth, byStatusRaw, allDocs] = await Promise.all([
      prisma.document.count({ where }),
      prisma.document.count({ where: { ...where, createdAt: { gte: todayStart } } }),
      prisma.document.count({ where: { ...where, createdAt: { gte: weekStart } } }),
      prisma.document.count({ where: { ...where, createdAt: { gte: monthStart } } }),
      prisma.document.groupBy({ by: ['status'], where, _count: true }),
      prisma.document.findMany({
        where: { ...where, createdAt: { gte: subDays(now, 29) } },
        select: { createdAt: true },
      }),
    ]);

    const byStatus = {
      PENDING: 0,
      GENERATED: 0,
      SIGNED: 0,
      REJECTED: 0,
      ...Object.fromEntries(byStatusRaw.map((r) => [r.status, r._count])),
    } as DashboardStats['byStatus'];

    // Build daily counts for last 30 days
    const dayMap = new Map<string, number>();
    for (let i = 29; i >= 0; i--) {
      const d = subDays(now, i);
      dayMap.set(format(d, 'yyyy-MM-dd'), 0);
    }
    for (const doc of allDocs) {
      const key = format(doc.createdAt, 'yyyy-MM-dd');
      if (dayMap.has(key)) dayMap.set(key, (dayMap.get(key) ?? 0) + 1);
    }
    const byDay = Array.from(dayMap.entries()).map(([date, count]) => ({ date, count }));

    // Weekly (last 12 weeks)
    const weekMap = new Map<string, number>();
    const weeklyDocs = await prisma.document.findMany({
      where: { ...where, createdAt: { gte: subDays(now, 83) } },
      select: { createdAt: true },
    });
    for (const doc of weeklyDocs) {
      const key = format(startOfWeek(doc.createdAt, { weekStartsOn: 1 }), 'yyyy-MM-dd');
      weekMap.set(key, (weekMap.get(key) ?? 0) + 1);
    }
    const byWeek = Array.from(weekMap.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([week, count]) => ({ week, count }));

    // Monthly (last 12 months)
    const monthMap = new Map<string, number>();
    const monthlyDocs = await prisma.document.findMany({
      where: { ...where, createdAt: { gte: subDays(now, 365) } },
      select: { createdAt: true },
    });
    for (const doc of monthlyDocs) {
      const key = format(doc.createdAt, 'yyyy-MM', { locale: es });
      monthMap.set(key, (monthMap.get(key) ?? 0) + 1);
    }
    const byMonth = Array.from(monthMap.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([month, count]) => ({ month, count }));

    return {
      totalDocuments: total,
      generatedToday: today,
      generatedThisWeek: thisWeek,
      generatedThisMonth: thisMonth,
      byStatus,
      byDay,
      byWeek,
      byMonth,
    };
  }
}
