import { WEEKDAY_LABELS, calendarTitle, calendarWeeks } from "./calendarGrid";
import type { CatalogueEntry } from "./dateCatalogueSchema";

/** Render an AS-OF date the way a reader in the Alps expects to see it. */
export function formatProductDate(iso: string): string {
  const date = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(date.valueOf())
    ? iso
    : date.toLocaleDateString("en-GB", {
        day: "numeric",
        month: "short",
        year: "numeric",
        timeZone: "UTC",
      });
}

type Status = "ready" | "loading" | "failed";

function button(className: string, label: string): HTMLButtonElement {
  const element = document.createElement("button");
  element.type = "button";
  element.className = className;
  element.setAttribute("aria-label", label);
  return element;
}

/**
 * The AS-OF date display, and the historical date picker when there is one
 * (spec section 5.3).
 *
 * It has always occupied this spot under the search bar as a non-interactive
 * label; it becomes a control only when the catalogue actually offers a choice.
 * With zero or one available date there is nothing to pick, so it stays a
 * label rather than becoming a picker with a single stop - a control that
 * cannot change anything is a promise the data does not keep.
 *
 * **Shape: `< 13 Sept 2026 >`, with a calendar behind the date.** This replaced
 * a range slider on 2026-09-13 at the owner's request, as part of moving the
 * whole UI towards fewer, plainer controls. The arrows are the common case -
 * "what did yesterday look like" is one tap, and stepping is precise in a way
 * dragging a 31-stop slider never was - and the calendar is there for the
 * uncommon one, jumping to a particular day. A slider also gave no way to see
 * that a day was *missing*; the calendar shows holes as disabled squares,
 * which matters because the catalogue really does have them when a day's run
 * fails.
 *
 * **The arrows step over available dates, not over calendar days.** Every press
 * lands on something loadable, so the control can never walk into a gap; the
 * calendar is where the gaps are visible, and they are not selectable there
 * either. `calendarGrid.ts` owns that layout and is tested separately.
 *
 * The control stays visible when a date fails to load. That is deliberate: the
 * picker is the only way back to a date that works, so hiding it on failure
 * would strand the user on a broken selection.
 */
export class SnowDateControl {
  readonly element: HTMLElement;

  /** Catalogue entries oldest first, so "next" is forward in time and the
   *  calendar reads left to right. `entries` as handed in by the catalogue
   *  stays newest-first, matching every other consumer of `CatalogueEntry[]`. */
  private chronological: CatalogueEntry[] = [];
  private current: string | null = null;
  private notice = "";
  private status: Status = "ready";
  private calendarOpen = false;

