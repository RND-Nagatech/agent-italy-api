export enum ShipmentStatus {
  Received = 'received',
  Pending = 'pending',
  Partial = 'partial',
  Review = 'review',
}

export enum ShipmentPeriod {
  ThisMonth = 'this-month',
  ThreeMonths = 'three-months',
  SixMonths = 'six-months',
  OneYear = 'one-year',
  All = 'all',
}

export interface ShipmentSummary {
  noKirim: string;
  destination: string | null;
  destinationMismatch: boolean;
  recordCount: number;
  receivedRecordCount: number;
  pendingRecordCount: number;
  unknownStatusRecordCount: number;
  totalWeight: number;
  status: ShipmentStatus;
  lastInputAt: Date | string | null;
}

export interface ShipmentItem {
  itemId: string;
  noKirim: string;
  destination: string | null;
  productCode: string | null;
  barcode: string | null;
  name: string | null;
  attribute: string | null;
  groupCode: string | null;
  departmentCode: string | null;
  color: string | null;
  receiptStatus: string | null;
  weight: number | null;
  inputDate: Date | string | null;
  receiveDate: Date | string | null;
}

export interface ShipmentListResult {
  items: ShipmentSummary[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  statusCounts: Record<ShipmentStatus, number>;
  inProcessByDestination: Array<{ destination: string; shipmentCount: number }>;
  debug?: {
    source: string;
    cacheStatus: 'hit' | 'miss' | 'coalesced';
    mongoRoundTripMs: number | null;
    serviceMs: number;
    page: number;
    pageSize: number;
    totalMatchingGroups: number;
    returnedItems: number;
    matchingSourceRecords: number;
    period: ShipmentPeriod;
    status: ShipmentStatus | 'all';
    searchApplied: boolean;
  };
}

export interface ShipmentDetailResult {
  summary: ShipmentSummary;
  items: ShipmentItem[];
  itemLimit: number;
  nextItemCursor: string | null;
}
