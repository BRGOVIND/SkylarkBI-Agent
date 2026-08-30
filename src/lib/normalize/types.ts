import type { DealStatusCanon, ExecutionStatusCanon, PipelineBucket, ProbabilityCanon } from './taxonomy';

export interface NormalizedDeal {
  itemId: string;
  dealName: string | null;
  dealNameKey: string | null;
  ownerCode: string | null;
  clientCode: string | null;
  clientKey: string | null;
  statusLabel: string | null;
  status: DealStatusCanon;
  stageLabel: string | null;
  stageOrder: number | null;
  stageBucket: PipelineBucket;
  sector: string | null;
  productDeal: string | null;
  probabilityLabel: string | null;
  probability: ProbabilityCanon | null;
  probabilityWeight: number | null;
  dealValue: number | null;
  createdDate: string | null;
  tentativeCloseDate: string | null;
  actualCloseDate: string | null;
  /** Field-level issues found while normalising this row. */
  issues: string[];
}

export interface NormalizedWorkOrder {
  itemId: string;
  serial: string | null;
  dealName: string | null;
  dealNameKey: string | null;
  customerCode: string | null;
  ownerCode: string | null;
  sector: string | null;
  natureOfWork: string | null;
  typeOfWork: string | null;
  platform: string | null;
  executionStatusLabel: string | null;
  executionStatus: ExecutionStatusCanon;
  woStatus: string | null;
  invoiceStatus: string | null;
  billingStatus: string | null;
  arPriority: boolean;
  documentType: string | null;
  poDate: string | null;
  probableStartDate: string | null;
  probableEndDate: string | null;
  dataDeliveryDate: string | null;
  lastInvoiceDate: string | null;
  orderValueExGst: number | null;
  orderValueInclGst: number | null;
  billedExGst: number | null;
  billedInclGst: number | null;
  collectedInclGst: number | null;
  toBillExGst: number | null;
  receivable: number | null;
  qtyPerPo: number | null;
  qtyBilled: number | null;
  qtyBalance: number | null;
  issues: string[];
}

/** Per-field completeness statistics for one board. */
export interface FieldQuality {
  field: string;
  present: number;
  missing: number;
  malformed: number;
  completeness: number;
}

export interface DataQualityReport {
  board: string;
  boardId: string;
  totalItemsFetched: number;
  /** Rows discarded because they were repeated header text rather than data. */
  headerRowsDropped: number;
  /** Rows discarded as exact duplicates of an earlier row. */
  duplicateRowsDropped: number;
  usableRecords: number;
  fields: FieldQuality[];
  /** Canonical fields that could not be matched to any board column. */
  unresolvedColumns: string[];
  /** Board columns not mapped to any canonical field. */
  unmappedColumns: string[];
  /** Human-readable caveats for the agent to relay to the user. */
  warnings: string[];
  truncated: boolean;
}

export interface DealsDataset {
  deals: NormalizedDeal[];
  quality: DataQualityReport;
}

export interface WorkOrdersDataset {
  workOrders: NormalizedWorkOrder[];
  quality: DataQualityReport;
}

export interface BusinessDataset {
  deals: NormalizedDeal[];
  workOrders: NormalizedWorkOrder[];
  quality: { deals: DataQualityReport; workOrders: DataQualityReport };
  fetchedAt: string;
}
