import type { PrismaClient } from '../../generated/prisma/client.js';
import type {
  IValueRealizationRepository,
  ValueRealizationFilters,
  ValueRealizationDestinationSummary,
  ValueRealizationItemsPage,
  ValueRealizationReconciliationCandidate,
  ValueRealizationSummary,
  ValueRealizationTrendPoint,
  ValueRealizationItem,
} from '../../domain/interfaces/IValueRealizationRepository.js';
import { PrismaValueRealizationAllocationRepository } from './PrismaValueRealizationAllocationRepository.js';
import { PrismaValueRealizationPortfolioRepository } from './PrismaValueRealizationPortfolioRepository.js';

export class PrismaValueRealizationRepository implements IValueRealizationRepository {
  private readonly portfolio: PrismaValueRealizationPortfolioRepository;
  private readonly allocation: PrismaValueRealizationAllocationRepository;

  constructor(prisma: PrismaClient) {
    this.portfolio = new PrismaValueRealizationPortfolioRepository(prisma);
    this.allocation = new PrismaValueRealizationAllocationRepository(prisma);
  }

  public getSummary(filters: ValueRealizationFilters): Promise<ValueRealizationSummary> {
    return this.portfolio.getSummary(filters);
  }

  public listItems(filters: ValueRealizationFilters): Promise<ValueRealizationItemsPage> {
    return this.portfolio.listItems(filters);
  }

  public listItemsForExport(filters: ValueRealizationFilters): Promise<readonly ValueRealizationItem[]> {
    return this.portfolio.listItemsForExport(filters);
  }

  public listTrend(filters: ValueRealizationFilters): Promise<readonly ValueRealizationTrendPoint[]> {
    return this.portfolio.listTrend(filters);
  }

  public listDestinationSummary(input: { readonly tenantId: string; readonly period: Date; readonly currency?: string }): Promise<readonly ValueRealizationDestinationSummary[]> {
    return this.allocation.listDestinationSummary(input);
  }

  public listReconciliationCandidates(input: { readonly tenantId: string; readonly limit: number }): Promise<readonly ValueRealizationReconciliationCandidate[]> {
    return this.allocation.listReconciliationCandidates(input);
  }
}
