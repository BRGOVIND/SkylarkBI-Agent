import type { RawBoard, RawItem } from '../monday/fetch';
import {
  DEAL_ALIASES,
  WORK_ORDER_ALIASES,
  resolveSchema,
  normTitle,
  type DealField,
  type WorkOrderField,
} from '../monday/schema';
import { cleanText, parseDate, parseNumber, toISODate } from './primitives';
import {
  nameKey,
  normalizeDealStatus,
  normalizeExecutionStatus,
  normalizeProbability,
  normalizeSector,
  normalizeStage,
} from './taxonomy';
import type {
  DataQualityReport,
  DealsDataset,
  FieldQuality,
  NormalizedDeal,
  NormalizedWorkOrder,
  WorkOrdersDataset,
} from './types';

export * from './types';
export * from './primitives';
export * from './taxonomy';

/** Tracks present/missing/malformed counts per canonical field. */
class QualityTracker {
  private readonly stats = new Map<string, { present: number; missing: number; malformed: number }>();

  record(field: string, present: boolean, malformed = false): void {
    let s = this.stats.get(field);
    if (!s) {
      s = { present: 0, missing: 0, malformed: 0 };
      this.stats.set(field, s);
    }
    if (malformed) s.malformed++;
    else if (present) s.present++;
    else s.missing++;
  }

  toFields(total: number): FieldQuality[] {
    return [...this.stats.entries()]
      .map(([field, s]) => ({
        field,
        present: s.present,
        missing: s.missing,
        malformed: s.malformed,
        completeness: total ? Math.round((s.present / total) * 1000) / 10 : 0,
      }))
      .sort((a, b) => a.completeness - b.completeness);
  }
}

/**
 * The source spreadsheets contain header text repeated inside the data (rows
 * where "Deal Status" is literally the string "Deal Status"). If those rows are
 * imported into monday.com they arrive as ordinary items, so we detect and drop
 * them: a row is a header echo when a mapped field's value equals its own
 * column title.
 */
function isHeaderEcho(item: RawItem, map: Partial<Record<string, string>>): boolean {
  let matches = 0;
  let checked = 0;
  for (const title of Object.values(map)) {
    if (!title) continue;
    const v = item.values[title];
    if (v === null || v === undefined) continue;
    checked++;
    if (normTitle(v) === normTitle(title)) matches++;
  }
  // Two independent columns echoing their own title is conclusive. A single
  // populated column that echoes its title is also treated as a header row,
  // since a real record would carry data in more than one field.
  if (matches >= 2) return true;
  return checked > 0 && matches === checked;
}

function fingerprint(values: Array<string | number | null>): string {
  return values.map((v) => (v === null ? '' : String(v))).join('');
}

function get(item: RawItem, map: Partial<Record<string, string>>, field: string): string | null {
  const title = map[field];
  if (!title) return null;
  return item.values[title] ?? null;
}

/* ------------------------------- Deals ---------------------------------- */