  constructor(private readonly onSelect: (entry: CatalogueEntry) => void) {
    this.element = document.createElement("div");
    this.element.className = "snow-date";
    this.element.hidden = true;

    // Closing on an outside press and on Escape are both expected of anything
    // that behaves like a popup; without them the calendar is a trap on touch,
    // where there is no stray click to dismiss it.
    document.addEventListener("pointerdown", (event) => {
      if (!this.calendarOpen) return;
      if (event.target instanceof Node && this.element.contains(event.target)) return;
      this.closeCalendar();
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && this.calendarOpen) this.closeCalendar();
    });
  }

  /** The available dates, newest first. Fewer than two means no picker. */
  setCatalogue(entries: CatalogueEntry[]): void {
    this.chronological = [...entries].reverse();
    this.render();
  }

  /** The date actually on the map right now, and the manifest's own notice. */
  setCurrent(asOfDate: string | null, notice: string): void {
    this.current = asOfDate;
    this.notice = notice;
    this.status = asOfDate === null ? "failed" : "ready";
    this.calendarOpen = false;
    this.render();
  }

  setLoading(): void {
    this.status = "loading";
    this.calendarOpen = false;
    this.render();
  }

  private closeCalendar(): void {
    this.calendarOpen = false;
    this.render();
  }

  private render(): void {
    const interactive = this.chronological.length > 1;
    if (!interactive && this.current === null) {
      this.element.hidden = true;
      this.element.replaceChildren();
      return;
    }
    this.element.hidden = false;
    this.element.classList.toggle("snow-date--interactive", interactive);
    this.element.classList.toggle("snow-date--loading", this.status === "loading");
    this.element.classList.toggle("snow-date--failed", this.status === "failed");
    this.element.replaceChildren(interactive ? this.buildStepper() : this.buildLabel());
  }

  private buildLabel(): HTMLElement {
    const label = document.createElement("span");
    label.className = "snow-date__label";
    label.textContent = this.current === null ? "No date" : formatProductDate(this.current);
    label.title = this.notice;
    return label;
  }

  /** Index of the current AS-OF date within `chronological`, or the latest
   *  stop when the map's date is not in the catalogue at all (a stale cache,
   *  or a publication caught mid-flight - the catalogue is still the
   *  authority on what is offered, so this never invents an extra stop). */
  private currentIndex(): number {
    if (this.current !== null) {
      const index = this.chronological.findIndex((entry) => entry.asOfDate === this.current);
      if (index !== -1) return index;
    }
    return this.chronological.length - 1;
  }

  private isLatest(entry: CatalogueEntry): boolean {
    return this.chronological[this.chronological.length - 1] === entry;
  }

  private labelFor(entry: CatalogueEntry): string {
    return this.isLatest(entry)
      ? `${formatProductDate(entry.asOfDate)} (latest)`
      : formatProductDate(entry.asOfDate);
  }

  private buildStepper(): HTMLElement {
    const row = document.createElement("div");
    row.className = "snow-date__stepper";

    const index = this.currentIndex();
    const known = this.current !== null && this.chronological.some((e) => e.asOfDate === this.current);
    const entry = this.chronological[index];
    const busy = this.status === "loading";

    const title =
      this.status === "failed"
        ? "That date could not be loaded. Choose another."
        : this.notice;

    const older = this.chronological[index - 1];
    const newer = this.chronological[index + 1];

    const previous = button("snow-date__step", "Previous day");
    previous.textContent = "‹";
    previous.disabled = busy || older === undefined;
    previous.addEventListener("click", () => older && this.onSelect(older));

    const next = button("snow-date__step", "Next day");
    next.textContent = "›";
    next.disabled = busy || newer === undefined;
    next.addEventListener("click", () => newer && this.onSelect(newer));

    const face = button("snow-date__face", "Choose a date");
    face.textContent = this.current !== null && !known ? formatProductDate(this.current) : this.labelFor(entry);
    face.disabled = busy;
    face.title = title;
    face.setAttribute("aria-haspopup", "dialog");
    face.setAttribute("aria-expanded", String(this.calendarOpen));
    face.addEventListener("click", () => {
      this.calendarOpen = !this.calendarOpen;
      this.render();
    });

    row.append(previous, face, next);

    const wrap = document.createElement("div");
    wrap.className = "snow-date__wrap";
    wrap.append(row);
    if (this.calendarOpen) wrap.append(this.buildCalendar());
    return wrap;
  }

  private buildCalendar(): HTMLElement {
    const dates = this.chronological.map((entry) => entry.asOfDate);
    const byDate = new Map(this.chronological.map((entry) => [entry.asOfDate, entry]));

    const popup = document.createElement("div");
    popup.className = "snow-date__calendar";
    popup.setAttribute("role", "dialog");
    popup.setAttribute("aria-label", "Choose a snow observation date");

    const heading = document.createElement("div");
    heading.className = "snow-date__calendar-title";
    heading.textContent = calendarTitle(dates);
    popup.append(heading);

    const grid = document.createElement("div");
    grid.className = "snow-date__grid";

    for (const weekday of WEEKDAY_LABELS) {
      const head = document.createElement("span");
      head.className = "snow-date__weekday";
      head.textContent = weekday;
      head.setAttribute("aria-hidden", "true");
      grid.append(head);
    }

    for (const week of calendarWeeks(dates)) {
      for (const cell of week) {
        if (cell.iso === null) {
          const blank = document.createElement("span");
          blank.className = "snow-date__day snow-date__day--blank";
          grid.append(blank);
          continue;
        }
        const day = button("snow-date__day", formatProductDate(cell.iso));
        day.textContent = String(cell.day);
        day.classList.toggle("snow-date__day--current", cell.iso === this.current);
        day.classList.toggle("snow-date__day--month-start", cell.monthStart);
        if (cell.iso === this.current) day.setAttribute("aria-current", "date");
        if (!cell.available) {
          // Present but not selectable: the day exists in the window and its
          // run did not publish. Saying so is the point - see calendarGrid.ts.
          day.disabled = true;
          day.title = "No snow data published for this date";
          day.setAttribute("aria-label", `${formatProductDate(cell.iso)}, unavailable`);
        } else {
          const entry = byDate.get(cell.iso);
          day.addEventListener("click", () => {
            this.calendarOpen = false;
            if (entry) this.onSelect(entry);
          });
        }
        grid.append(day);
      }
    }

    popup.append(grid);
    return popup;
  }
}
