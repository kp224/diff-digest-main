"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { SparklesIcon, Loader2, AlertTriangle } from "lucide-react";
import { ModeToggle } from "@/components/mode-toggle";
import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from "@/components/ui/accordion";
import { db, DiffEntity } from "@/lib/db";

interface DiffItem {
  id: string;
  description: string;
  diff: string;
  url: string;
}

interface ApiResponse {
  diffs: DiffItem[];
  nextPage: number | null;
  currentPage: number;
  perPage: number;
}

export default function Home() {
  const [diffs, setDiffs] = useState<DiffItem[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [currentPage, setCurrentPage] = useState<number>(1);
  const [nextPage, setNextPage] = useState<number | null>(null);
  const [initialFetchDone, setInitialFetchDone] = useState<boolean>(false);
  const [generatedSummaries, setGeneratedSummaries] = useState<
    Record<
      string,
      {
        developer: string;
        marketing: string;
      }
    >
  >({});
  const [loadingSummaries, setLoadingSummaries] = useState<
    Record<string, boolean>
  >({});
  const [summaryErrors, setSummaryErrors] = useState<Record<string, string>>(
    {}
  );

  const [openItems, setOpenItems] = useState<string[]>([]);

  useEffect(() => {
    (async () => {
      try {
        const storedDiffs = await db.diffs.toArray();
        if (storedDiffs.length) {
          setDiffs(storedDiffs as unknown as DiffItem[]);

          const storedSummaries: Record<
            string,
            { developer: string; marketing: string }
          > = {};
          storedDiffs.forEach((d: DiffEntity) => {
            if (d.summaryDeveloper || d.summaryMarketing) {
              storedSummaries[d.id] = {
                developer: d.summaryDeveloper || "",
                marketing: d.summaryMarketing || "",
              };
            }
          });
          setGeneratedSummaries(storedSummaries);
        }
      } catch (err) {
        console.error("Failed to load stored diffs", err);
      }
    })();
  }, []);

  const fetchWithTimeout = async (
    input: RequestInfo | URL,
    init: RequestInit = {},
    timeout: number = 30000
  ) => {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetch(input, {
        ...init,
        signal: controller.signal,
      });
      return response;
    } finally {
      clearTimeout(id);
    }
  };

  const fetchDiffs = async (page: number) => {
    setIsLoading(true);
    setError(null);
    try {
      const response = await fetchWithTimeout(
        `/api/sample-diffs?page=${page}&per_page=10`,
        {},
        30000
      );
      if (!response.ok) {
        let errorMsg = `HTTP error! status: ${response.status}`;
        try {
          const errorData = await response.json();
          errorMsg = errorData.error || errorData.details || errorMsg;
        } catch {
          console.warn("Failed to parse error response as JSON");
        }
        throw new Error(errorMsg);
      }
      let data: ApiResponse;
      try {
        data = await response.json();
      } catch {
        throw new Error("Malformed JSON received from server");
      }

      setDiffs((prevDiffs) =>
        page === 1 ? data.diffs : [...prevDiffs, ...data.diffs]
      );

      try {
        const entities: DiffEntity[] = data.diffs.map((d) => ({
          ...d,
          fetchedAt: Date.now(),
        }));
        await db.diffs.bulkPut(entities);
      } catch (e) {
        console.error("Failed to persist diffs", e);
      }

      setCurrentPage(data.currentPage);
      setNextPage(data.nextPage);
      if (!initialFetchDone) setInitialFetchDone(true);
    } catch (err: unknown) {
      setError(
        err instanceof Error ? err.message : "An unknown error occurred"
      );
    } finally {
      setIsLoading(false);
    }
  };

  const fetchAIGeneratedDiff = async (diff: DiffItem) => {
    setGeneratedSummaries((prev) => ({
      ...prev,
      [diff.id]: { developer: "", marketing: "" },
    }));
    setLoadingSummaries((prev) => ({ ...prev, [diff.id]: true }));
    setSummaryErrors((prev) => ({ ...prev, [diff.id]: "" }));

    let response: Response;
    try {
      response = await fetchWithTimeout(
        `/api/ai-generated-diff`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ diffItem: diff }),
        },
        60000
      );
    } catch (err) {
      const message =
        err instanceof Error && err.name === "AbortError"
          ? "Request timed out. Please try again."
          : (err as Error)?.message || "Failed to fetch AI generated summary.";
      console.error("AI generation error:", message);
      setSummaryErrors((prev) => ({ ...prev, [diff.id]: message }));
      setLoadingSummaries((prev) => ({ ...prev, [diff.id]: false }));
      return;
    }

    if (!response.ok || !response.body) {
      let errorMsg = `Failed to fetch AI generated summary (status ${response.status})`;
      try {
        const errJson = await response.json();
        errorMsg = errJson.error || errJson.details || errorMsg;
      } catch {}
      console.error(errorMsg);
      setSummaryErrors((prev) => ({ ...prev, [diff.id]: errorMsg }));
      setLoadingSummaries((prev) => ({ ...prev, [diff.id]: false }));
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    let accumulated = "";

    let finalDeveloper = "";
    let finalMarketing = "";

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value);
        accumulated += chunk;

        const devMatch = accumulated.match(/"developer_notes":"([^\"]*)/);
        const mktMatch = accumulated.match(/"marketing_notes":"([^\"]*)/);

        finalDeveloper = devMatch ? devMatch[1] : finalDeveloper;
        finalMarketing = mktMatch ? mktMatch[1] : finalMarketing;

        setGeneratedSummaries((prev) => {
          const updated = {
            ...prev,
            [diff.id]: {
              developer: finalDeveloper || prev[diff.id]?.developer || "",
              marketing: finalMarketing || prev[diff.id]?.marketing || "",
            },
          };
          db.diffs
            .update(diff.id, {
              summaryDeveloper: updated[diff.id].developer,
              summaryMarketing: updated[diff.id].marketing,
              summaryUpdatedAt: Date.now(),
            })
            .catch((e) => console.warn("Dexie partial save failed", e));
          return updated;
        });
      }
    } catch (streamErr) {
      const message =
        (streamErr as Error).message || "Error while reading AI stream.";
      console.error(message);
      setSummaryErrors((prev) => ({ ...prev, [diff.id]: message }));
    }

    try {
      await db.diffs.update(diff.id, {
        summaryDeveloper: finalDeveloper,
        summaryMarketing: finalMarketing,
        summaryUpdatedAt: Date.now(),
      });
    } catch (e) {
      console.error("Failed to store summary", e);
    }

    setLoadingSummaries((prev) => ({ ...prev, [diff.id]: false }));
  };

  const handleFetchClick = () => {
    setDiffs([]);
    fetchDiffs(1);
  };

  const handleLoadMoreClick = () => {
    if (nextPage) {
      fetchDiffs(nextPage);
    }
  };

  const handleGenerateAllClick = () => {
    const allIds = diffs.map((d) => d.id);

    if (allGenerated) {
      setOpenItems(allIds);
      diffs.forEach((diff) => {
        if (!loadingSummaries[diff.id]) {
          fetchAIGeneratedDiff(diff);
        }
      });
    } else {
      handleAccordionChange(allIds);
    }
  };

  const allGenerated =
    diffs.length > 0 &&
    diffs.every(
      (d) =>
        generatedSummaries[d.id]?.developer &&
        generatedSummaries[d.id]?.marketing &&
        !loadingSummaries[d.id]
    );

  const handleAccordionChange = (values: string[]) => {
    const newlyOpened = values.filter((v) => !openItems.includes(v));
    newlyOpened.forEach((id) => {
      if (!loadingSummaries[id]) {
        const diff = diffs.find((d) => d.id === id);
        if (
          diff &&
          !generatedSummaries[id]?.developer &&
          !generatedSummaries[id]?.marketing
        ) {
          fetchAIGeneratedDiff(diff);
        }
      }
    });
    setOpenItems(values);
  };

  const handleClearStorage = async () => {
    const confirmClear = confirm(
      "This will remove all cached PR data and summaries. Continue?"
    );
    if (!confirmClear) return;
    try {
      await db.diffs.clear();
      setDiffs([]);
      setGeneratedSummaries({});
      setLoadingSummaries({});
      setSummaryErrors({});
      setOpenItems([]);
      setCurrentPage(1);
      setNextPage(null);
      setInitialFetchDone(false);
    } catch (e) {
      console.error("Failed to clear storage", e);
    }
  };

  return (
    <main className="flex min-h-screen flex-col items-center p-12 sm:p-24">
      <div className="fixed top-4 right-4 z-10">
        <ModeToggle />
      </div>
      <h1 className="text-4xl font-bold mb-12">Diff Digest ✍️</h1>

      <div className="w-full max-w-4xl">
        <div className="mb-8 flex flex-wrap gap-4">
          <button
            className="px-4 py-2 bg-primary text-primary-foreground rounded hover:bg-primary/90 transition-colors disabled:opacity-50"
            onClick={handleFetchClick}
            disabled={isLoading}
          >
            {isLoading && currentPage === 1
              ? "Fetching..."
              : "Fetch Latest Diffs"}
          </button>

          {diffs.length > 0 && (
            <button
              className="px-4 py-2 bg-secondary text-secondary-foreground rounded hover:bg-secondary/90 transition-colors disabled:opacity-50"
              onClick={handleGenerateAllClick}
              disabled={isLoading}
            >
              {allGenerated
                ? "Regenerate All Release Notes"
                : "Generate All Release Notes"}
            </button>
          )}

          <button
            className="px-4 py-2 bg-destructive text-destructive-foreground rounded hover:bg-destructive/90 transition-colors"
            onClick={handleClearStorage}
          >
            Clear Stored Data
          </button>
        </div>

        <div className="border rounded-lg p-6 min-h-[300px] bg-muted">
          <h2 className="text-2xl font-semibold mb-4">Merged Pull Requests</h2>

          {error && (
            <div className="text-destructive border border-destructive/50 bg-destructive/10 p-3 rounded mb-4">
              Error: {error}
            </div>
          )}

          {!initialFetchDone && !isLoading && (
            <p className="text-muted-foreground">
              Click the button above to fetch the latest merged pull requests
              from the repository.
            </p>
          )}

          {initialFetchDone && diffs.length === 0 && !isLoading && !error && (
            <p className="text-muted-foreground">
              No merged pull requests found or fetched.
            </p>
          )}

          {diffs.length > 0 && (
            <Accordion
              type="multiple"
              value={openItems}
              onValueChange={handleAccordionChange}
              className="space-y-3"
            >
              {diffs.map((item) => (
                <AccordionItem key={item.id} value={item.id}>
                  <AccordionTrigger>
                    <div className="flex items-center justify-between w-full">
                      <div>
                        <Link
                          href={item.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-primary hover:underline"
                        >
                          PR #{item.id}:
                        </Link>
                        <span className="ml-2">{item.description}</span>
                      </div>
                    </div>
                  </AccordionTrigger>
                  <AccordionContent>
                    <div className="flex justify-end mb-2">
                      <Button
                        aria-label="Regenerate release notes"
                        variant="ghost"
                        size="sm"
                        className="flex gap-2"
                        onClick={() => fetchAIGeneratedDiff(item)}
                        disabled={loadingSummaries[item.id]}
                      >
                        {loadingSummaries[item.id] ? (
                          <Loader2 className="w-4 h-4 animate-spin" />
                        ) : (
                          <SparklesIcon className="w-4 h-4" />
                        )}
                        <span className="text-sm">
                          {loadingSummaries[item.id]
                            ? "Generating..."
                            : "Regenerate"}
                        </span>
                      </Button>
                    </div>
                    {(loadingSummaries[item.id] ||
                      summaryErrors[item.id] ||
                      generatedSummaries[item.id]?.developer ||
                      generatedSummaries[item.id]?.marketing) && (
                      <div className="mt-2 p-4 bg-secondary/20 border border-secondary rounded">
                        <h3 className="font-semibold mb-2">
                          AI Generated Release Notes
                        </h3>
                        <div className="whitespace-pre-wrap space-y-2">
                          {summaryErrors[item.id] && (
                            <div className="flex items-start gap-2 p-3 mb-2 rounded border border-destructive/50 bg-destructive/10 text-destructive">
                              <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
                              <span>{summaryErrors[item.id]}</span>
                            </div>
                          )}
                          <p>
                            <strong>Developer Notes:</strong>{" "}
                            {generatedSummaries[item.id]?.developer ||
                              (loadingSummaries[item.id] &&
                              !summaryErrors[item.id]
                                ? "Generating..."
                                : "")}
                          </p>
                          <p>
                            <strong>Marketing Notes:</strong>{" "}
                            {generatedSummaries[item.id]?.marketing ||
                              (generatedSummaries[item.id]?.developer &&
                              loadingSummaries[item.id] &&
                              !summaryErrors[item.id]
                                ? "Generating..."
                                : "")}
                          </p>
                        </div>
                      </div>
                    )}
                  </AccordionContent>
                </AccordionItem>
              ))}
            </Accordion>
          )}

          {isLoading && currentPage > 1 && (
            <p className="text-muted-foreground mt-4">Loading more...</p>
          )}

          {nextPage && !isLoading && (
            <div className="mt-6">
              <button
                className="px-4 py-2 bg-secondary text-secondary-foreground rounded hover:bg-secondary/90 transition-colors disabled:opacity-50"
                onClick={handleLoadMoreClick}
                disabled={isLoading}
              >
                Load More (Page {nextPage})
              </button>
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