export function normalizeDeals(board: RawBoard): DealsDataset {
  const schema = resolveSchema<DealField>(board.columns, DEAL_ALIASES);
  const map = schema.map as Partial<Record<string, string>>;
  const q = new QualityTracker();

  let headerRowsDropped = 0;
  let duplicateRowsDropped = 0;
  const seen = new Set<string>();
  const deals: NormalizedDeal[] = [];

  for (const item of board.items) {
    if (isHeaderEcho(item, map)) {
      headerRowsDropped++;
      continue;
    }

    const issues: string[] = [];

    // Deal name falls back to the monday.com item name, which is how the
    // importer stores the first column.
    const rawName = get(item, map, 'dealName') ?? item.name;
    const dealName = cleanText(rawName);
    q.record('dealName', dealName !== null);

    const ownerCode = cleanText(get(item, map, 'ownerCode'));
    q.record('ownerCode', ownerCode !== null);

    const clientCode = cleanText(get(item, map, 'clientCode'));
    q.record('clientCode', clientCode !== null);

    const statusRaw = get(item, map, 'status');
    const status = normalizeDealStatus(statusRaw);
    q.record('status', status !== null);
    if (status && status.canon === 'unknown') issues.push(`Unrecognised deal status "${status.label}"`);

    const stageRaw = get(item, map, 'stage');
    const stage = normalizeStage(stageRaw);
    q.record('stage', stage !== null);
    if (stage && stage.bucket === 'unknown') issues.push(`Unrecognised deal stage "${stage.label}"`);

    const sector = normalizeSector(get(item, map, 'sector'));
    q.record('sector', sector !== null);

    const prob = normalizeProbability(get(item, map, 'closureProbability'));
    q.record('closureProbability', prob !== null);

    const value = parseNumber(get(item, map, 'dealValue'));
    q.record('dealValue', value.value !== null, value.invalid);
    if (value.invalid) issues.push(`Deal value "${value.raw}" is not a number`);
    if (value.value !== null && value.value < 0) issues.push('Deal value is negative');

    const created = parseDate(get(item, map, 'createdDate'));
    q.record('createdDate', created.value !== null, created.invalid);
    if (created.invalid) issues.push(`Unparseable created date "${created.raw}"`);

    const tentative = parseDate(get(item, map, 'tentativeCloseDate'));
    q.record('tentativeCloseDate', tentative.value !== null, tentative.invalid);
    if (tentative.invalid) issues.push(`Unparseable tentative close date "${tentative.raw}"`);

    const actual = parseDate(get(item, map, 'actualCloseDate'));
    q.record('actualCloseDate', actual.value !== null, actual.invalid);
    if (actual.invalid) issues.push(`Unparseable close date "${actual.raw}"`);

    if (created.value && tentative.value && tentative.value < created.value) {
      issues.push('Tentative close date precedes created date');
    }

    const deal: NormalizedDeal = {
      itemId: item.id,
      dealName,
      dealNameKey: nameKey(dealName),
      ownerCode,
      clientCode,
      clientKey: nameKey(clientCode),
      statusLabel: status?.label ?? null,
      status: status?.canon ?? 'unknown',
      stageLabel: stage?.label ?? null,
      stageOrder: stage?.order ?? null,
      stageBucket: stage?.bucket ?? 'unknown',
      sector,
      productDeal: cleanText(get(item, map, 'productDeal')),
      probabilityLabel: prob?.label ?? null,
      probability: prob?.canon ?? null,
      probabilityWeight: prob?.weight ?? null,
      dealValue: value.value,
      createdDate: toISODate(created.value),
      tentativeCloseDate: toISODate(tentative.value),
      actualCloseDate: toISODate(actual.value),
      issues,
    };

    // Exact duplicates: the source data contains repeated rows. We keep the
    // first occurrence and count the rest so the caveat can be reported.
    const fp = fingerprint([
      deal.dealNameKey,
      deal.ownerCode,
      deal.clientCode,
      deal.statusLabel,
      deal.stageLabel,
      deal.sector,
      deal.dealValue,
      deal.createdDate,
      deal.tentativeCloseDate,
    ]);
    if (seen.has(fp)) {
      duplicateRowsDropped++;
      continue;
    }
    seen.add(fp);
    deals.push(deal);
  }

  const quality = buildReport({
    board: 'Deals',
    boardId: board.boardId,
    total: board.items.length,
    headerRowsDropped,
    duplicateRowsDropped,
    usable: deals.length,
    tracker: q,
    unresolved: schema.unresolved,
    unmapped: schema.unmapped,
    truncated: board.truncated,
  });

  const noValue = deals.filter((d) => d.dealValue === null).length;
  if (noValue) {
    quality.warnings.push(
      `${noValue} of ${deals.length} deals have no deal value; value-based totals exclude them.`,
    );
  }
  const noProb = deals.filter((d) => d.probability === null).length;
  if (noProb) {
    quality.warnings.push(
      `${noProb} of ${deals.length} deals have no closure probability; weighted pipeline covers only the rest.`,
    );
  }

  return { deals, quality };
}

