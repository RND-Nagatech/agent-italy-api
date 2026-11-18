export interface StockVsSalesJenisRow {
  kode: string;
  nama: string;
  physicalStockWeight: number;
  openIncomingWeight: number;
  availableWeight: number;
  soldWeightMonth: number;
  soldLinesMonth: number;
  salesLinesWithoutWeight: number;
  stockRecordsWithoutWeight: number;
  openShipmentLinesWithoutWeight: number;
  averageSalesWeightPerDay: number;
  coverageDays: number | null;
  status: 'restock-review' | 'incoming' | 'healthy' | 'no-sales' | 'no-activity' | 'weight-missing';
  recommendation: string;
}

export interface StockVsSalesBranchResult {
  branchId: string;
  alias: string;
  totals: {
    physicalStockWeight: number;
    openIncomingWeight: number;
    availableWeight: number;
    soldWeightMonth: number;
    salesLinesWithoutWeight: number;
    stockRecordsWithoutWeight: number;
    openShipmentLinesWithoutWeight: number;
    jenisWithSales: number;
    jenisWithNoSales: number;
    jenisWithIncompleteSalesWeight: number;
  };
  analysis: {
    topSellingJenis: Array<{
      kode: string;
      nama: string;
      soldWeightMonth: number;
      shareOfBranchWeightPercent: number;
    }>;
    lowCoverageWithSales: Array<{
      kode: string;
      nama: string;
      soldWeightMonth: number;
      availableWeight: number;
      coverageDays: number;
    }>;
    stockWithoutSales: Array<{ kode: string; nama: string; availableWeight: number }>;
    suggestions: string[];
  };
  jenis: StockVsSalesJenisRow[];
}

export interface StockVsSalesResult {
  period: {
    month: string;
    dateFrom: string;
    dateThrough: string;
    elapsedDays: number;
    safeStockDays: number;
    timezone: 'Asia/Jakarta';
  };
  policy: {
    stock: string;
    weight: string;
    openIncoming: string;
    sales: string;
    coverage: string;
  };
  totals: {
    branchCount: number;
    jenisCount: number;
    physicalStockWeight: number;
    openIncomingWeight: number;
    availableWeight: number;
    soldWeightMonth: number;
    salesLinesWithoutWeight: number;
    stockRecordsWithoutWeight: number;
    openShipmentLinesWithoutWeight: number;
    jenisWithSales: number;
    jenisWithNoSales: number;
    jenisWithIncompleteSalesWeight: number;
  };
  branches: StockVsSalesBranchResult[];
}
