import { describe, expect, it } from "vitest";
import { filterThreadsByState, THREAD_STATES } from "./thread-filter";

type Thread = { id: string; state: string };

describe("filterThreadsByState", () => {
  const threads: Thread[] = [
    { id: "a", state: "open" },
    { id: "b", state: "quoted" },
    { id: "c", state: "open" },
    { id: "d", state: "collected" },
  ];

  it("returns every thread unfiltered when the filter is 'all'", () => {
    expect(filterThreadsByState(threads, "all")).toEqual(threads);
  });

  it("returns only threads matching the given state", () => {
    expect(filterThreadsByState(threads, "open")).toEqual([threads[0], threads[2]]);
  });

  it("returns an empty list when no thread matches", () => {
    expect(filterThreadsByState(threads, "booked")).toEqual([]);
  });

  it("lists every thread state the ticket names, in a stable, well-typed order", () => {
    expect(THREAD_STATES).toEqual(["open", "quoted", "refused", "paused_owner", "booked", "collected", "closed"]);
  });
});
