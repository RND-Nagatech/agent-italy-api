export interface SalesReportQuery {
  from: string;
  to: string;
  branchId?: string;
  jenisCode?: string;
}

export interface SalesReportJenis {
  code: string;
  name: string;
  invoiceCount: number;
  detailCount: number;
  soldWeight: number;
  salesAmount: number;
  rowsWithoutWeight: number;
  sharePercent: number;
}

export interface SalesReportBranch {
  branchId: string;
  alias: string;
  status: 'available' | 'unavailable';
  unavailableReason?: string;
  invoiceCount: number;
  detailCount: number;
  soldWeight: number;
  salesAmount: number;
  rowsWithoutWeight: number;
  jenis: SalesReportJenis[];
  omittedJenisCount: number;
}

export interface SalesReportResult {
  mode: 'sales-period-report';
  period: {
    from: string;
    to: string;
    field: 'tgl_system';
    daysInclusive: number;
  };
  weightUnit: 'gram';
  policy: {
    salesFilter: 'status_kembali=OPEN, status_valid=DONE, status_tukar!=true, trs_barang_tukar!=true';
    weight: 'Jumlah field berat per baris transaksi, dalam gram';
  };
  summary: {
    branchesRequested: number;
    branchesAnalyzed: number;
    branchesUnavailable: number;
    invoiceCount: number;
    detailCount: number;
    soldWeight: number;
    salesAmount: number;
    rowsWithoutWeight: number;
  };
  branches: SalesReportBranch[];
  unavailableSources: Array<{ branchId: string; alias: string; reason: string }>;
}
