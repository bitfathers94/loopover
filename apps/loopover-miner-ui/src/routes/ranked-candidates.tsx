import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";

import { Badge } from "@loopover/ui-kit/components/badge";
import { Card, CardContent, CardHeader } from "@loopover/ui-kit/components/card";
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from "@loopover/ui-kit/components/pagination";
import { Skeleton } from "@loopover/ui-kit/components/skeleton";
import { StateBoundary } from "@loopover/ui-kit/components/state-views";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@loopover/ui-kit/components/table";

import { DEFAULT_POLL_INTERVAL_MS, usePolledFetch } from "../lib/use-polled-fetch";
import {
  fetchRankedCandidates,
  rankedCandidateRowKey,
  type RankedCandidateRow,
  type RankedCandidatesResult,
} from "../lib/ranked-candidates";

export const Route = createFileRoute("/ranked-candidates")({
  component: RankedCandidatesPage,
});

// Read-only ranked-candidates table (#7675): one row per discovered issue from the miner's last discover run,
// served by the dev server's local `/api/ranked-candidates` endpoint (vite-ranked-candidates-api.ts). No writes,
// no new state — this surfaces the SAME per-issue breakdown the browser extension's opportunity badge already
// consumes (laneFit/freshness/potential/feasibility/dupRisk + the composite score), which had no dashboard view.
//
// Structural conventions mirror routes/run-history.tsx exactly: `usePolledFetch` live refresh, the shared
// @loopover/ui-kit `StateBoundary` for loading/error/empty, a content-shaped `Skeleton` table so the layout
// doesn't jump, and client-side `Pagination` once the table exceeds PAGE_SIZE rows. Purely presentational —
// `lib/ranked-candidates.ts`'s fetch/poll is untouched.

/** Rows per page once the table grows past this; below it the full table renders unpaginated. */
const PAGE_SIZE = 20;

const TABLE_COLUMNS = [
  "Issue",
  "Title",
  "Score",
  "Lane fit",
  "Freshness",
  "Potential",
  "Feasibility",
  "Dup risk",
] as const;

/** All ranking values are 0–1-ish reals; render them with a stable two-decimal precision for column alignment. */
function formatDimension(value: number): string {
  return value.toFixed(2);
}

function RankedCandidatesTableHeader() {
  return (
    <TableHeader>
      <TableRow>
        {TABLE_COLUMNS.map((column) => (
          <TableHead key={column}>{column}</TableHead>
        ))}
      </TableRow>
    </TableHeader>
  );
}

/** Table-shaped loading placeholder: header + `rows` shimmer rows matching the real column layout, so the table
 *  keeps its shape and the content doesn't jump once the poll resolves. `role="status"` keeps the loading state
 *  announced to assistive tech. */
function RankedCandidatesSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div role="status" aria-label="Loading ranked candidates">
      <Table>
        <RankedCandidatesTableHeader />
        <TableBody>
          {Array.from({ length: rows }).map((_, index) => (
            <TableRow key={index}>
              <TableCell>
                <Skeleton className="h-4 w-40" />
              </TableCell>
              <TableCell>
                <Skeleton className="h-4 w-56" />
              </TableCell>
              {TABLE_COLUMNS.slice(2).map((column) => (
                <TableCell key={column}>
                  <Skeleton className="h-4 w-12" />
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

/** The issue identity cell — `repo #number`, linked to the canonical issue URL when the snapshot recorded one,
 *  plain text otherwise (a fresh snapshot can lack an html_url). */
function IssueCell({ row }: { row: RankedCandidateRow }) {
  const label = `${row.repoFullName} #${row.issueNumber}`;
  if (row.htmlUrl === null) {
    return <span className="font-mono text-foreground">{label}</span>;
  }
  return (
    <a
      href={row.htmlUrl}
      target="_blank"
      rel="noreferrer"
      className="font-mono text-foreground underline-offset-2 hover:underline"
    >
      {label}
    </a>
  );
}

function RankedCandidatesTable({ rows }: { rows: RankedCandidateRow[] }) {
  return (
    <Table>
      <RankedCandidatesTableHeader />
      <TableBody>
        {rows.map((row) => (
          <TableRow key={rankedCandidateRowKey(row)}>
            <TableCell>
              <IssueCell row={row} />
            </TableCell>
            <TableCell className="text-muted-foreground">{row.title}</TableCell>
            <TableCell>
              <Badge variant="secondary">{formatDimension(row.rankScore)}</Badge>
            </TableCell>
            <TableCell className="text-muted-foreground">{formatDimension(row.laneFit)}</TableCell>
            <TableCell className="text-muted-foreground">{formatDimension(row.freshness)}</TableCell>
            <TableCell className="text-muted-foreground">{formatDimension(row.potential)}</TableCell>
            <TableCell className="text-muted-foreground">{formatDimension(row.feasibility)}</TableCell>
            <TableCell className="text-muted-foreground">{formatDimension(row.dupRisk)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export function RankedCandidatesView({ result }: { result: RankedCandidatesResult | null }) {
  const [page, setPage] = useState(0);
  const rows = result?.ok ? result.rows : [];
  const pageCount = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const isPaginated = rows.length > PAGE_SIZE;
  const safePage = Math.min(page, pageCount - 1);
  const visibleRows = isPaginated ? rows.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE) : rows;

  return (
    <StateBoundary
      isLoading={result === null}
      isError={result !== null && !result.ok}
      isEmpty={result !== null && result.ok && result.rows.length === 0}
      loadingSkeleton={<RankedCandidatesSkeleton />}
      errorTitle="Couldn't read ranked candidates"
      errorDescription="The local ranked-candidates API didn't respond. This refreshes automatically on the next poll."
      emptyTitle="No ranked candidates yet"
      emptyDescription="The table fills in once the miner records its first discover run."
    >
      <RankedCandidatesTable rows={visibleRows} />
      {isPaginated && (
        <Pagination className="mt-4">
          <PaginationContent>
            <PaginationItem>
              <PaginationPrevious
                href="#"
                aria-disabled={safePage === 0}
                onClick={(event) => {
                  event.preventDefault();
                  setPage((current) => Math.max(0, current - 1));
                }}
              />
            </PaginationItem>
            {Array.from({ length: pageCount }).map((_, index) => (
              <PaginationItem key={index}>
                <PaginationLink
                  href="#"
                  isActive={index === safePage}
                  onClick={(event) => {
                    event.preventDefault();
                    setPage(index);
                  }}
                >
                  {index + 1}
                </PaginationLink>
              </PaginationItem>
            ))}
            <PaginationItem>
              <PaginationNext
                href="#"
                aria-disabled={safePage >= pageCount - 1}
                onClick={(event) => {
                  event.preventDefault();
                  setPage((current) => Math.min(pageCount - 1, current + 1));
                }}
              />
            </PaginationItem>
          </PaginationContent>
        </Pagination>
      )}
    </StateBoundary>
  );
}

export function RankedCandidatesPage({
  loadRankedCandidates = fetchRankedCandidates,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
}: {
  loadRankedCandidates?: () => Promise<RankedCandidatesResult>;
  pollIntervalMs?: number;
}) {
  const { result } = usePolledFetch(loadRankedCandidates, pollIntervalMs);

  return (
    <Card>
      <CardHeader>
        <h2 className="font-display text-token-lg font-semibold">Ranked candidates</h2>
        <p className="text-token-sm text-muted-foreground">
          Read-only view of the miner&apos;s last discover run&apos;s per-issue ranking breakdown (`ranked_candidates`).
        </p>
      </CardHeader>
      <CardContent>
        <RankedCandidatesView result={result} />
      </CardContent>
    </Card>
  );
}
