export function includedPoolHistoryResults(results, { poolType, stateId }) {
  return results.filter((result) =>
    result.poolType === poolType
    && result.poolStateKey === stateId
    && (result.includedQuantity > 0 || result.status === "blocked"));
}
