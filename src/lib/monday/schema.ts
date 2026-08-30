import type { BoardColumn } from './fetch';

/**
 * Maps monday.com board columns onto canonical internal field names.
 *
 * Column *titles* are matched at runtime against alias lists rather than
 * hardcoding monday.com column IDs, so the agent keeps working if the board is
 * rebuilt, columns are reordered, or titles differ slightly in punctuation or
 * casing. Unresolved fields are reported so the analytics layer can degrade
 * honestly instead of silently returning zeroes.
 */

export type DealField =
  | 'dealName'
  | 'ownerCode'
  | 'clientCode'
  | 'status'
  | 'actualCloseDate'
  | 'closureProbability'
  | 'dealValue'
  | 'tentativeCloseDate'
  | 'stage'
  | 'productDeal'
  | 'sector'
  | 'createdDate';

export type WorkOrderField =
  | 'dealName'
  | 'customerCode'
  | 'serial'
  | 'natureOfWork'
  | 'lastExecutedMonth'
  | 'executionStatus'
  | 'dataDeliveryDate'
  | 'poDate'
  | 'documentType'
  | 'probableStartDate'
  | 'probableEndDate'
  | 'ownerCode'
  | 'sector'
  | 'typeOfWork'
  | 'platform'
  | 'lastInvoiceDate'
  | 'invoiceNo'
  | 'orderValueExGst'
  | 'orderValueInclGst'
  | 'billedExGst'
  | 'billedInclGst'
  | 'collectedInclGst'
  | 'toBillExGst'
  | 'toBillInclGst'
  | 'receivable'
  | 'arPriority'
  | 'qtyByOps'
  | 'qtyPerPo'
  | 'qtyBilled'
  | 'qtyBalance'
  | 'invoiceStatus'
  | 'expectedBillingMonth'
  | 'actualBillingMonth'
  | 'actualCollectionMonth'
  | 'woStatus'
  | 'collectionStatus'
  | 'collectionDate'
  | 'billingStatus';

