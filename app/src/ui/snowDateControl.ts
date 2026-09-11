import type { CatalogueEntry } from "../map/dateCatalogueSchema";

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

/**
 * The AS-OF date display, and the historical date picker when there is one
 * (spec section 5.3).
 *
 * It has always occupied this spot under the search bar as a non-interactive
 * label; it becomes a control only when the catalogue actually offers a choice.
 * With zero or one available date there is nothing to pick, so it stays a
 * label rather than becoming a select with a single option - a control that
 * cannot change anything is a promise the data does not keep.
 *
 * The element is a native `<select>` on purpose. On a phone that gets the
 * platform's own date wheel, real touch targets, and keyboard and screen
 * reader behaviour for free, none of which a hand-rolled popup would have
 * without a great deal of code - and the app has no UI framework yet
 * (spec section 15 item 8), so that code would be ours to maintain.
 *
 * The control stays visible when a date fails to load. That is deliberate: the
 * picker is the only way back to a date that works, so hiding it on failure
 * would strand the user on a broken selection.
 */
export class SnowDateControl {
  readonly element: HTMLElement;

  private entries: CatalogueEntry[] = [];
  private current: string | null = null;
  private notice = "";
  private status: Status = "ready";

  constructor(private readonly onSelect: (entry: CatalogueEntry) => void) {
    this.element = document.createElement("div");
    this.element.className = "snow-date";
    this.element.hidden = true;
  }

  /** The available dates, newest first. Fewer than two means no picker. */
  setCatalogue(entries: CatalogueEntry[]): void {
    this.entries = entries;
    this.render();
  }

  /** The date actually on the map right now, and the manifest's own notice. */
  setCurrent(asOfDate: string | null, notice: string): void {
    this.current = asOfDate;
    this.notice = notice;
    this.status = asOfDate === null ? "failed" : "ready";
    this.render();
  }

  setLoading(): void {
    this.status = "loading";
    this.render();
  }

  private render(): void {
    const interactive = this.entries.length > 1;
    if (!interactive && this.current === null) {
      this.element.hidden = true;
      this.element.replaceChildren();
      return;
    }
    this.element.hidden = false;
    this.element.classList.toggle("snow-date--interactive", interactive);
    this.element.classList.toggle("snow-date--loading", this.status === "loading");
    this.element.classList.toggle("snow-date--failed", this.status === "failed");
    this.element.replaceChildren(interactive ? this.buildSelect() : this.buildLabel());
  }

  private buildLabel(): HTMLElement {
    const label = document.createElement("span");
    label.className = "snow-date__label";
    label.textContent = this.current === null ? "No date" : formatProductDate(this.current);
    label.title = this.notice;
    return label;
  }

  private buildSelect(): HTMLElement {
    const select = document.createElement("select");
    select.className = "snow-date__select";
    select.setAttribute("aria-label", "Snow observation date");
    select.title =
      this.status === "failed"
        ? "That date could not be loaded. Choose another."
        : this.notice;
    select.disabled = this.status === "loading";

    // A date on the map but not in the catalogue means the two published
    // objects disagree - a stale cache, or a publication caught mid-flight.
    // Show it rather than silently relabelling the map, but do not offer it as
    // a choice: the catalogue is the authority on what is available.
    const known = this.entries.some((entry) => entry.asOfDate === this.current);
    if (this.current !== null && !known) {
      const orphan = document.createElement("option");
      orphan.value = "";
      orphan.textContent = formatProductDate(this.current);
      orphan.disabled = true;
      orphan.selected = true;
      select.append(orphan);
    }

    this.entries.forEach((entry, index) => {
      const option = document.createElement("option");
      option.value = entry.asOfDate;
      option.textContent =
        index === 0
          ? `${formatProductDate(entry.asOfDate)} (latest)`
          : formatProductDate(entry.asOfDate);
      option.selected = entry.asOfDate === this.current;
      select.append(option);
    });

    select.addEventListener("change", () => {
      const chosen = this.entries.find((entry) => entry.asOfDate === select.value);
      if (chosen) this.onSelect(chosen);
    });
    return select;
  }
}