/* ---------------------------- Work orders -------------------------------- */

export function normalizeWorkOrders(board: RawBoard): WorkOrdersDataset {
  const schema = resolveSchema<WorkOrderField>(board.columns, WORK_ORDER_ALIASES);
  const map = schema.map as Partial<Record<string, string>>;
  const q = new QualityTracker();

  let headerRowsDropped = 0;
  let duplicateRowsDropped = 0;
  const seen = new Set<string>();
  const workOrders: NormalizedWorkOrder[] = [];

  const num = (item: RawItem, field: string, issues: string[], label: string) => {
    const p = parseNumber(get(item, map, field));
    q.record(field, p.value !== null, p.invalid);
    if (p.invalid) issues.push(`${label} "${p.raw}" is not a number`);
    return p.value;
  };
  const date = (item: RawItem, field: string, issues: string[], label: string) => {
    const p = parseDate(get(item, map, field));
    q.record(field, p.value !== null, p.invalid);
    if (p.invalid) issues.push(`Unparseable ${label} "${p.raw}"`);
    return toISODate(p.value);
  };

  for (const item of board.items) {
    if (isHeaderEcho(item, map)) {
      headerRowsDropped++;
      continue;
    }
    const issues: string[] = [];

    const dealName = cleanText(get(item, map, 'dealName') ?? item.name);
    q.record('dealName', dealName !== null);

    const serial = cleanText(get(item, map, 'serial'));
    q.record('serial', serial !== null);

    const customerCode = cleanText(get(item, map, 'customerCode'));
    q.record('customerCode', customerCode !== null);

    const ownerCode = cleanText(get(item, map, 'ownerCode'));
    q.record('ownerCode', ownerCode !== null);

    const sector = normalizeSector(get(item, map, 'sector'));
    q.record('sector', sector !== null);

    const exec = normalizeExecutionStatus(get(item, map, 'executionStatus'));
    q.record('executionStatus', exec !== null);
    if (exec && exec.canon === 'unknown') issues.push(`Unrecognised execution status "${exec.label}"`);

    const orderValueExGst = num(item, 'orderValueExGst', issues, 'Order value (excl GST)');
    const orderValueInclGst = num(item, 'orderValueInclGst', issues, 'Order value (incl GST)');
    const billedExGst = num(item, 'billedExGst', issues, 'Billed value (excl GST)');
    const billedInclGst = num(item, 'billedInclGst', issues, 'Billed value (incl GST)');
    const collectedInclGst = num(item, 'collectedInclGst', issues, 'Collected amount');
    const toBillExGst = num(item, 'toBillExGst', issues, 'Amount to be billed');
    const receivable = num(item, 'receivable', issues, 'Amount receivable');
    const qtyPerPo = num(item, 'qtyPerPo', issues, 'Quantity per PO');
    const qtyBilled = num(item, 'qtyBilled', issues, 'Quantity billed');
    const qtyBalance = num(item, 'qtyBalance', issues, 'Balance quantity');

    if (orderValueExGst !== null && billedExGst !== null && billedExGst > orderValueExGst * 1.01) {
      issues.push('Billed value exceeds order value');
    }
    if (toBillExGst !== null && toBillExGst < 0) {
      issues.push('Amount to be billed is negative (over-billed or stale figure)');
    }

    const poDate = date(item, 'poDate', issues, 'PO/LOI date');
    const probableStartDate = date(item, 'probableStartDate', issues, 'probable start date');
    const probableEndDate = date(item, 'probableEndDate', issues, 'probable end date');
    const dataDeliveryDate = date(item, 'dataDeliveryDate', issues, 'data delivery date');
    const lastInvoiceDate = date(item, 'lastInvoiceDate', issues, 'last invoice date');

    if (probableStartDate && probableEndDate && probableEndDate < probableStartDate) {
      issues.push('Probable end date precedes start date');
    }

    const arRaw = cleanText(get(item, map, 'arPriority'));

    const wo: NormalizedWorkOrder = {
      itemId: item.id,
      serial,
      dealName,
      dealNameKey: nameKey(dealName),
      customerCode,
      ownerCode,
      sector,
      natureOfWork: cleanText(get(item, map, 'natureOfWork')),
      typeOfWork: cleanText(get(item, map, 'typeOfWork')),
      platform: cleanText(get(item, map, 'platform')),
      executionStatusLabel: exec?.label ?? null,
      executionStatus: exec?.canon ?? 'unknown',
      woStatus: cleanText(get(item, map, 'woStatus')),
      invoiceStatus: cleanText(get(item, map, 'invoiceStatus')),
      billingStatus: cleanText(get(item, map, 'billingStatus')),
      arPriority: arRaw !== null && /priority/i.test(arRaw),
      documentType: cleanText(get(item, map, 'documentType')),
      poDate,
      probableStartDate,
      probableEndDate,
      dataDeliveryDate,
      lastInvoiceDate,
      orderValueExGst,
      orderValueInclGst,
      billedExGst,
      billedInclGst,
      collectedInclGst,
      toBillExGst,
      receivable,
      qtyPerPo,
      qtyBilled,
      qtyBalance,
      issues,
    };

    // Serial # is the natural key; fall back to a full fingerprint when absent.
    const fp = wo.serial
      ? `serial:${wo.serial.toLowerCase()}`
      : fingerprint([wo.dealNameKey, wo.customerCode, wo.poDate, wo.orderValueExGst, wo.typeOfWork]);
    if (seen.has(fp)) {
      duplicateRowsDropped++;
      continue;
    }
    seen.add(fp);
    workOrders.push(wo);
  }

  const quality = buildReport({
    board: 'Work Orders',
    boardId: board.boardId,
    total: board.items.length,
    headerRowsDropped,
    duplicateRowsDropped,
    usable: workOrders.length,
    tracker: q,
    unresolved: schema.unresolved,
    unmapped: schema.unmapped,
    truncated: board.truncated,
  });

  const noValue = workOrders.filter((w) => w.orderValueExGst === null).length;
  if (noValue) {
    quality.warnings.push(
      `${noValue} of ${workOrders.length} work orders have no order value; order-book totals exclude them.`,
    );
  }

  return { workOrders, quality };
}

