"use client";

import * as React from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

import { BoardCard, type BoardCardData } from "./BoardCard";
import { STAGE_LABELS, type BoardStage } from "@/lib/board-data";
import { Button } from "@/components/ui/button";

export interface BoardColumn {
  stage: BoardStage;
  cards: BoardCardData[];
}

/**
 * Client component: horizontally-scrolling Kanban columns + a lightweight
 * roving-tabindex keyboard nav (arrow keys move focus between cards, Enter
 * opens the focused card via the anchor's native activation -- no custom
 * Enter handling needed, see BoardCard's file comment).
 *
 * Deliberately NOT drag-and-drop: stage is derived from real journal state
 * (lib/board-data.ts), there is no "move this card to change its stage"
 * backend, so a drag interaction here would just be decorative and
 * misleading about what actually changed the run's state.
 */
export function BoardClient({ columns }: { columns: BoardColumn[] }) {
  const containerRef = React.useRef<HTMLDivElement>(null);
  // Only one card overall starts tabbable (tabIndex 0); every other card is
  // -1 until focused, so Tab into the board lands on one sane spot and
  // arrow keys take over from there -- standard roving-tabindex pattern.
  const firstCol = columns.findIndex((c) => c.cards.length > 0);
  const [active, setActive] = React.useState<{ col: number; row: number }>({
    col: firstCol === -1 ? 0 : firstCol,
    row: 0,
  });

  // Right-edge fade affordance: only 3-4 of the (often 7) fixed-width
  // columns fit at common viewport widths, and the row scrolls
  // horizontally with no native scrollbar visible -- so we show a fade
  // whenever there's more content to the right, and hide it once scrolled
  // to the end (or if everything already fits).
  const [showRightFade, setShowRightFade] = React.useState(false);

  const updateFade = React.useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const remaining = el.scrollWidth - el.scrollLeft - el.clientWidth;
    setShowRightFade(remaining > 1);
  }, []);

  React.useEffect(() => {
    updateFade();
    const el = containerRef.current;
    if (!el) return;
    const onScroll = () => updateFade();
    el.addEventListener("scroll", onScroll, { passive: true });
    const onResize = () => updateFade();
    window.addEventListener("resize", onResize);
    return () => {
      el.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onResize);
    };
  }, [updateFade, columns]);

  function focusCard(col: number, row: number) {
    const el = containerRef.current?.querySelector<HTMLAnchorElement>(
      `[data-board-card][data-col="${col}"][data-row="${row}"]`,
    );
    el?.focus();
  }

  function onFocus(e: React.FocusEvent<HTMLDivElement>) {
    const card = (e.target as HTMLElement).closest<HTMLElement>("[data-board-card]");
    if (!card) return;
    const col = Number(card.dataset.col);
    const row = Number(card.dataset.row);
    if (!Number.isNaN(col) && !Number.isNaN(row)) setActive({ col, row });
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    const target = e.target as HTMLElement;
    const card = target.closest<HTMLElement>("[data-board-card]");
    if (!card) return;
    const col = Number(card.dataset.col);
    const row = Number(card.dataset.row);
    if (Number.isNaN(col) || Number.isNaN(row)) return;

    if (e.key === "ArrowDown") {
      e.preventDefault();
      const colCards = columns[col]?.cards.length ?? 0;
      focusCard(col, Math.min(row + 1, colCards - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      focusCard(col, Math.max(row - 1, 0));
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      for (let c = col + 1; c < columns.length; c++) {
        if (columns[c]!.cards.length > 0) {
          focusCard(c, Math.min(row, columns[c]!.cards.length - 1));
          break;
        }
      }
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      for (let c = col - 1; c >= 0; c--) {
        if (columns[c]!.cards.length > 0) {
          focusCard(c, Math.min(row, columns[c]!.cards.length - 1));
          break;
        }
      }
    }
  }

  function scrollBoard(direction: "left" | "right") {
    containerRef.current?.scrollBy({
      left: direction === "right" ? 320 : -320,
      behavior: "smooth",
    });
  }

  return (
    <div className="relative h-full min-h-0 flex-1">
      <div className="mb-2 flex items-center justify-end gap-1">
        <span className="mr-1 hidden text-[11px] text-muted-foreground sm:inline">Scroll stages</span>
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="h-7 w-7"
          onClick={() => scrollBoard("left")}
          aria-label="Scroll pipeline left"
        >
          <ChevronLeft className="h-3.5 w-3.5" />
        </Button>
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="h-7 w-7"
          onClick={() => scrollBoard("right")}
          aria-label="Scroll pipeline right"
        >
          <ChevronRight className="h-3.5 w-3.5" />
        </Button>
      </div>
      <div
        ref={containerRef}
        onKeyDown={onKeyDown}
        onFocus={onFocus}
        className="flex h-[min(48rem,calc(100vh-22rem))] min-h-[18rem] flex-1 gap-3 overflow-x-auto pb-2"
      >
        {columns.map((column, colIndex) => (
          <div key={column.stage} className="flex h-full w-[17rem] shrink-0 flex-col">
            <div className="mb-2 flex shrink-0 items-center justify-between px-1">
              <div className="flex min-w-0 items-center gap-2">
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary/70" />
                <h3 className="truncate text-sm font-semibold text-foreground">{STAGE_LABELS[column.stage]}</h3>
              </div>
              <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                {column.cards.length}
              </span>
            </div>
            <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto pb-4 pr-1">
              {column.cards.length === 0 ? (
                <div className="rounded-lg border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
                  No sessions
                </div>
              ) : (
                column.cards.map((card, rowIndex) => (
                  <BoardCard
                    key={card.runId}
                    data={card}
                    colIndex={colIndex}
                    rowIndex={rowIndex}
                    tabIndex={active.col === colIndex && active.row === rowIndex ? 0 : -1}
                  />
                ))
              )}
            </div>
          </div>
        ))}
      </div>
      {showRightFade && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-y-0 right-0 w-16 bg-gradient-to-l from-surface-base to-transparent"
        />
      )}
    </div>
  );
}
