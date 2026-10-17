export function pageCountForWidth(width, pageWidth) {
  return Math.max(1, Math.ceil((width - 1) / Math.max(1, pageWidth)));
}

export function clampPage(page, count) {
  return Math.min(Math.max(0, Math.trunc(page) || 0), Math.max(0, count - 1));
}

// A visit to the last page unlocks writing only for this opening of the book.
// Newly appended text and returning to earlier pages do not revoke that visit.
export class ReadingGate {
  constructor() {
    this.unlocked = false;
  }
  visit(page, count) {
    if (page === count - 1) this.unlocked = true;
    return this.unlocked;
  }
}

export class PagedText {
  constructor(viewport, content) {
    this.viewport = viewport;
    this.content = content;
    this.page = 0;
    this.count = 1;
    this.width = 1;
  }
  // Read a character's column position without splitting or rewriting the text.
  distanceAt(offset) {
    const node = this.content.firstChild;
    if (!node?.length) return 0;
    const range = document.createRange();
    const start = Math.min(offset, node.length - 1);
    range.setStart(node, start);
    range.setEnd(node, start + 1);
    return (
      this.content.getBoundingClientRect().right -
      range.getBoundingClientRect().right
    );
  }
  anchor() {
    if (this.page === 0) return 0;
    let low = 0,
      high = this.content.textContent.length;
    const distance = this.page * this.width;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      if (this.distanceAt(mid) < distance) low = mid + 1;
      else high = mid;
    }
    return low;
  }
  layout(width, height, anchor = this.anchor()) {
    this.width = width;
    this.viewport.style.width = `${width}px`;
    this.viewport.style.height = `${height}px`;
    this.content.style.height = `${height}px`;
    this.content.style.width = `${width}px`;
    this.count = pageCountForWidth(this.content.scrollWidth, width);
    this.content.style.width = `${this.count * width}px`;
    this.go(Math.floor(Math.max(0, this.distanceAt(anchor)) / width));
  }
  go(page) {
    this.page = clampPage(page, this.count);
    this.viewport.scrollLeft = -this.page * this.width;
  }
}
