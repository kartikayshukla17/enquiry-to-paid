/** Minimal RFC 4180 CSV: quoted cells, doubled quotes, CRLF or LF, a leading BOM (Excel / Sheets exports) ignored. */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let touched = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"' && cell === "") {
      quoted = true;
      touched = true;
    } else if (ch === ",") {
      row.push(cell);
      cell = "";
      touched = true;
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      if (touched || cell !== "") row.push(cell);
      if (row.length > 0) rows.push(row);
      row = [];
      cell = "";
      touched = false;
    } else {
      cell += ch;
      touched = true;
    }
  }
  if (touched || cell !== "") row.push(cell);
  if (row.length > 0) rows.push(row);
  return rows;
}

const needsQuote = /[",\r\n]/;
export function toCsv(rows: string[][]): string {
  return rows.map((r) => r.map((c) => (needsQuote.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(",")).join("\n") + "\n";
}
