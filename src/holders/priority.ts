// Bushel purchase priority (docs/Trellis_Overview.md §4): when a capacity sale has more requests than capacity, requests
// are served by the buyer's tier `sealed_priority` (higher first), then by arrival time, then by id so the order is
// total. Priority decides who is served first; it never changes the price, the size a buyer may ask for, or grants
// anything. A pure function, for the capacity sale service.

export type BushelPurchaseRequest = {
  id: string;
  /** The buyer's tier `sealed_priority` when the request was made; 0 or absent for a buyer with no tier. */
  priority?: number | null;
  /** When the request arrived: a Date, unix milliseconds or an ISO string. */
  at: Date | number | string;
};

const time = (at: Date | number | string) => (at instanceof Date ? at.getTime() : typeof at === "number" ? at : Date.parse(at));

/** `requests` in the order a capacity sale serves them. Does not change the input. */
export function bushelPurchaseOrder<T extends BushelPurchaseRequest>(requests: readonly T[]): T[] {
  return [...requests].sort((a, b) => {
    const ta = time(a.at), tb = time(b.at);
    return Math.max(0, b.priority ?? 0) - Math.max(0, a.priority ?? 0) || (Number.isNaN(ta) ? Infinity : ta) - (Number.isNaN(tb) ? Infinity : tb) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  });
}
