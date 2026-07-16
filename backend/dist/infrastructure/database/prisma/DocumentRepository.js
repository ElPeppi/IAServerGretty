"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PrismaDocumentRepository = void 0;
const client_1 = require("./client");
const date_fns_1 = require("date-fns");
const locale_1 = require("date-fns/locale");
class PrismaDocumentRepository {
    async findById(id) {
        const doc = await client_1.prisma.document.findUnique({
            where: { id },
            include: {
                lawyer: { select: { id: true, name: true, email: true, signatureUrl: true } },
            },
        });
        return doc;
    }
    async findAll(filters) {
        const where = {
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
        const [items, total] = await client_1.prisma.$transaction([
            client_1.prisma.document.findMany({
                where,
                include: {
                    lawyer: { select: { id: true, name: true, email: true, signatureUrl: true } },
                },
                orderBy: { createdAt: 'desc' },
                skip: (page - 1) * pageSize,
                take: pageSize,
            }),
            client_1.prisma.document.count({ where }),
        ]);
        return { items: items, total };
    }
    async create(data) {
        const { metadata, notes, ...rest } = data;
        return client_1.prisma.document.create({
            data: {
                ...rest,
                ...(metadata !== undefined && { metadata: metadata }),
                ...(notes !== undefined && { notes: notes }),
            },
        });
    }
    async update(id, data) {
        const { notes, ...rest } = data;
        return client_1.prisma.document.update({
            where: { id },
            data: {
                ...rest,
                ...(notes !== undefined && { notes: notes }),
            },
        });
    }
    async getDashboardStats(lawyerId) {
        const where = lawyerId ? { lawyerId } : {};
        const now = new Date();
        const todayStart = (0, date_fns_1.startOfDay)(now);
        const weekStart = (0, date_fns_1.startOfWeek)(now, { weekStartsOn: 1 });
        const monthStart = (0, date_fns_1.startOfMonth)(now);
        const [total, today, thisWeek, thisMonth, byStatusRaw, allDocs] = await Promise.all([
            client_1.prisma.document.count({ where }),
            client_1.prisma.document.count({ where: { ...where, createdAt: { gte: todayStart } } }),
            client_1.prisma.document.count({ where: { ...where, createdAt: { gte: weekStart } } }),
            client_1.prisma.document.count({ where: { ...where, createdAt: { gte: monthStart } } }),
            client_1.prisma.document.groupBy({ by: ['status'], where, _count: true }),
            client_1.prisma.document.findMany({
                where: { ...where, createdAt: { gte: (0, date_fns_1.subDays)(now, 29) } },
                select: { createdAt: true },
            }),
        ]);
        const byStatus = {
            PENDING: 0,
            GENERATED: 0,
            SIGNED: 0,
            REJECTED: 0,
            ...Object.fromEntries(byStatusRaw.map((r) => [r.status, r._count])),
        };
        // Build daily counts for last 30 days
        const dayMap = new Map();
        for (let i = 29; i >= 0; i--) {
            const d = (0, date_fns_1.subDays)(now, i);
            dayMap.set((0, date_fns_1.format)(d, 'yyyy-MM-dd'), 0);
        }
        for (const doc of allDocs) {
            const key = (0, date_fns_1.format)(doc.createdAt, 'yyyy-MM-dd');
            if (dayMap.has(key))
                dayMap.set(key, (dayMap.get(key) ?? 0) + 1);
        }
        const byDay = Array.from(dayMap.entries()).map(([date, count]) => ({ date, count }));
        // Weekly (last 12 weeks)
        const weekMap = new Map();
        const weeklyDocs = await client_1.prisma.document.findMany({
            where: { ...where, createdAt: { gte: (0, date_fns_1.subDays)(now, 83) } },
            select: { createdAt: true },
        });
        for (const doc of weeklyDocs) {
            const key = (0, date_fns_1.format)((0, date_fns_1.startOfWeek)(doc.createdAt, { weekStartsOn: 1 }), 'yyyy-MM-dd');
            weekMap.set(key, (weekMap.get(key) ?? 0) + 1);
        }
        const byWeek = Array.from(weekMap.entries())
            .sort((a, b) => a[0].localeCompare(b[0]))
            .map(([week, count]) => ({ week, count }));
        // Monthly (last 12 months)
        const monthMap = new Map();
        const monthlyDocs = await client_1.prisma.document.findMany({
            where: { ...where, createdAt: { gte: (0, date_fns_1.subDays)(now, 365) } },
            select: { createdAt: true },
        });
        for (const doc of monthlyDocs) {
            const key = (0, date_fns_1.format)(doc.createdAt, 'yyyy-MM', { locale: locale_1.es });
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
exports.PrismaDocumentRepository = PrismaDocumentRepository;
//# sourceMappingURL=DocumentRepository.js.map