/* ------------------------------ Reporting -------------------------------- */

function buildReport(args: {
  board: string;
  boardId: string;
  total: number;
  headerRowsDropped: number;
  duplicateRowsDropped: number;
  usable: number;
  tracker: QualityTracker;
  unresolved: string[];
  unmapped: string[];
  truncated: boolean;
}): DataQualityReport {
  const warnings: string[] = [];
  if (args.headerRowsDropped) {
    warnings.push(
      `${args.headerRowsDropped} row(s) on the ${args.board} board were repeated header text and were excluded.`,
    );
  }
  if (args.duplicateRowsDropped) {
    warnings.push(
      `${args.duplicateRowsDropped} duplicate row(s) on the ${args.board} board were excluded; only the first occurrence of each is counted.`,
    );
  }
  if (args.unresolved.length) {
    warnings.push(
      `These expected ${args.board} fields were not found on the board and are unavailable: ${args.unresolved.join(', ')}.`,
    );
  }
  if (args.truncated) {
    warnings.push(`The ${args.board} board exceeded the fetch page limit; results may be incomplete.`);
  }

  return {
    board: args.board,
    boardId: args.boardId,
    totalItemsFetched: args.total,
    headerRowsDropped: args.headerRowsDropped,
    duplicateRowsDropped: args.duplicateRowsDropped,
    usableRecords: args.usable,
    fields: args.tracker.toFields(args.usable),
    unresolvedColumns: args.unresolved,
    unmappedColumns: args.unmapped,
    warnings,
    truncated: args.truncated,
  };
}