/** Lowercase, strip everything that is not a letter or digit. */
export function normTitle(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export const DEAL_ALIASES: Record<DealField, string[]> = {
  dealName: ['Deal Name', 'Deal', 'Name', 'Deal name masked'],
  ownerCode: ['Owner code', 'Owner', 'Deal Owner', 'BD/KAM Personnel code'],
  clientCode: ['Client Code', 'Client', 'Customer Code', 'Company'],
  status: ['Deal Status', 'Status'],
  actualCloseDate: ['Close Date (A)', 'Close Date A', 'Actual Close Date', 'Close Date'],
  closureProbability: ['Closure Probability', 'Probability', 'Confidence'],
  dealValue: ['Masked Deal value', 'Deal Value', 'Deal value', 'Value', 'Amount'],
  tentativeCloseDate: ['Tentative Close Date', 'Expected Close Date', 'Tentative Close'],
  stage: ['Deal Stage', 'Stage', 'Pipeline Stage'],
  productDeal: ['Product deal', 'Product', 'Product Mix'],
  sector: ['Sector/service', 'Sector', 'Industry', 'Sector service'],
  createdDate: ['Created Date', 'Create Date', 'Created'],
};

export const WORK_ORDER_ALIASES: Record<WorkOrderField, string[]> = {
  dealName: ['Deal name masked', 'Deal Name', 'Deal', 'Name'],
  customerCode: ['Customer Name Code', 'Customer Code', 'Client Code', 'Customer'],
  serial: ['Serial #', 'Serial', 'Serial No', 'WO Number', 'Work Order ID'],
  natureOfWork: ['Nature of Work', 'Nature'],
  lastExecutedMonth: ['Last executed month of recurring project', 'Last executed month'],
  executionStatus: ['Execution Status', 'Status', 'Project Status'],
  dataDeliveryDate: ['Data Delivery Date', 'Delivery Date'],
  poDate: ['Date of PO/LOI', 'PO Date', 'Date of PO', 'PO/LOI Date'],
  documentType: ['Document Type', 'Doc Type'],
  probableStartDate: ['Probable Start Date', 'Start Date'],
  probableEndDate: ['Probable End Date', 'End Date'],
  ownerCode: ['BD/KAM Personnel code', 'Owner code', 'Owner', 'KAM'],
  sector: ['Sector', 'Sector/service', 'Industry'],
  typeOfWork: ['Type of Work', 'Work Type', 'Service Type'],
  platform: [
    'Is any Skylark software platform part of the client deliverables in this deal?',
    'Skylark software platform',
    'Platform',
    'Software Platform',
  ],
  lastInvoiceDate: ['Last invoice date', 'Last Invoice Date', 'Invoice Date'],
  invoiceNo: ['latest invoice no.', 'Latest Invoice No', 'Invoice No', 'Invoice Number'],
  orderValueExGst: ['Amount in Rupees (Excl of GST) (Masked)', 'Amount Excl GST', 'Order Value Excl GST'],
  orderValueInclGst: ['Amount in Rupees (Incl of GST) (Masked)', 'Amount Incl GST', 'Order Value Incl GST'],
  billedExGst: ['Billed Value in Rupees (Excl of GST.) (Masked)', 'Billed Value Excl GST', 'Billed Excl GST'],
  billedInclGst: ['Billed Value in Rupees (Incl of GST.) (Masked)', 'Billed Value Incl GST', 'Billed Incl GST'],
  collectedInclGst: [
    'Collected Amount in Rupees (Incl of GST.) (Masked)',
    'Collected Amount',
    'Collected Incl GST',
  ],
  toBillExGst: ['Amount to be billed in Rs. (Exl. of GST) (Masked)', 'Amount to be billed Excl GST'],
  toBillInclGst: ['Amount to be billed in Rs. (Incl. of GST) (Masked)', 'Amount to be billed Incl GST'],
  receivable: ['Amount Receivable (Masked)', 'Amount Receivable', 'Receivable'],
  arPriority: ['AR Priority account', 'AR Priority'],
  qtyByOps: ['Quantity by Ops', 'Qty by Ops'],
  qtyPerPo: ['Quantities as per PO', 'Quantity as per PO', 'Qty per PO'],
  qtyBilled: ['Quantity billed (till date)', 'Quantity billed', 'Qty billed'],
  qtyBalance: ['Balance in quantity', 'Balance Quantity', 'Qty balance'],
  invoiceStatus: ['Invoice Status'],
  expectedBillingMonth: ['Expected Billing Month'],
  actualBillingMonth: ['Actual Billing Month'],
  actualCollectionMonth: ['Actual Collection Month'],
  woStatus: ['WO Status (billed)', 'WO Status', 'Work Order Status'],
  collectionStatus: ['Collection status', 'Collection Status'],
  collectionDate: ['Collection Date'],
  billingStatus: ['Billing Status'],
};

export interface ResolvedSchema<F extends string> {
  /** canonical field -> actual board column title */
  map: Partial<Record<F, string>>;
  /** canonical fields we could not find on the board */
  unresolved: F[];
  /** board column titles that no canonical field claimed */
  unmapped: string[];
}

/**
 * Resolves canonical fields against real board columns.
 * Matching passes, in order of confidence:
 *   1. exact normalized title match against any alias
 *   2. normalized containment (board title contains alias, or vice versa)
 * Each board column is claimed at most once.
 */
export function resolveSchema<F extends string>(
  columns: BoardColumn[],
  aliases: Record<F, string[]>,
): ResolvedSchema<F> {
  const map: Partial<Record<F, string>> = {};
  const claimed = new Set<string>();
  const fields = Object.keys(aliases) as F[];

  const cols = columns.map((c) => ({ title: c.title, norm: normTitle(c.title) }));

  // Pass 1 — exact normalized equality.
  for (const field of fields) {
    for (const alias of aliases[field]) {
      const a = normTitle(alias);
      const hit = cols.find((c) => !claimed.has(c.title) && c.norm === a);
      if (hit) {
        map[field] = hit.title;
        claimed.add(hit.title);
        break;
      }
    }
  }

  // Pass 2 — containment, longest alias first to prefer specific matches.
  for (const field of fields) {
    if (map[field]) continue;
    const sorted = [...aliases[field]].sort((x, y) => y.length - x.length);
    for (const alias of sorted) {
      const a = normTitle(alias);
      if (a.length < 4) continue; // too short to match safely by containment
      const hit = cols.find(
        (c) => !claimed.has(c.title) && (c.norm.includes(a) || a.includes(c.norm)),
      );
      if (hit) {
        map[field] = hit.title;
        claimed.add(hit.title);
        break;
      }
    }
  }

  return {
    map,
    unresolved: fields.filter((f) => !map[f]),
    unmapped: cols.filter((c) => !claimed.has(c.title)).map((c) => c.title),
  };
}
