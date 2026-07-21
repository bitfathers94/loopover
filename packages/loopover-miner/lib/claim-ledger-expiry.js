/** PURE — no IO, no Date, no random (#2316). */
export const DEFAULT_MAX_CLAIM_AGE_MS = 14 * 24 * 60 * 60 * 1000;
function claimAgeMs(claim, nowMs) {
    const claimedAtMs = Date.parse(claim.claimedAt);
    if (!Number.isFinite(claimedAtMs))
        return null;
    return nowMs - claimedAtMs;
}
/**
 * Return active claims whose age is strictly greater than `maxAgeMs`. A claim whose age equals `maxAgeMs` exactly
 * is still considered within the window (not expired).
 */
export function findExpiredClaims(claims, nowMs, maxAgeMs) {
    if (!Number.isFinite(nowMs) || nowMs < 0)
        throw new Error("invalid_now_ms");
    if (!Number.isFinite(maxAgeMs) || maxAgeMs < 0)
        throw new Error("invalid_max_age_ms");
    if (!Array.isArray(claims))
        throw new Error("invalid_claims");
    const expired = [];
    for (const claim of claims) {
        if (claim?.status !== "active")
            continue;
        const ageMs = claimAgeMs(claim, nowMs);
        // Fail-closed (#7732): a claim whose `claimedAt` can't be parsed has an indeterminate age and would otherwise
        // be permanently un-expirable. Sweep it rather than silently retaining a corrupted/hand-edited row, matching
        // this file's fail-closed posture (drop unusable rows, don't strand them).
        if (ageMs === null || ageMs > maxAgeMs)
            expired.push(claim);
    }
    return expired;
}
export function sweepExpiredClaims(store, nowMs, maxAgeMs = DEFAULT_MAX_CLAIM_AGE_MS) {
    const activeClaims = store.listClaims({ status: "active" });
    const expired = findExpiredClaims(activeClaims, nowMs, maxAgeMs);
    const transitioned = [];
    for (const claim of expired) {
        // Echo the row's OWN apiBaseUrl back (#5563) rather than defaulting: two forge hosts can each have an
        // active claim on the same owner/repo#issue, and defaulting here would expire the wrong host's row.
        const updated = store.expireClaim(claim.repoFullName, claim.issueNumber, claim.apiBaseUrl);
        if (updated)
            transitioned.push(updated);
    }
    return transitioned;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiY2xhaW0tbGVkZ2VyLWV4cGlyeS5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbImNsYWltLWxlZGdlci1leHBpcnkudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUEsZ0RBQWdEO0FBSWhELE1BQU0sQ0FBQyxNQUFNLHdCQUF3QixHQUFHLEVBQUUsR0FBRyxFQUFFLEdBQUcsRUFBRSxHQUFHLEVBQUUsR0FBRyxJQUFJLENBQUM7QUFPakUsU0FBUyxVQUFVLENBQUMsS0FBaUIsRUFBRSxLQUFhO0lBQ2xELE1BQU0sV0FBVyxHQUFHLElBQUksQ0FBQyxLQUFLLENBQUMsS0FBSyxDQUFDLFNBQVMsQ0FBQyxDQUFDO0lBQ2hELElBQUksQ0FBQyxNQUFNLENBQUMsUUFBUSxDQUFDLFdBQVcsQ0FBQztRQUFFLE9BQU8sSUFBSSxDQUFDO0lBQy9DLE9BQU8sS0FBSyxHQUFHLFdBQVcsQ0FBQztBQUM3QixDQUFDO0FBRUQ7OztHQUdHO0FBQ0gsTUFBTSxVQUFVLGlCQUFpQixDQUFDLE1BQW9CLEVBQUUsS0FBYSxFQUFFLFFBQWdCO0lBQ3JGLElBQUksQ0FBQyxNQUFNLENBQUMsUUFBUSxDQUFDLEtBQUssQ0FBQyxJQUFJLEtBQUssR0FBRyxDQUFDO1FBQUUsTUFBTSxJQUFJLEtBQUssQ0FBQyxnQkFBZ0IsQ0FBQyxDQUFDO0lBQzVFLElBQUksQ0FBQyxNQUFNLENBQUMsUUFBUSxDQUFDLFFBQVEsQ0FBQyxJQUFJLFFBQVEsR0FBRyxDQUFDO1FBQUUsTUFBTSxJQUFJLEtBQUssQ0FBQyxvQkFBb0IsQ0FBQyxDQUFDO0lBQ3RGLElBQUksQ0FBQyxLQUFLLENBQUMsT0FBTyxDQUFDLE1BQU0sQ0FBQztRQUFFLE1BQU0sSUFBSSxLQUFLLENBQUMsZ0JBQWdCLENBQUMsQ0FBQztJQUU5RCxNQUFNLE9BQU8sR0FBaUIsRUFBRSxDQUFDO0lBQ2pDLEtBQUssTUFBTSxLQUFLLElBQUksTUFBTSxFQUFFLENBQUM7UUFDM0IsSUFBSSxLQUFLLEVBQUUsTUFBTSxLQUFLLFFBQVE7WUFBRSxTQUFTO1FBQ3pDLE1BQU0sS0FBSyxHQUFHLFVBQVUsQ0FBQyxLQUFLLEVBQUUsS0FBSyxDQUFDLENBQUM7UUFDdkMsOEdBQThHO1FBQzlHLDZHQUE2RztRQUM3RywyRUFBMkU7UUFDM0UsSUFBSSxLQUFLLEtBQUssSUFBSSxJQUFJLEtBQUssR0FBRyxRQUFRO1lBQUUsT0FBTyxDQUFDLElBQUksQ0FBQyxLQUFLLENBQUMsQ0FBQztJQUM5RCxDQUFDO0lBQ0QsT0FBTyxPQUFPLENBQUM7QUFDakIsQ0FBQztBQUVELE1BQU0sVUFBVSxrQkFBa0IsQ0FDaEMsS0FBNkIsRUFDN0IsS0FBYSxFQUNiLFdBQW1CLHdCQUF3QjtJQUUzQyxNQUFNLFlBQVksR0FBRyxLQUFLLENBQUMsVUFBVSxDQUFDLEVBQUUsTUFBTSxFQUFFLFFBQVEsRUFBRSxDQUFDLENBQUM7SUFDNUQsTUFBTSxPQUFPLEdBQUcsaUJBQWlCLENBQUMsWUFBWSxFQUFFLEtBQUssRUFBRSxRQUFRLENBQUMsQ0FBQztJQUNqRSxNQUFNLFlBQVksR0FBaUIsRUFBRSxDQUFDO0lBQ3RDLEtBQUssTUFBTSxLQUFLLElBQUksT0FBTyxFQUFFLENBQUM7UUFDNUIsc0dBQXNHO1FBQ3RHLG9HQUFvRztRQUNwRyxNQUFNLE9BQU8sR0FBRyxLQUFLLENBQUMsV0FBVyxDQUFDLEtBQUssQ0FBQyxZQUFZLEVBQUUsS0FBSyxDQUFDLFdBQVcsRUFBRSxLQUFLLENBQUMsVUFBVSxDQUFDLENBQUM7UUFDM0YsSUFBSSxPQUFPO1lBQUUsWUFBWSxDQUFDLElBQUksQ0FBQyxPQUFPLENBQUMsQ0FBQztJQUMxQyxDQUFDO0lBQ0QsT0FBTyxZQUFZLENBQUM7QUFDdEIsQ0FBQyJ9