// Tiny CSV serializer — no dependency. Handles quotes, commas, newlines, BOM for Excel.

function escape(value) {
  if (value === null || value === undefined) return '';
  const str = value instanceof Date ? value.toISOString() : String(value);
  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * Build a CSV string from rows.
 * @param {Array<{key: string, label: string, get?: (row) => any}>} columns
 * @param {Array<object>} rows
 * @returns {string}
 */
function toCsv(columns, rows) {
  const header = columns.map((c) => escape(c.label)).join(',');
  const body = rows.map((row) => columns.map((c) => {
    const value = c.get ? c.get(row) : row[c.key];
    return escape(value);
  }).join(',')).join('\r\n');
  // BOM keeps Excel happy with non-ASCII (e.g. accented African names)
  return '﻿' + header + '\r\n' + body + (body ? '\r\n' : '');
}

function setCsvHeaders(res, filename) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
}

module.exports = { toCsv, setCsvHeaders };
