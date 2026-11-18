import { ShipmentPeriod } from '../shipments/shipment.types';

export interface SalesBranchSummary {
  branchId: string;
  alias: string;
  invoiceCount: number;
  detailCount: number;
  quantity: number;
  totalWeight: number;
  salesAmount: number;
}

export interface SalesSummaryResult {
  period: ShipmentPeriod;
  dateFrom: string | null;
  dateTo: string | null;
  statusValid: 'DONE';
  totals: {
    branchCount: number;
    invoiceCount: number;
    detailCount: number;
    quantity: number;
    totalWeight: number;
    salesAmount: number;
  };
  branches: SalesBranchSummary[];
}
